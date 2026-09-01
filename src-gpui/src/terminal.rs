use std::collections::VecDeque;
use std::sync::Arc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{self, Color, CursorShape, NamedColor};
use chrono::{DateTime, Local};
use parking_lot::Mutex;

use crate::local_pty::PtyWriter;

#[derive(Clone)]
pub struct TerminalEventProxy {
    writer: Arc<Mutex<Option<PtyWriter>>>,
}

impl TerminalEventProxy {
    fn new(writer: Arc<Mutex<Option<PtyWriter>>>) -> Self {
        Self { writer }
    }
}

impl EventListener for TerminalEventProxy {
    fn send_event(&self, event: Event) {
        if let (Event::PtyWrite(text), Some(writer)) = (event, self.writer.lock().as_ref()) {
            writer.write(text.into_bytes());
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalRunStyle {
    pub foreground: Color,
    pub background: Color,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub cursor: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalRun {
    pub text: String,
    pub style: TerminalRunStyle,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TerminalRow {
    pub runs: Vec<TerminalRun>,
    pub gutter: Option<TerminalGutter>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalGutter {
    pub timestamp: String,
    pub line_number: u64,
    pub cursor: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GutterMode {
    Both,
    Line,
    Time,
    Off,
}

impl GutterMode {
    pub fn shows_time(self) -> bool {
        matches!(self, Self::Both | Self::Time)
    }

    pub fn shows_line(self) -> bool {
        matches!(self, Self::Both | Self::Line)
    }
}

impl TerminalRow {
    #[cfg(test)]
    fn plain_text(&self) -> String {
        self.runs.iter().map(|run| run.text.as_str()).collect()
    }
}

#[derive(Clone, Copy)]
struct TerminalSize {
    cols: usize,
    rows: usize,
}

impl Dimensions for TerminalSize {
    fn total_lines(&self) -> usize {
        self.rows
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct TerminalModel {
    term: Term<TerminalEventProxy>,
    parser: ansi::Processor,
    metadata_parser: ansi::Processor,
    size: TerminalSize,
    writer: Arc<Mutex<Option<PtyWriter>>>,
    line_times: VecDeque<Option<DateTime<Local>>>,
    first_line_number: u64,
}

#[derive(Default)]
struct MetadataProbe {
    line_feed: bool,
    clear_screen: Option<ansi::ClearMode>,
    reset_state: bool,
}

impl ansi::Handler for MetadataProbe {
    fn linefeed(&mut self) {
        self.line_feed = true;
    }

    fn clear_screen(&mut self, mode: ansi::ClearMode) {
        if matches!(mode, ansi::ClearMode::All | ansi::ClearMode::Saved) {
            self.clear_screen = Some(mode);
        }
    }

    fn reset_state(&mut self) {
        self.reset_state = true;
    }
}

impl TerminalModel {
    pub fn new(cols: usize, rows: usize, writer: Option<PtyWriter>) -> Self {
        Self::with_config(cols, rows, writer, Config::default())
    }

    fn with_config(cols: usize, rows: usize, writer: Option<PtyWriter>, config: Config) -> Self {
        let size = TerminalSize { cols, rows };
        let writer = Arc::new(Mutex::new(writer));
        Self {
            term: Term::new(config, &size, TerminalEventProxy::new(writer.clone())),
            parser: ansi::Processor::new(),
            metadata_parser: ansi::Processor::new(),
            size,
            writer,
            line_times: VecDeque::from([Some(Local::now())]),
            first_line_number: 1,
        }
    }

    pub fn set_writer(&mut self, writer: Option<PtyWriter>) {
        *self.writer.lock() = writer;
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        let now = Local::now();
        let mut start = 0;
        for (index, byte) in bytes.iter().enumerate() {
            let mut probe = MetadataProbe::default();
            self.metadata_parser
                .advance(&mut probe, std::slice::from_ref(byte));
            if !probe.line_feed && probe.clear_screen.is_none() && !probe.reset_state {
                continue;
            }

            self.advance(&bytes[start..=index]);
            if probe.reset_state {
                self.reset_line_metadata(now);
            } else if let Some(mode) = probe.clear_screen {
                self.clear_screen_metadata(mode, now);
            } else if probe.line_feed {
                self.record_line(now);
            }
            start = index + 1;
        }
        if start < bytes.len() {
            self.advance(&bytes[start..]);
        }
        self.record_written_cursor_line(now);
    }

    pub fn resize(&mut self, cols: usize, rows: usize) {
        self.size = TerminalSize { cols, rows };
        self.term.resize(self.size);
    }

    pub fn columns(&self) -> usize {
        self.size.cols
    }

    pub fn screen_lines(&self) -> usize {
        self.size.rows
    }

    pub fn bracketed_paste(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    pub fn scroll(&mut self, lines: i32) {
        self.term.scroll_display(Scroll::Delta(lines));
    }

    pub fn clear(&mut self) {
        // RIS resets the emulator state and clears both the viewport and scrollback without
        // sending anything to the child process.
        self.feed(b"\x1bc");
    }

    fn advance(&mut self, bytes: &[u8]) {
        let was_alternate = self.term.mode().contains(TermMode::ALT_SCREEN);
        let old_history = self.term.history_size();
        let old_top = (!was_alternate && old_history > 0).then(|| self.top_row_address());
        self.parser.advance(&mut self.term, bytes);

        let alternate = self.term.mode().contains(TermMode::ALT_SCREEN);
        let history = self.term.history_size();
        if was_alternate || alternate || history != old_history || history == 0 {
            return;
        }

        // At a full scrollback limit, a linefeed rotates the oldest row out while the
        // history length stays constant. Alacritty's ring keeps row allocations stable,
        // so a changed top-row address identifies exactly that rotation without scanning
        // or hashing the whole buffer.
        if old_top.is_some_and(|address| address != self.top_row_address()) {
            self.line_times.pop_front();
            self.first_line_number = self.first_line_number.saturating_add(1);
        }
    }

    fn top_row_address(&self) -> usize {
        let line = self.term.grid().topmost_line();
        self.term.grid()[line][..].as_ptr() as usize
    }

    fn record_line(&mut self, now: DateTime<Local>) {
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            return;
        }
        let index = self.term.history_size() + self.term.grid().cursor.point.line.0 as usize;
        while self.line_times.len() <= index {
            self.line_times.push_back(Some(now));
        }
        self.line_times[index] = Some(now);
    }

    fn record_written_cursor_line(&mut self, now: DateTime<Local>) {
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            return;
        }
        let line = self.term.grid().cursor.point.line;
        if self.term.grid()[line].is_clear() {
            return;
        }
        let index = self.term.history_size() + line.0 as usize;
        while self.line_times.len() <= index {
            self.line_times.push_back(None);
        }
        self.line_times[index].get_or_insert(now);
    }

    fn reset_line_metadata(&mut self, now: DateTime<Local>) {
        self.line_times = VecDeque::from([Some(now)]);
        self.first_line_number = 1;
    }

    fn clear_screen_metadata(&mut self, mode: ansi::ClearMode, now: DateTime<Local>) {
        // Full-screen applications clear their alternate buffer frequently. That must not
        // destroy the timestamps belonging to the normal shell buffer.
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            return;
        }

        // EdgeTerm's Tauri terminal treats ED 2 (clear viewport) as Clear Buffer: xterm's
        // public clear() also drops saved history. Alacritty implements ED 2 and ED 3
        // separately, so complete the operation with ED 3 before resetting the parallel
        // metadata. ED 3 itself has already cleared history when it reaches this method.
        if matches!(mode, ansi::ClearMode::All) {
            self.parser.advance(&mut self.term, b"\x1b[3J");
        }
        self.reset_line_metadata(now);
    }

    pub fn rows(&self) -> Vec<TerminalRow> {
        let content = self.term.renderable_content();
        let alternate = content.mode.contains(TermMode::ALT_SCREEN);
        let display_offset = content.display_offset;
        let history_size = self.term.history_size();
        let cursor_visible = content.mode.contains(TermMode::SHOW_CURSOR)
            && content.cursor.shape != CursorShape::Hidden;
        let columns = self.size.cols;
        let mut cells = vec![Vec::with_capacity(columns); self.size.rows];
        let mut cursor_rows = vec![false; self.size.rows];

        for (index, cell) in content.display_iter.enumerate() {
            let row = index / columns;
            if row >= cells.len() {
                break;
            }

            if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                continue;
            }

            let is_cursor = cursor_visible && cell.point == content.cursor.point;
            cursor_rows[row] |= is_cursor;
            let mut foreground = cell.fg;
            let mut background = cell.bg;
            if cell.flags.contains(Flags::INVERSE) || is_cursor {
                std::mem::swap(&mut foreground, &mut background);
            }

            let bold = cell.flags.contains(Flags::BOLD);
            let dim = cell.flags.contains(Flags::DIM);
            foreground = adjust_named_color(foreground, bold, dim);

            let mut character = if cell.flags.contains(Flags::HIDDEN) {
                ' '
            } else {
                cell.c
            }
            .to_string();
            if let Some(zerowidth) = cell.zerowidth() {
                character.extend(zerowidth);
            }

            cells[row].push((
                character,
                TerminalRunStyle {
                    foreground,
                    background,
                    bold,
                    italic: cell.flags.contains(Flags::ITALIC),
                    underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
                    cursor: is_cursor,
                },
            ));
        }

        cells
            .into_iter()
            .enumerate()
            .map(|(row_index, mut cells)| {
                while cells.last().is_some_and(|(text, style)| {
                    text == " "
                        && style.foreground == Color::Named(NamedColor::Foreground)
                        && style.background == Color::Named(NamedColor::Background)
                        && !style.cursor
                }) {
                    cells.pop();
                }

                let buffer_index =
                    history_size as isize + row_index as isize - display_offset as isize;
                let gutter = (!alternate && buffer_index >= 0)
                    .then(|| {
                        let buffer_index = buffer_index as usize;
                        self.line_times
                            .get(buffer_index)
                            .and_then(Option::as_ref)
                            .map(|time| TerminalGutter {
                                timestamp: format!("[{}]", time.format("%H:%M:%S%.3f")),
                                line_number: self.first_line_number + buffer_index as u64,
                                cursor: cursor_rows[row_index],
                            })
                    })
                    .flatten();
                let mut row = TerminalRow {
                    runs: Vec::new(),
                    gutter,
                };
                for (text, style) in cells {
                    if let Some(run) = row.runs.last_mut()
                        && run.style == style
                    {
                        run.text.push_str(&text);
                    } else {
                        row.runs.push(TerminalRun { text, style });
                    }
                }
                row
            })
            .collect()
    }
}

fn adjust_named_color(color: Color, bold: bool, dim: bool) -> Color {
    match color {
        Color::Named(named) if bold => Color::Named(named.to_bright()),
        Color::Named(named) if dim => Color::Named(named.to_dim()),
        color => color,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_numbers(terminal: &TerminalModel) -> Vec<Option<u64>> {
        terminal
            .rows()
            .into_iter()
            .map(|row| row.gutter.map(|gutter| gutter.line_number))
            .collect()
    }

    #[test]
    fn parses_cursor_movement_instead_of_printing_escape_sequences() {
        let mut terminal = TerminalModel::new(10, 2, None);
        terminal.feed(b"abc\rZ");

        assert!(terminal.rows()[0].plain_text().starts_with("Zbc"));
    }

    #[test]
    fn preserves_ansi_foreground_colors() {
        let mut terminal = TerminalModel::new(10, 2, None);
        terminal.feed(b"\x1b[31mred\x1b[0m");

        let row = &terminal.rows()[0];
        assert_eq!(row.runs[0].text, "red");
        assert_eq!(row.runs[0].style.foreground, Color::Named(NamedColor::Red));
    }

    #[test]
    fn gutter_only_labels_lines_that_have_been_produced() {
        let mut terminal = TerminalModel::new(10, 3, None);

        assert_eq!(line_numbers(&terminal), vec![Some(1), None, None]);
        terminal.feed(b"first\r\nsecond");

        let rows = terminal.rows();
        assert_eq!(rows[0].gutter.as_ref().unwrap().line_number, 1);
        assert_eq!(rows[1].gutter.as_ref().unwrap().line_number, 2);
        assert!(rows[2].gutter.is_none());
        assert!(rows[0].gutter.as_ref().unwrap().timestamp.starts_with('['));
        assert!(rows[0].gutter.as_ref().unwrap().timestamp.ends_with(']'));
    }

    #[test]
    fn gutter_follows_the_viewport_and_keeps_absolute_line_numbers() {
        let mut terminal = TerminalModel::new(10, 2, None);
        terminal.feed(b"one\r\ntwo\r\nthree");

        assert_eq!(line_numbers(&terminal), vec![Some(2), Some(3)]);
        terminal.scroll(1);
        assert_eq!(line_numbers(&terminal), vec![Some(1), Some(2)]);
    }

    #[test]
    fn gutter_advances_after_the_scrollback_limit_discards_a_line() {
        let config = Config {
            scrolling_history: 2,
            ..Config::default()
        };
        let mut terminal = TerminalModel::with_config(10, 2, None, config);
        terminal.feed(b"1\r\n2\r\n3\r\n4\r\n5");

        assert_eq!(terminal.first_line_number, 2);
        assert_eq!(terminal.line_times.len(), 4);
        assert_eq!(line_numbers(&terminal), vec![Some(4), Some(5)]);
        terminal.scroll(2);
        assert_eq!(line_numbers(&terminal), vec![Some(2), Some(3)]);
    }

    #[test]
    fn alternate_screen_has_no_line_or_timestamp_gutter() {
        let mut terminal = TerminalModel::new(10, 2, None);
        terminal.feed(b"shell");
        terminal.feed(b"\x1b[?1049hfull screen\x1b[2J");

        assert!(terminal.rows().iter().all(|row| row.gutter.is_none()));
        terminal.feed(b"\x1b[?1049l");
        assert_eq!(line_numbers(&terminal), vec![Some(1), None]);
        assert!(terminal.rows()[0].plain_text().starts_with("shell"));
    }

    #[test]
    fn clear_screen_resets_history_and_line_numbers() {
        let mut terminal = TerminalModel::new(10, 2, None);
        terminal.feed(b"one\r\ntwo\r\nthree");
        terminal.feed(b"\x1b[2J\x1b[Hfresh");

        let rows = terminal.rows();
        assert_eq!(terminal.term.history_size(), 0);
        assert_eq!(line_numbers(&terminal), vec![Some(1), None]);
        assert!(rows[0].plain_text().starts_with("fresh"));
    }
}
