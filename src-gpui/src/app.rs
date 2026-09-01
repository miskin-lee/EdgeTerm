use std::path::{Path, PathBuf};
use std::time::Duration;

use alacritty_terminal::vte::ansi::{Color, NamedColor};
use gpui::{
    App, ClickEvent, Context, CursorStyle, Div, FocusHandle, Focusable, FontWeight, Hsla,
    IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, ParentElement, Render,
    ScrollWheelEvent, Stateful, Styled, Timer, Window, div, prelude::*, px, rgb, rgba, svg,
};

use crate::local_pty::{LocalPty, PtyEvent, PtyWriter};
use crate::model::{AuthKind, SessionKind, SessionProfile};
use crate::store::Store;
use crate::terminal::{GutterMode, TerminalGutter, TerminalModel, TerminalRun};
use crate::theme::{Theme, ThemeMode};

const UI_FONT: &str = ".SystemUIFont";
const MONO_FONT: &str = "JetBrains Mono";
const TERMINAL_COLUMNS: usize = 80;
const TERMINAL_ROWS: usize = 24;
const MENU_BAR_HEIGHT: f32 = 28.0;
const PANEL_HEADER_HEIGHT: f32 = 26.0;
const SESSION_PANEL_WIDTH: f32 = 220.0;
const FILER_PANEL_WIDTH: f32 = 220.0;
const SPLITTER_SIZE: f32 = 4.0;
const TAB_STRIP_HEIGHT: f32 = 30.0;
const SENDER_HEIGHT: f32 = 160.0;
const STATUS_BAR_HEIGHT: f32 = 24.0;
const TERMINAL_ROW_HEIGHT: f32 = 21.0;

#[derive(Clone)]
struct LocalEntry {
    path: PathBuf,
    name: String,
    is_dir: bool,
    detail: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActiveMenu {
    Session,
    Edit,
    Search,
    View,
    Help,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SenderMode {
    Text,
    Hex,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SenderEnding {
    None,
    Lf,
    Cr,
    CrLf,
}

impl SenderEnding {
    fn label(self) -> &'static str {
        match self {
            Self::None => "No ending",
            Self::Lf => "LF  \\n",
            Self::Cr => "CR  \\r",
            Self::CrLf => "CRLF  \\r\\n",
        }
    }

    fn next(self) -> Self {
        match self {
            Self::None => Self::Lf,
            Self::Lf => Self::Cr,
            Self::Cr => Self::CrLf,
            Self::CrLf => Self::None,
        }
    }

    fn bytes(self) -> &'static [u8] {
        match self {
            Self::None => b"",
            Self::Lf => b"\n",
            Self::Cr => b"\r",
            Self::CrLf => b"\r\n",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FieldAction {
    None,
    Changed,
    Submit,
    Escape,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileField {
    Name,
    Host,
    Port,
    Username,
    Password,
    PrivateKey,
    Passphrase,
    Shell,
    Cwd,
    SerialPort,
    BaudRate,
}

impl ProfileField {
    fn id(self) -> usize {
        self as usize
    }
}

struct ProfileDialogState {
    profile: SessionProfile,
    active_field: ProfileField,
    select_all: bool,
    error: Option<String>,
    confirm_delete: bool,
}

struct SessionTab {
    id: String,
    number: usize,
    ordinal: usize,
    profile: Option<SessionProfile>,
    name: String,
    terminal: TerminalModel,
    pty: Option<LocalPty>,
    pty_writer: Option<PtyWriter>,
    connection_generation: u64,
    state: String,
}

impl SessionTab {
    fn profile_id(&self) -> Option<&str> {
        self.profile
            .as_ref()
            .filter(|profile| !profile.id.is_empty())
            .map(|profile| profile.id.as_str())
    }

    fn title(&self) -> String {
        if self.ordinal == 0 {
            self.name.clone()
        } else {
            format!("{} ({})", self.name, self.ordinal)
        }
    }

    fn connected(&self) -> bool {
        self.pty.is_some()
    }
}

pub struct EdgeTermApp {
    store: Store,
    profiles: Vec<SessionProfile>,
    theme_mode: ThemeMode,
    gutter_mode: GutterMode,
    clock: String,
    active_menu: Option<ActiveMenu>,
    show_sessions: bool,
    show_filer: bool,
    show_sender: bool,
    terminal_focus: FocusHandle,
    tabs: Vec<SessionTab>,
    active_tab_id: String,
    next_connection_generation: u64,
    filter_focus: FocusHandle,
    session_filter: String,
    filter_select_all: bool,
    filer_focus: FocusHandle,
    filer_path: PathBuf,
    filer_path_value: String,
    filer_entries: Vec<LocalEntry>,
    filer_error: Option<String>,
    filer_history: Vec<PathBuf>,
    filer_history_index: usize,
    selected_filer_path: Option<PathBuf>,
    filer_select_all: bool,
    sender_focus: FocusHandle,
    sender_value: String,
    sender_select_all: bool,
    sender_mode: SenderMode,
    sender_ending: SenderEnding,
    profile_dialog_focus: FocusHandle,
    profile_dialog: Option<ProfileDialogState>,
}

impl EdgeTermApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let terminal_focus = cx.focus_handle();
        terminal_focus.focus(window);
        let initial_path = default_filer_path();
        let (filer_path, filer_entries, filer_error) = read_local_directory(&initial_path);
        let filer_path_value = filer_path.to_string_lossy().into_owned();
        let store = Store::load();
        let profiles = store.list();
        let mut app = Self {
            store,
            profiles,
            theme_mode: ThemeMode::Dark,
            gutter_mode: GutterMode::Both,
            clock: status_clock(),
            active_menu: None,
            show_sessions: true,
            show_filer: true,
            show_sender: true,
            terminal_focus,
            tabs: Vec::new(),
            active_tab_id: String::new(),
            next_connection_generation: 0,
            filter_focus: cx.focus_handle(),
            session_filter: String::new(),
            filter_select_all: false,
            filer_focus: cx.focus_handle(),
            filer_path: filer_path.clone(),
            filer_path_value,
            filer_entries,
            filer_error,
            filer_history: vec![filer_path],
            filer_history_index: 0,
            selected_filer_path: None,
            filer_select_all: false,
            sender_focus: cx.focus_handle(),
            sender_value: String::new(),
            sender_select_all: false,
            sender_mode: SenderMode::Text,
            sender_ending: SenderEnding::Lf,
            profile_dialog_focus: cx.focus_handle(),
            profile_dialog: None,
        };
        app.open_local_tab(None, cx);
        app.start_clock(cx);
        app
    }

    fn start_clock(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                Timer::after(Duration::from_secs(1)).await;
                if this
                    .update(cx, |this, cx| {
                        let clock = status_clock();
                        if this.clock != clock {
                            this.clock = clock;
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn open_new_profile(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let color = PROFILE_COLORS[self.profiles.len() % PROFILE_COLORS.len()];
        self.profile_dialog = Some(ProfileDialogState {
            profile: blank_profile(color),
            active_field: ProfileField::Name,
            select_all: false,
            error: None,
            confirm_delete: false,
        });
        self.active_menu = None;
        self.profile_dialog_focus.focus(window);
        cx.notify();
    }

    fn open_profile_editor(
        &mut self,
        profile_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self.store.get(profile_id) {
            Ok(Some(profile)) => {
                self.profile_dialog = Some(ProfileDialogState {
                    profile,
                    active_field: ProfileField::Name,
                    select_all: false,
                    error: None,
                    confirm_delete: false,
                });
                self.profile_dialog_focus.focus(window);
            }
            Ok(None) => self.set_session_state("That saved session no longer exists"),
            Err(error) => self.set_session_state(format!("Could not load session: {error}")),
        }
        self.active_menu = None;
        cx.notify();
    }

    fn close_profile_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.profile_dialog = None;
        self.terminal_focus.focus(window);
        cx.notify();
    }

    fn save_profile_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(dialog) = self.profile_dialog.as_mut() else {
            return;
        };
        let mut profile = dialog.profile.clone();
        profile.name = profile.name.trim().to_string();
        if profile.name.is_empty() {
            profile.name = default_profile_name(&profile);
        }
        if matches!(
            profile.kind,
            SessionKind::Ssh | SessionKind::Sftp | SessionKind::Ftp
        ) && profile.host.as_deref().is_none_or(str::is_empty)
        {
            dialog.error = Some("Host is required for a remote session".into());
            cx.notify();
            return;
        }
        if profile.kind == SessionKind::Serial
            && profile.port_name.as_deref().is_none_or(str::is_empty)
        {
            dialog.error = Some("Serial port is required".into());
            cx.notify();
            return;
        }
        match self.store.save(profile) {
            Ok(saved) => {
                self.profiles = self.store.list();
                self.set_session_state(format!("Saved session: {}", saved.name));
                self.profile_dialog = None;
                self.terminal_focus.focus(window);
            }
            Err(error) => dialog.error = Some(error.to_string()),
        }
        cx.notify();
    }

    fn delete_profile_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(dialog) = self.profile_dialog.as_ref() else {
            return;
        };
        if dialog.profile.id.is_empty() {
            self.close_profile_dialog(window, cx);
            return;
        }
        let id = dialog.profile.id.clone();
        let name = dialog.profile.name.clone();
        match self.store.delete(&id) {
            Ok(()) => {
                self.profiles = self.store.list();
                self.set_session_state(format!("Deleted saved session: {name}"));
                self.profile_dialog = None;
                self.terminal_focus.focus(window);
            }
            Err(error) => {
                if let Some(dialog) = self.profile_dialog.as_mut() {
                    dialog.error = Some(error.to_string());
                    dialog.confirm_delete = false;
                }
            }
        }
        cx.notify();
    }

    fn set_profile_kind(&mut self, kind: SessionKind, cx: &mut Context<Self>) {
        let Some(dialog) = self.profile_dialog.as_mut() else {
            return;
        };
        let previous = dialog.profile.kind;
        dialog.profile.kind = kind;
        dialog.profile.group_id = None;
        dialog.profile.jump_profile_id = None;
        match kind {
            SessionKind::Ssh | SessionKind::Sftp => {
                if !matches!(previous, SessionKind::Ssh | SessionKind::Sftp)
                    || dialog.profile.port.is_none()
                {
                    dialog.profile.port = Some(22);
                }
                dialog.profile.auth.get_or_insert(AuthKind::Password);
                dialog.active_field = ProfileField::Host;
            }
            SessionKind::Ftp => {
                if previous != SessionKind::Ftp || dialog.profile.port.is_none() {
                    dialog.profile.port = Some(21);
                }
                dialog.active_field = ProfileField::Host;
            }
            SessionKind::Local => dialog.active_field = ProfileField::Name,
            SessionKind::Serial => {
                dialog.profile.baud_rate.get_or_insert(115_200);
                dialog.profile.data_bits.get_or_insert(8);
                dialog.profile.stop_bits.get_or_insert(1);
                dialog.profile.parity.get_or_insert_with(|| "none".into());
                dialog
                    .profile
                    .flow_control
                    .get_or_insert_with(|| "none".into());
                dialog.active_field = ProfileField::SerialPort;
            }
        }
        dialog.select_all = true;
        dialog.error = None;
        dialog.confirm_delete = false;
        cx.notify();
    }

    fn cycle_profile_auth(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.profile_dialog.as_mut() else {
            return;
        };
        dialog.profile.auth = Some(match dialog.profile.auth.unwrap_or_default() {
            AuthKind::Password => AuthKind::PublicKey,
            AuthKind::PublicKey => AuthKind::Agent,
            AuthKind::Agent => AuthKind::Password,
        });
        dialog.error = None;
        cx.notify();
    }

    fn cycle_profile_parity(&mut self, cx: &mut Context<Self>) {
        if let Some(dialog) = self.profile_dialog.as_mut() {
            dialog.profile.parity = Some(
                match dialog.profile.parity.as_deref().unwrap_or("none") {
                    "none" => "odd",
                    "odd" => "even",
                    _ => "none",
                }
                .into(),
            );
            cx.notify();
        }
    }

    fn cycle_profile_flow_control(&mut self, cx: &mut Context<Self>) {
        if let Some(dialog) = self.profile_dialog.as_mut() {
            dialog.profile.flow_control = Some(
                match dialog.profile.flow_control.as_deref().unwrap_or("none") {
                    "none" => "software",
                    "software" => "hardware",
                    _ => "none",
                }
                .into(),
            );
            cx.notify();
        }
    }

    fn on_profile_dialog_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if event.keystroke.key == "tab" {
            if let Some(dialog) = self.profile_dialog.as_mut() {
                let fields = profile_fields(&dialog.profile);
                if let Some(index) = fields
                    .iter()
                    .position(|field| *field == dialog.active_field)
                {
                    let step = if event.keystroke.modifiers.shift {
                        fields.len() - 1
                    } else {
                        1
                    };
                    dialog.active_field = fields[(index + step) % fields.len()];
                    dialog.select_all = true;
                }
            }
            cx.stop_propagation();
            cx.notify();
            return;
        }

        let mut close = false;
        if let Some(dialog) = self.profile_dialog.as_mut() {
            let field = dialog.active_field;
            let mut value = profile_field_value(&dialog.profile, field);
            match Self::edit_field(&mut value, &mut dialog.select_all, event, cx) {
                FieldAction::Changed => {
                    set_profile_field_value(&mut dialog.profile, field, value);
                    dialog.error = None;
                    dialog.confirm_delete = false;
                }
                FieldAction::Escape => close = true,
                FieldAction::Submit | FieldAction::None => {}
            }
        }
        if close {
            self.close_profile_dialog(window, cx);
        } else {
            cx.notify();
        }
    }

    fn active_tab(&self) -> &SessionTab {
        self.tabs
            .iter()
            .find(|tab| tab.id == self.active_tab_id)
            .expect("EdgeTerm always keeps one local tab")
    }

    fn active_tab_mut(&mut self) -> &mut SessionTab {
        self.tabs
            .iter_mut()
            .find(|tab| tab.id == self.active_tab_id)
            .expect("EdgeTerm always keeps one local tab")
    }

    fn set_session_state(&mut self, state: impl Into<String>) {
        self.active_tab_mut().state = state.into();
    }

    fn open_local_tab(&mut self, profile: Option<SessionProfile>, cx: &mut Context<Self>) {
        let name = profile
            .as_ref()
            .map(|profile| profile.name.clone())
            .unwrap_or_else(|| "Local Shell".into());
        let profile_id = profile
            .as_ref()
            .filter(|profile| !profile.id.is_empty())
            .map(|profile| profile.id.as_str());
        let number = next_tab_number(&self.tabs);
        let ordinal = next_tab_ordinal(&self.tabs, profile_id, &name);
        let id = uuid::Uuid::new_v4().to_string();
        self.tabs.push(SessionTab {
            id: id.clone(),
            number,
            ordinal,
            profile,
            name: name.clone(),
            terminal: TerminalModel::new(TERMINAL_COLUMNS, TERMINAL_ROWS, None),
            pty: None,
            pty_writer: None,
            connection_generation: 0,
            state: format!("Starting {name}…"),
        });
        self.active_tab_id = id.clone();
        self.connect_local_tab(&id, cx);
    }

    fn connect_local_tab(&mut self, tab_id: &str, cx: &mut Context<Self>) {
        self.next_connection_generation = self.next_connection_generation.wrapping_add(1);
        let generation = self.next_connection_generation;
        let Some(tab) = self.tabs.iter_mut().find(|tab| tab.id == tab_id) else {
            return;
        };
        tab.connection_generation = generation;
        tab.pty.take();
        tab.pty_writer = None;
        tab.terminal.set_writer(None);
        tab.state = format!("Connecting to {}…", tab.title());
        let command_line = tab
            .profile
            .as_ref()
            .and_then(|profile| profile.shell.as_deref());
        let cwd = tab
            .profile
            .as_ref()
            .and_then(|profile| profile.cwd.as_deref());
        let cols = tab.terminal.columns().min(u16::MAX as usize) as u16;
        let rows = tab.terminal.screen_lines().min(u16::MAX as usize) as u16;
        let name = tab.title();

        match LocalPty::spawn_command(cols, rows, command_line, cwd) {
            Ok((pty, events)) => {
                let writer = pty.writer();
                tab.terminal.set_writer(Some(writer.clone()));
                tab.pty = Some(pty);
                tab.pty_writer = Some(writer);
                tab.state = format!("Connected to {name}");
                let tab_id = tab_id.to_owned();
                cx.spawn(async move |this, cx| {
                    while let Ok(event) = events.recv().await {
                        if this
                            .update(cx, |this, cx| {
                                let Some(tab) = this.tabs.iter_mut().find(|tab| tab.id == tab_id)
                                else {
                                    return;
                                };
                                if tab.connection_generation != generation {
                                    return;
                                }
                                let notify = match event {
                                    PtyEvent::Output(bytes) => {
                                        tab.terminal.feed(&bytes);
                                        tab.id == this.active_tab_id
                                    }
                                    PtyEvent::Closed => {
                                        tab.terminal.set_writer(None);
                                        tab.pty = None;
                                        tab.pty_writer = None;
                                        tab.state = format!("{} disconnected", tab.title());
                                        true
                                    }
                                    PtyEvent::Error(error) => {
                                        tab.terminal.feed(
                                            format!("\r\n\x1b[31mEdgeTerm: {error}\x1b[0m\r\n")
                                                .as_bytes(),
                                        );
                                        tab.state = format!("{} error", tab.title());
                                        true
                                    }
                                };
                                if notify {
                                    cx.notify();
                                }
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                })
                .detach();
            }
            Err(error) => {
                tab.terminal
                    .feed(format!("\x1b[31mEdgeTerm: {error}\x1b[0m\r\n").as_bytes());
                tab.state = format!("Failed to start {name}");
            }
        }
        cx.notify();
    }

    fn activate_saved_profile(
        &mut self,
        profile_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self.store.get(profile_id) {
            Ok(Some(profile)) if profile.kind == SessionKind::Local => {
                self.open_local_tab(Some(profile), cx);
                self.terminal_focus.focus(window);
            }
            Ok(Some(profile)) => {
                self.set_session_state(format!(
                    "{} profile is ready; {} transport is the next migration slice",
                    profile.name,
                    profile.protocol().to_uppercase()
                ));
                cx.notify();
            }
            Ok(None) => {
                self.set_session_state("That saved session no longer exists");
                cx.notify();
            }
            Err(error) => {
                self.set_session_state(format!("Could not load session: {error}"));
                cx.notify();
            }
        }
    }

    fn disconnect_active_local(&mut self, cx: &mut Context<Self>) {
        self.next_connection_generation = self.next_connection_generation.wrapping_add(1);
        let generation = self.next_connection_generation;
        let tab = self.active_tab_mut();
        tab.connection_generation = generation;
        tab.terminal.set_writer(None);
        tab.pty.take();
        tab.pty_writer = None;
        tab.state = format!("{} disconnected", tab.title());
        self.active_menu = None;
        cx.notify();
    }

    fn restart_active_local(&mut self, cx: &mut Context<Self>) {
        let tab_id = self.active_tab_id.clone();
        self.connect_local_tab(&tab_id, cx);
    }

    fn activate_tab(&mut self, tab_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.tabs.iter().any(|tab| tab.id == tab_id) {
            self.active_tab_id = tab_id.to_owned();
            self.active_menu = None;
            self.terminal_focus.focus(window);
            cx.notify();
        }
    }

    fn close_tab(&mut self, tab_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.tabs.len() == 1 {
            self.disconnect_active_local(cx);
            return;
        }
        let Some(index) = self.tabs.iter().position(|tab| tab.id == tab_id) else {
            return;
        };
        let was_active = self.active_tab_id == tab_id;
        self.tabs.remove(index);
        if was_active {
            let next = index.min(self.tabs.len() - 1);
            self.active_tab_id = self.tabs[next].id.clone();
            self.terminal_focus.focus(window);
        }
        cx.notify();
    }

    fn focus_terminal(&mut self, _: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.active_menu = None;
        self.terminal_focus.focus(window);
        cx.notify();
    }

    fn on_terminal_key_down(
        &mut self,
        event: &KeyDownEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if is_paste_keystroke(event) {
            self.paste_into_terminal(cx);
            cx.stop_propagation();
            return;
        }
        if let Some(bytes) = terminal_key_bytes(event) {
            self.write_to_pty(bytes);
            cx.stop_propagation();
        }
    }

    fn on_terminal_scroll(
        &mut self,
        event: &ScrollWheelEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let pixels = f32::from(event.delta.pixel_delta(px(21.0)).y);
        let mut lines = (pixels / 21.0).round() as i32;
        if lines == 0 && pixels != 0.0 {
            lines = pixels.signum() as i32;
        }
        if lines != 0 {
            self.active_tab_mut().terminal.scroll(lines);
            cx.notify();
            cx.stop_propagation();
        }
    }

    fn write_to_pty(&self, bytes: Vec<u8>) {
        if let Some(writer) = &self.active_tab().pty_writer {
            writer.write(bytes);
        }
    }

    fn paste_into_terminal(&self, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let bytes = if self.active_tab().terminal.bracketed_paste() {
                format!("\x1b[200~{text}\x1b[201~").into_bytes()
            } else {
                text.into_bytes()
            };
            self.write_to_pty(bytes);
        }
    }

    fn clear_terminal(&mut self, cx: &mut Context<Self>) {
        let tab = self.active_tab_mut();
        tab.terminal.clear();
        tab.state = "Terminal buffer cleared".into();
        self.active_menu = None;
        cx.notify();
    }

    fn sync_terminal_size(&mut self, window: &Window) {
        let window_size = window.bounds().size;
        let side_width = if self.show_sessions {
            SESSION_PANEL_WIDTH + SPLITTER_SIZE
        } else {
            0.0
        } + if self.show_filer {
            FILER_PANEL_WIDTH + SPLITTER_SIZE
        } else {
            0.0
        };
        let sender_height = if self.show_sender {
            SENDER_HEIGHT + SPLITTER_SIZE
        } else {
            0.0
        };
        let terminal_width = (f32::from(window_size.width)
            - side_width
            - terminal_gutter_width(self.gutter_mode)
            - 6.0)
            .max(160.0);
        let terminal_height = (f32::from(window_size.height)
            - MENU_BAR_HEIGHT
            - TAB_STRIP_HEIGHT
            - sender_height
            - STATUS_BAR_HEIGHT)
            .max(42.0);
        let columns = (terminal_width / 7.85).floor().max(20.0) as usize;
        let rows = (terminal_height / TERMINAL_ROW_HEIGHT).floor().max(2.0) as usize;
        let tab = self.active_tab_mut();
        if columns == tab.terminal.columns() && rows == tab.terminal.screen_lines() {
            return;
        }
        tab.terminal.resize(columns, rows);
        if let Some(writer) = &tab.pty_writer {
            writer.resize(
                columns.min(u16::MAX as usize) as u16,
                rows.min(u16::MAX as usize) as u16,
            );
        }
    }

    fn edit_field(
        value: &mut String,
        select_all: &mut bool,
        event: &KeyDownEvent,
        cx: &mut Context<Self>,
    ) -> FieldAction {
        let key = event.keystroke.key.as_str();
        let select_all_shortcut = key.eq_ignore_ascii_case("a")
            && (event.keystroke.modifiers.platform || event.keystroke.modifiers.control);
        if select_all_shortcut {
            *select_all = true;
            cx.stop_propagation();
            return FieldAction::Changed;
        }
        if is_paste_keystroke(event) {
            if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
                if *select_all {
                    value.clear();
                }
                value.push_str(&text.replace(['\r', '\n'], " "));
            }
            *select_all = false;
            cx.stop_propagation();
            return FieldAction::Changed;
        }
        match key {
            "backspace" => {
                if *select_all {
                    value.clear();
                } else {
                    value.pop();
                }
                *select_all = false;
                cx.stop_propagation();
                FieldAction::Changed
            }
            "enter" => {
                *select_all = false;
                cx.stop_propagation();
                FieldAction::Submit
            }
            "escape" => {
                cx.stop_propagation();
                FieldAction::Escape
            }
            _ if !event.keystroke.modifiers.control
                && !event.keystroke.modifiers.platform
                && !event.keystroke.modifiers.alt =>
            {
                if let Some(text) = event.keystroke.key_char.as_ref() {
                    if *select_all {
                        value.clear();
                    }
                    value.push_str(text);
                    *select_all = false;
                    cx.stop_propagation();
                    FieldAction::Changed
                } else {
                    FieldAction::None
                }
            }
            _ => FieldAction::None,
        }
    }

    fn on_filter_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if Self::edit_field(
            &mut self.session_filter,
            &mut self.filter_select_all,
            event,
            cx,
        ) == FieldAction::Escape
        {
            self.session_filter.clear();
            self.filter_select_all = false;
            self.active_menu = None;
        }
        cx.notify();
    }

    fn on_path_key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        match Self::edit_field(
            &mut self.filer_path_value,
            &mut self.filer_select_all,
            event,
            cx,
        ) {
            FieldAction::Submit => {
                self.open_filer_directory(PathBuf::from(self.filer_path_value.clone()), true, cx)
            }
            FieldAction::Escape => {
                self.filer_path_value = self.filer_path.to_string_lossy().into_owned();
                self.filer_select_all = false;
                cx.notify();
            }
            _ => cx.notify(),
        }
    }

    fn on_sender_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match Self::edit_field(
            &mut self.sender_value,
            &mut self.sender_select_all,
            event,
            cx,
        ) {
            FieldAction::Submit => self.send_sender_value(window, cx),
            FieldAction::Escape => {
                self.sender_value.clear();
                self.sender_select_all = false;
                self.terminal_focus.focus(window);
                cx.notify();
            }
            _ => cx.notify(),
        }
    }

    fn open_filer_directory(
        &mut self,
        path: PathBuf,
        record_history: bool,
        cx: &mut Context<Self>,
    ) {
        let (filer_path, filer_entries, filer_error) = read_local_directory(&path);
        if let Some(error) = filer_error {
            self.filer_error = Some(error);
            self.filer_select_all = true;
            cx.notify();
            return;
        }
        if record_history {
            self.filer_history.truncate(self.filer_history_index + 1);
            if self.filer_history.last() != Some(&filer_path) {
                self.filer_history.push(filer_path.clone());
                self.filer_history_index = self.filer_history.len() - 1;
            }
        }
        self.filer_path = filer_path;
        self.filer_path_value = self.filer_path.to_string_lossy().into_owned();
        self.filer_entries = filer_entries;
        self.filer_error = None;
        self.selected_filer_path = None;
        self.filer_select_all = false;
        cx.notify();
    }

    fn filer_up(&mut self, cx: &mut Context<Self>) {
        if let Some(parent) = self.filer_path.parent() {
            self.open_filer_directory(parent.to_path_buf(), true, cx);
        }
    }

    fn refresh_filer(&mut self, cx: &mut Context<Self>) {
        self.open_filer_directory(self.filer_path.clone(), false, cx);
    }

    fn activate_filer_entry(&mut self, path: PathBuf, is_dir: bool, cx: &mut Context<Self>) {
        if is_dir {
            self.open_filer_directory(path, true, cx);
        } else {
            match open_local_path(&path) {
                Ok(()) => self.set_session_state(format!("Opened {}", path.display())),
                Err(error) => self.set_session_state(error),
            }
            cx.notify();
        }
    }

    fn send_sender_value(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sender_value.is_empty() {
            self.set_session_state("Type a command or choose a preset");
            cx.notify();
            return;
        }
        let mut bytes = match self.sender_mode {
            SenderMode::Text => self.sender_value.as_bytes().to_vec(),
            SenderMode::Hex => match parse_hex_input(&self.sender_value) {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.set_session_state(error);
                    cx.notify();
                    return;
                }
            },
        };
        bytes.extend_from_slice(self.sender_ending.bytes());
        self.write_to_pty(bytes);
        self.sender_value.clear();
        self.sender_select_all = false;
        let title = self.active_tab().title();
        self.set_session_state(format!("Sent to {title}"));
        self.terminal_focus.focus(window);
        cx.notify();
    }

    fn field_text(value: &str, placeholder: &str, focused: bool) -> String {
        if value.is_empty() {
            if focused {
                "│".into()
            } else {
                placeholder.into()
            }
        } else if focused {
            format!("{value}│")
        } else {
            value.into()
        }
    }

    fn section_header(&self, label: &'static str, marker: Hsla, theme: Theme) -> Div {
        div()
            .h(px(PANEL_HEADER_HEIGHT))
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .text_size(px(11.0))
            .text_color(theme.text_dim)
            .child(div().size(px(7.0)).rounded(px(2.0)).bg(marker))
            .child(label)
    }

    fn menu_button(
        &self,
        label: &'static str,
        menu: ActiveMenu,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let active = self.active_menu == Some(menu);
        div()
            .id(label)
            .h_full()
            .px(px(8.0))
            .flex()
            .items_center()
            .rounded(px(3.0))
            .cursor(CursorStyle::PointingHand)
            .when(active, |style| style.bg(theme.hover).text_color(theme.text))
            .hover(move |style| style.bg(theme.hover).text_color(theme.text))
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| {
                this.active_menu = if this.active_menu == Some(menu) {
                    None
                } else {
                    Some(menu)
                };
                cx.notify();
            }))
    }

    fn menu_bar(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        div()
            .h(px(MENU_BAR_HEIGHT))
            .flex_none()
            .flex()
            .items_center()
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.app)
            .child(div().w(px(72.0)).h_full().flex_none())
            .child(
                div()
                    .h_full()
                    .flex()
                    .items_center()
                    .gap(px(2.0))
                    .text_color(theme.text_dim)
                    .child(self.menu_button("Session", ActiveMenu::Session, theme, cx))
                    .child(self.menu_button("Edit", ActiveMenu::Edit, theme, cx))
                    .child(self.menu_button("Search", ActiveMenu::Search, theme, cx))
                    .child(self.menu_button("View", ActiveMenu::View, theme, cx))
                    .child(self.menu_button("Help", ActiveMenu::Help, theme, cx)),
            )
            .child(div().flex_1().h_full())
    }

    fn menu_item_base(label: &'static str, hint: &'static str, theme: Theme) -> Stateful<Div> {
        div()
            .id(label)
            .h(px(26.0))
            .px(px(10.0))
            .flex()
            .items_center()
            .justify_between()
            .rounded(px(4.0))
            .cursor(CursorStyle::PointingHand)
            .hover(move |style| style.bg(theme.hover))
            .child(label)
            .child(div().text_color(theme.text_faint).child(hint))
    }

    fn menu_dropdown(&self, menu: ActiveMenu, theme: Theme, cx: &mut Context<Self>) -> Div {
        let left = match menu {
            ActiveMenu::Session => 72.0,
            ActiveMenu::Edit => 139.0,
            ActiveMenu::Search => 183.0,
            ActiveMenu::View => 245.0,
            ActiveMenu::Help => 292.0,
        };
        let menu_box = div()
            .absolute()
            .top(px(MENU_BAR_HEIGHT))
            .left(px(left))
            .w(px(if menu == ActiveMenu::Session {
                238.0
            } else {
                205.0
            }))
            .p(px(5.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(theme.border_strong)
            .bg(theme.surface)
            .occlude();
        match menu {
            ActiveMenu::Session => menu_box
                .child(
                    Self::menu_item_base("New Session…", "⌘N", theme).on_click(
                        cx.listener(|this, _, window, cx| this.open_new_profile(window, cx)),
                    ),
                )
                .child(
                    Self::menu_item_base("Restart Local Shell", "⌘⇧R", theme).on_click(
                        cx.listener(|this, _, window, cx| {
                            this.active_menu = None;
                            this.restart_active_local(cx);
                            this.terminal_focus.focus(window);
                        }),
                    ),
                )
                .child(
                    Self::menu_item_base("Disconnect", "", theme)
                        .on_click(cx.listener(|this, _, _, cx| this.disconnect_active_local(cx))),
                )
                .child(
                    Self::menu_item_base(
                        "Timestamp + Line Number",
                        if self.gutter_mode == GutterMode::Both {
                            "✓"
                        } else {
                            ""
                        },
                        theme,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.gutter_mode = GutterMode::Both;
                        this.active_menu = None;
                        cx.notify();
                    })),
                )
                .child(
                    Self::menu_item_base(
                        "Line Number Only",
                        if self.gutter_mode == GutterMode::Line {
                            "✓"
                        } else {
                            ""
                        },
                        theme,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.gutter_mode = GutterMode::Line;
                        this.active_menu = None;
                        cx.notify();
                    })),
                )
                .child(
                    Self::menu_item_base(
                        "Timestamp Only",
                        if self.gutter_mode == GutterMode::Time {
                            "✓"
                        } else {
                            ""
                        },
                        theme,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.gutter_mode = GutterMode::Time;
                        this.active_menu = None;
                        cx.notify();
                    })),
                )
                .child(
                    Self::menu_item_base(
                        "No Gutter",
                        if self.gutter_mode == GutterMode::Off {
                            "✓"
                        } else {
                            ""
                        },
                        theme,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.gutter_mode = GutterMode::Off;
                        this.active_menu = None;
                        cx.notify();
                    })),
                ),
            ActiveMenu::Edit => menu_box
                .child(
                    Self::menu_item_base("Paste into Terminal", "⌘V", theme).on_click(cx.listener(
                        |this, _, window, cx| {
                            this.paste_into_terminal(cx);
                            this.active_menu = None;
                            this.terminal_focus.focus(window);
                            cx.notify();
                        },
                    )),
                )
                .child(
                    Self::menu_item_base("Clear Buffer", "⌘K", theme)
                        .on_click(cx.listener(|this, _, _, cx| this.clear_terminal(cx))),
                ),
            ActiveMenu::Search => menu_box.child(
                Self::menu_item_base("Filter Sessions", "⌘F", theme).on_click(cx.listener(
                    |this, _, window, cx| {
                        this.show_sessions = true;
                        this.active_menu = None;
                        this.filter_focus.focus(window);
                        cx.notify();
                    },
                )),
            ),
            ActiveMenu::View => menu_box
                .child(
                    Self::menu_item_base(
                        "Sessions Panel",
                        if self.show_sessions { "✓" } else { "" },
                        theme,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_sessions = !this.show_sessions;
                        this.active_menu = None;
                        cx.notify();
                    })),
                )
                .child(
                    Self::menu_item_base(
                        "Filer Panel",
                        if self.show_filer { "✓" } else { "" },
                        theme,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_filer = !this.show_filer;
                        this.active_menu = None;
                        cx.notify();
                    })),
                )
                .child(
                    Self::menu_item_base(
                        "Sender Panel",
                        if self.show_sender { "✓" } else { "" },
                        theme,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_sender = !this.show_sender;
                        this.active_menu = None;
                        cx.notify();
                    })),
                )
                .child(
                    Self::menu_item_base("Toggle Theme", "", theme).on_click(cx.listener(
                        |this, _, _, cx| {
                            this.theme_mode = match this.theme_mode {
                                ThemeMode::Dark => ThemeMode::Light,
                                ThemeMode::Light => ThemeMode::Dark,
                            };
                            this.active_menu = None;
                            cx.notify();
                        },
                    )),
                ),
            ActiveMenu::Help => menu_box.child(
                Self::menu_item_base("About GPUI Preview", "", theme).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.set_session_state(
                            "EdgeTerm GPUI preview · local shell, Filer and Sender are active",
                        );
                        this.active_menu = None;
                        cx.notify();
                    },
                )),
            ),
        }
    }

    fn session_panel(&self, theme: Theme, window: &Window, cx: &mut Context<Self>) -> Div {
        let connected = self.active_tab().connected();
        let local_tab = self.tabs.iter().find(|tab| tab.profile_id().is_none());
        let local_tab_id = local_tab.map(|tab| tab.id.clone());
        let local_connected = local_tab.is_some_and(SessionTab::connected);
        let needle = self.session_filter.trim().to_ascii_lowercase();
        let matches_local = needle.is_empty() || "local shell".contains(&needle);
        let filter_focused = self.filter_focus.is_focused(window);

        let mut profile_list = div()
            .id("session-profile-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll();
        for (section_kind, section_label) in [
            (SessionKind::Ssh, "SSH Sessions"),
            (SessionKind::Ftp, "(S)FTP Sessions"),
            (SessionKind::Serial, "Serial Sessions"),
            (SessionKind::Local, "Shell Sessions"),
        ] {
            let visible: Vec<(usize, &SessionProfile)> = self
                .profiles
                .iter()
                .enumerate()
                .filter(|(_, profile)| profile_in_section(profile.kind, section_kind))
                .filter(|(_, profile)| {
                    needle.is_empty()
                        || profile.name.to_ascii_lowercase().contains(&needle)
                        || profile.address().to_ascii_lowercase().contains(&needle)
                })
                .collect();
            let local_count = usize::from(section_kind == SessionKind::Local && matches_local);
            profile_list = profile_list.child(
                div()
                    .h(px(22.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_color(theme.text_dim)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .child(
                                div()
                                    .w(px(12.0))
                                    .text_center()
                                    .text_size(px(9.0))
                                    .text_color(theme.text_faint)
                                    .child("▼"),
                            )
                            .child(section_label),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(theme.text_faint)
                            .child((visible.len() + local_count).to_string()),
                    ),
            );
            if section_kind == SessionKind::Local && matches_local {
                let local_tab_id = local_tab_id.clone();
                profile_list = profile_list.child(
                    div()
                        .id("local-shell-session")
                        .h(px(22.0))
                        .px(px(8.0))
                        .flex()
                        .items_center()
                        .gap(px(6.0))
                        .when(self.active_tab().profile_id().is_none(), |row| {
                            row.bg(theme.active)
                        })
                        .cursor(CursorStyle::PointingHand)
                        .hover(move |style| style.bg(theme.hover))
                        .child(div().size(px(8.0)).rounded(px(2.0)).bg(if local_connected {
                            theme.green
                        } else {
                            theme.red
                        }))
                        .child(div().flex_1().min_w_0().child("Local Shell"))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            if let Some(tab_id) = local_tab_id.as_deref() {
                                this.activate_tab(tab_id, window, cx);
                            } else {
                                this.open_local_tab(None, cx);
                                this.terminal_focus.focus(window);
                            }
                        })),
                );
            }
            for (index, profile) in visible {
                profile_list =
                    profile_list.child(self.session_profile_row(profile, index, theme, cx));
            }
        }

        div()
            .w(px(SESSION_PANEL_WIDTH))
            .min_w(px(150.0))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .border_r_1()
            .border_color(theme.border)
            .bg(theme.panel)
            .child(
                self.section_header("Session", theme.yellow, theme).child(
                    div()
                        .ml_auto()
                        .flex()
                        .gap(px(2.0))
                        .child(
                            div()
                                .id("session-power")
                                .size(px(20.0))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.0))
                                .cursor(CursorStyle::PointingHand)
                                .hover(move |style| style.bg(theme.hover))
                                .text_color(if connected {
                                    theme.green
                                } else {
                                    theme.text_faint
                                })
                                .child("⏻")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if connected {
                                        this.disconnect_active_local(cx);
                                    } else {
                                        this.restart_active_local(cx);
                                        this.terminal_focus.focus(window);
                                    }
                                })),
                        )
                        .child(
                            div()
                                .id("new-session-profile")
                                .size(px(20.0))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(4.0))
                                .cursor(CursorStyle::PointingHand)
                                .hover(move |style| style.bg(theme.hover))
                                .child("＋")
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.open_new_profile(window, cx)
                                })),
                        ),
                ),
            )
            .child(
                div()
                    .id("session-filter")
                    .mx(px(8.0))
                    .mt(px(4.0))
                    .mb(px(6.0))
                    .h(px(24.0))
                    .px(px(6.0))
                    .flex()
                    .items_center()
                    .rounded(px(3.0))
                    .border_1()
                    .border_color(if filter_focused {
                        theme.accent
                    } else {
                        theme.border_strong
                    })
                    .bg(theme.surface)
                    .track_focus(&self.filter_focus)
                    .cursor(CursorStyle::IBeam)
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.active_menu = None;
                        this.filter_select_all = true;
                        this.filter_focus.focus(window);
                        cx.notify();
                    }))
                    .on_key_down(cx.listener(Self::on_filter_key_down))
                    .child(
                        div()
                            .min_w_0()
                            .text_color(if self.session_filter.is_empty() && !filter_focused {
                                theme.text_faint
                            } else {
                                theme.text
                            })
                            .child(Self::field_text(
                                &self.session_filter,
                                "Filter",
                                filter_focused,
                            )),
                    ),
            )
            .child(profile_list)
    }

    fn session_profile_row(
        &self,
        profile: &SessionProfile,
        index: usize,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let profile_id = profile.id.clone();
        let edit_profile_id = profile.id.clone();
        let delete_profile_id = profile.id.clone();
        let active = self.active_tab().profile_id() == Some(profile.id.as_str());
        let name = profile.name.clone();
        div()
            .id(("saved-profile", index))
            .h(px(22.0))
            .px(px(8.0))
            .flex()
            .items_center()
            .gap(px(6.0))
            .when(active, |row| row.bg(theme.active))
            .cursor(CursorStyle::PointingHand)
            .hover(move |style| style.bg(theme.hover))
            .child(
                div()
                    .size(px(8.0))
                    .rounded(px(2.0))
                    .bg(profile_kind_color(profile.kind, theme)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .child(name.clone()),
            )
            .child(
                div()
                    .id(("edit-profile", index))
                    .size(px(16.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(3.0))
                    .text_color(theme.text_faint)
                    .hover(move |style| style.bg(theme.hover).text_color(theme.text))
                    .child("✎")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.open_profile_editor(&edit_profile_id, window, cx);
                    })),
            )
            .child(
                div()
                    .id(("delete-profile", index))
                    .size(px(16.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(3.0))
                    .text_color(theme.text_faint)
                    .hover(move |style| style.bg(theme.hover).text_color(theme.red))
                    .child("×")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.open_profile_editor(&delete_profile_id, window, cx);
                        if let Some(dialog) = this.profile_dialog.as_mut() {
                            dialog.confirm_delete = true;
                        }
                        cx.notify();
                    })),
            )
            .on_click(cx.listener(move |this, event: &ClickEvent, window, cx| {
                if event.click_count() >= 2 {
                    this.activate_saved_profile(&profile_id, window, cx);
                } else {
                    this.set_session_state(format!("Double-click {name} to open it"));
                    cx.notify();
                }
            }))
    }

    fn terminal(&self, theme: Theme, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.active_tab().terminal.rows();
        let gutter_mode = self.gutter_mode;
        div()
            .id("terminal")
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .bg(theme.surface)
            .font_family(MONO_FONT)
            .text_size(px(13.0))
            .track_focus(&self.terminal_focus)
            .cursor(CursorStyle::IBeam)
            .on_mouse_down(MouseButton::Left, cx.listener(Self::focus_terminal))
            .on_scroll_wheel(cx.listener(Self::on_terminal_scroll))
            .on_key_down(cx.listener(Self::on_terminal_key_down))
            .children(rows.into_iter().map(|row| {
                div()
                    .h(px(TERMINAL_ROW_HEIGHT))
                    .flex()
                    .items_center()
                    .when(gutter_mode != GutterMode::Off, |line| {
                        line.child(terminal_gutter(row.gutter, gutter_mode, theme))
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .pl(px(6.0))
                            .flex()
                            .items_center()
                            .overflow_hidden()
                            .children(row.runs.into_iter().map(|run| terminal_run(run, theme))),
                    )
            }))
    }

    fn center_panel(&self, theme: Theme, cx: &mut Context<Self>) -> Div {
        let mut tab_strip = div()
            .id("session-tabs")
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .items_center()
            .overflow_x_scroll();
        for (index, tab) in self.tabs.iter().enumerate() {
            let tab_id = tab.id.clone();
            let close_id = tab.id.clone();
            let active = tab.id == self.active_tab_id;
            let connected = tab.connected();
            tab_strip = tab_strip.child(
                div()
                    .id(("session-tab", index))
                    .h_full()
                    .min_w(px(118.0))
                    .max_w(px(220.0))
                    .px(px(10.0))
                    .flex()
                    .items_center()
                    .gap(px(7.0))
                    .border_t_2()
                    .border_color(if active { theme.accent } else { theme.panel })
                    .when(active, |tab| tab.bg(theme.surface))
                    .cursor(CursorStyle::PointingHand)
                    .hover(move |style| style.bg(theme.hover))
                    .child(
                        div()
                            .text_color(theme.text_faint)
                            .child(format!("{}.", tab.number)),
                    )
                    .child(
                        div()
                            .size(px(8.0))
                            .flex_none()
                            .rounded(px(4.0))
                            .bg(if connected { theme.green } else { theme.red }),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .child(tab.title()),
                    )
                    .child(
                        div()
                            .id(("tab-close", index))
                            .size(px(20.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.0))
                            .hover(move |style| style.bg(theme.active))
                            .child("×")
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.close_tab(&close_id, window, cx);
                            })),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.activate_tab(&tab_id, window, cx);
                    })),
            );
        }

        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(TAB_STRIP_HEIGHT))
                    .flex_none()
                    .flex()
                    .items_center()
                    .border_b_1()
                    .border_color(theme.border)
                    .bg(theme.panel)
                    .child(tab_strip)
                    .child(
                        div()
                            .id("new-local-tab")
                            .size(px(22.0))
                            .mx(px(4.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.0))
                            .cursor(CursorStyle::PointingHand)
                            .hover(move |style| style.bg(theme.hover))
                            .child("＋")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open_local_tab(None, cx);
                                this.terminal_focus.focus(window);
                            })),
                    ),
            )
            .child(self.terminal(theme, cx))
    }

    fn filer_tool_button(
        id: &'static str,
        icon: &'static str,
        enabled: bool,
        theme: Theme,
    ) -> Stateful<Div> {
        let color = if enabled {
            theme.text_dim
        } else {
            theme.text_faint
        };
        div()
            .id(id)
            .size(px(24.0))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(3.0))
            .text_color(color)
            .when(enabled, |button| {
                button
                    .cursor(CursorStyle::PointingHand)
                    .hover(move |style| style.bg(theme.hover).text_color(theme.text))
            })
            .child(svg().path(icon).size(px(16.0)).text_color(color))
    }

    fn filer_panel(&self, theme: Theme, window: &Window, cx: &mut Context<Self>) -> Div {
        let folders = self
            .filer_entries
            .iter()
            .filter(|entry| entry.is_dir && entry.name != "..")
            .count();
        let files = self
            .filer_entries
            .iter()
            .filter(|entry| !entry.is_dir)
            .count();
        let summary = self
            .filer_error
            .clone()
            .unwrap_or_else(|| format!("{folders} folders  ·  {files} files"));
        let path_focused = self.filer_focus.is_focused(window);
        let can_up = self.filer_path.parent().is_some();

        div()
            .w(px(FILER_PANEL_WIDTH))
            .min_w(px(150.0))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .border_l_1()
            .border_color(theme.border)
            .bg(theme.panel)
            .child(
                self.section_header("Filer", theme.accent, theme).child(
                    div()
                        .ml(px(2.0))
                        .text_size(px(11.0))
                        .text_color(theme.text_faint)
                        .child("local"),
                ),
            )
            .child(
                div()
                    .h(px(32.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_t_1()
                    .border_b_1()
                    .border_color(theme.border)
                    .bg(theme.surface)
                    .child(Self::filer_tool_button(
                        "new-file",
                        "icons/new-file.svg",
                        false,
                        theme,
                    ))
                    .child(Self::filer_tool_button(
                        "new-folder",
                        "icons/new-folder.svg",
                        false,
                        theme,
                    ))
                    .child(Self::filer_tool_button(
                        "upload",
                        "icons/upload.svg",
                        false,
                        theme,
                    ))
                    .child(Self::filer_tool_button(
                        "download",
                        "icons/download.svg",
                        false,
                        theme,
                    ))
                    .child(
                        Self::filer_tool_button("refresh", "icons/refresh.svg", true, theme)
                            .on_click(cx.listener(|this, _, _, cx| this.refresh_filer(cx))),
                    )
                    .child(Self::filer_tool_button(
                        "delete",
                        "icons/delete.svg",
                        false,
                        theme,
                    )),
            )
            .child(
                div()
                    .h(px(32.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .gap(px(4.0))
                    .child(
                        Self::filer_tool_button(
                            "parent-folder",
                            "icons/parent-folder.svg",
                            can_up,
                            theme,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if can_up {
                                this.filer_up(cx);
                            }
                        })),
                    )
                    .child(Self::filer_tool_button(
                        "terminal-folder",
                        "icons/terminal-folder.svg",
                        false,
                        theme,
                    ))
                    .child(
                        div()
                            .id("filer-path")
                            .h(px(24.0))
                            .flex_1()
                            .min_w_0()
                            .px(px(6.0))
                            .flex()
                            .items_center()
                            .rounded(px(3.0))
                            .border_1()
                            .border_color(if path_focused {
                                theme.accent
                            } else {
                                theme.border_strong
                            })
                            .bg(theme.surface)
                            .font_family(MONO_FONT)
                            .text_size(px(11.0))
                            .track_focus(&self.filer_focus)
                            .cursor(CursorStyle::IBeam)
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.active_menu = None;
                                this.filer_select_all = true;
                                this.filer_focus.focus(window);
                                cx.notify();
                            }))
                            .on_key_down(cx.listener(Self::on_path_key_down))
                            .child(Self::field_text(
                                &self.filer_path_value,
                                "Enter a folder path",
                                path_focused,
                            )),
                    ),
            )
            .child(
                div()
                    .h(px(22.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .justify_between()
                    .border_t_1()
                    .border_b_1()
                    .border_color(theme.border)
                    .text_size(px(11.0))
                    .text_color(theme.text_faint)
                    .child("Name")
                    .child("Modified"),
            )
            .child(
                div()
                    .id("filer-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(self.filer_entries.iter().cloned().enumerate().map(
                        |(index, entry)| {
                            let path = entry.path.clone();
                            let directory = entry.is_dir;
                            let selected = self.selected_filer_path.as_ref() == Some(&entry.path);
                            div()
                                .id(("filer-entry", index))
                                .h(px(24.0))
                                .px(px(8.0))
                                .flex()
                                .items_center()
                                .justify_between()
                                .when(selected, |row| row.bg(theme.active))
                                .hover(move |style| style.bg(theme.hover))
                                .cursor(CursorStyle::PointingHand)
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .flex()
                                        .items_center()
                                        .gap(px(7.0))
                                        .child(
                                            svg()
                                                .path(if directory {
                                                    "icons/folder.svg"
                                                } else {
                                                    "icons/file.svg"
                                                })
                                                .size(px(16.0)),
                                        )
                                        .child(entry.name),
                                )
                                .child(
                                    div()
                                        .ml(px(8.0))
                                        .flex_none()
                                        .w(px(74.0))
                                        .text_right()
                                        .text_size(px(10.0))
                                        .text_color(theme.text_faint)
                                        .child(entry.detail),
                                )
                                .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                                    this.selected_filer_path = Some(path.clone());
                                    if event.click_count() >= 2 {
                                        this.activate_filer_entry(path.clone(), directory, cx);
                                    } else {
                                        cx.notify();
                                    }
                                }))
                        },
                    )),
            )
            .child(
                div()
                    .h(px(24.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .border_t_1()
                    .border_color(theme.border)
                    .text_color(if self.filer_error.is_some() {
                        theme.red
                    } else {
                        theme.text_faint
                    })
                    .child(summary),
            )
    }

    fn sender(&self, theme: Theme, window: &Window, cx: &mut Context<Self>) -> Div {
        let sender_focused = self.sender_focus.is_focused(window);
        div()
            .h(px(SENDER_HEIGHT))
            .flex_none()
            .flex()
            .flex_col()
            .bg(theme.panel)
            .child(
                div()
                    .h(px(26.0))
                    .flex_none()
                    .flex()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        div()
                            .px(px(12.0))
                            .flex()
                            .items_center()
                            .gap(px(6.0))
                            .bg(theme.surface)
                            .border_b_2()
                            .border_color(theme.accent)
                            .text_size(px(11.0))
                            .child(div().size(px(7.0)).rounded(px(2.0)).bg(theme.red))
                            .child("Sender"),
                    ),
            )
            .child(
                div()
                    .h(px(34.0))
                    .px(px(10.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(10.0))
                    .text_color(theme.text_dim)
                    .child(
                        div()
                            .id("sender-play")
                            .size(px(22.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(3.0))
                            .text_color(theme.green)
                            .cursor(CursorStyle::PointingHand)
                            .hover(move |style| style.bg(theme.hover))
                            .child("▶")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.send_sender_value(window, cx)
                            })),
                    )
                    .child(
                        div()
                            .id("sender-clear")
                            .size(px(22.0))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(3.0))
                            .cursor(CursorStyle::PointingHand)
                            .hover(move |style| style.bg(theme.hover))
                            .child("×")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.sender_value.clear();
                                this.sender_select_all = false;
                                this.sender_focus.focus(window);
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("text")
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .cursor(CursorStyle::PointingHand)
                            .child(if self.sender_mode == SenderMode::Text {
                                "●"
                            } else {
                                "○"
                            })
                            .child("Text")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.sender_mode = SenderMode::Text;
                                this.sender_focus.focus(window);
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("hex")
                            .flex()
                            .items_center()
                            .gap(px(4.0))
                            .cursor(CursorStyle::PointingHand)
                            .child(if self.sender_mode == SenderMode::Hex {
                                "●"
                            } else {
                                "○"
                            })
                            .child("Hex")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.sender_mode = SenderMode::Hex;
                                this.sender_focus.focus(window);
                                cx.notify();
                            })),
                    )
                    .child("Ending:")
                    .child(
                        div()
                            .id("sender-ending")
                            .h(px(22.0))
                            .px(px(7.0))
                            .flex()
                            .items_center()
                            .rounded(px(3.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .bg(theme.surface)
                            .cursor(CursorStyle::PointingHand)
                            .child(self.sender_ending.label())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.sender_ending = this.sender_ending.next();
                                cx.notify();
                            })),
                    )
                    .child("Targets:")
                    .child(
                        div()
                            .h(px(22.0))
                            .px(px(7.0))
                            .flex()
                            .items_center()
                            .rounded(px(3.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .bg(theme.surface)
                            .child("Current Session"),
                    ),
            )
            .child(
                div()
                    .h(px(38.0))
                    .px(px(10.0))
                    .pb(px(8.0))
                    .flex_none()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .child(
                        div()
                            .id("sender-input")
                            .h(px(30.0))
                            .flex_1()
                            .min_w_0()
                            .px(px(7.0))
                            .flex()
                            .items_center()
                            .rounded(px(3.0))
                            .border_1()
                            .border_color(if sender_focused {
                                theme.accent
                            } else {
                                theme.border
                            })
                            .bg(theme.field)
                            .font_family(MONO_FONT)
                            .text_color(if self.sender_value.is_empty() && !sender_focused {
                                theme.text_faint
                            } else {
                                theme.text
                            })
                            .track_focus(&self.sender_focus)
                            .cursor(CursorStyle::IBeam)
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.active_menu = None;
                                this.sender_select_all = true;
                                this.sender_focus.focus(window);
                                cx.notify();
                            }))
                            .on_key_down(cx.listener(Self::on_sender_key_down))
                            .child(Self::field_text(
                                &self.sender_value,
                                if self.sender_mode == SenderMode::Hex {
                                    "48 65 6C 6C 6F   (hex bytes)"
                                } else {
                                    "Type a command (append \\n)"
                                },
                                sender_focused,
                            )),
                    )
                    .child(
                        div()
                            .w(px(180.0))
                            .h(px(30.0))
                            .px(px(7.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .rounded(px(3.0))
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.field)
                            .text_color(theme.text_faint)
                            .child("Tag name (optional)"),
                    )
                    .child(
                        div()
                            .w(px(56.0))
                            .h(px(30.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(3.0))
                            .border_1()
                            .border_color(theme.border_strong)
                            .text_color(theme.text_faint)
                            .opacity(0.4)
                            .child("Save"),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .px(px(10.0))
                    .py(px(8.0))
                    .flex()
                    .items_start()
                    .gap(px(6.0))
                    .border_t_1()
                    .border_color(theme.border)
                    .children(
                        ["pwd", "ls -la", "whoami", "clear"]
                            .into_iter()
                            .enumerate()
                            .map(|(index, command)| {
                                div()
                                    .id(("sender-command", index))
                                    .h(px(26.0))
                                    .px(px(8.0))
                                    .flex()
                                    .items_center()
                                    .rounded(px(4.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .bg(theme.surface)
                                    .font_family(MONO_FONT)
                                    .cursor(CursorStyle::PointingHand)
                                    .hover(move |style| style.bg(theme.hover))
                                    .child(command)
                                    .on_click(cx.listener(move |this, _, window, cx| {
                                        this.write_to_pty(format!("{command}\r").into_bytes());
                                        this.set_session_state(format!("Sent preset: {command}"));
                                        this.terminal_focus.focus(window);
                                        cx.notify();
                                    }))
                            }),
                    ),
            )
    }

    fn profile_input(
        &self,
        field: ProfileField,
        label: &'static str,
        placeholder: &'static str,
        secret: bool,
        theme: Theme,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let dialog = self
            .profile_dialog
            .as_ref()
            .expect("profile dialog is open");
        let value = profile_field_value(&dialog.profile, field);
        let active = dialog.active_field == field;
        let display_value = if secret && !value.is_empty() {
            "•".repeat(value.chars().count())
        } else {
            value.clone()
        };
        div()
            .id(("profile-field", field.id()))
            .flex_1()
            .min_w(px(180.0))
            .flex()
            .flex_col()
            .gap(px(5.0))
            .cursor(CursorStyle::IBeam)
            .child(
                div()
                    .text_size(px(10.0))
                    .font_weight(FontWeight::BOLD)
                    .text_color(theme.text_faint)
                    .child(label),
            )
            .child(
                div()
                    .h(px(34.0))
                    .px(px(9.0))
                    .flex()
                    .items_center()
                    .rounded(px(5.0))
                    .border_1()
                    .border_color(if active {
                        theme.accent
                    } else {
                        theme.border_strong
                    })
                    .bg(theme.field)
                    .font_family(if secret { UI_FONT } else { MONO_FONT })
                    .text_color(if display_value.is_empty() {
                        theme.text_faint
                    } else {
                        theme.text
                    })
                    .child(Self::field_text(
                        &display_value,
                        placeholder,
                        active && !dialog.select_all,
                    )),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                if let Some(dialog) = this.profile_dialog.as_mut() {
                    dialog.active_field = field;
                    dialog.select_all = true;
                    dialog.confirm_delete = false;
                }
                this.profile_dialog_focus.focus(window);
                cx.notify();
            }))
    }

    fn profile_dialog_view(&self, theme: Theme, _window: &Window, cx: &mut Context<Self>) -> Div {
        let dialog = self
            .profile_dialog
            .as_ref()
            .expect("profile dialog is open");
        let profile = &dialog.profile;
        let editing = !profile.id.is_empty();
        let parity = profile.parity.clone().unwrap_or_else(|| "none".into());
        let flow_control = profile
            .flow_control
            .clone()
            .unwrap_or_else(|| "none".into());
        let mut protocol_row = div().flex().gap(px(6.0));
        for (index, (kind, label)) in [
            (SessionKind::Ssh, "SSH"),
            (SessionKind::Sftp, "SFTP"),
            (SessionKind::Ftp, "FTP"),
            (SessionKind::Local, "Shell"),
            (SessionKind::Serial, "Serial"),
        ]
        .into_iter()
        .enumerate()
        {
            let selected = profile.kind == kind;
            protocol_row = protocol_row.child(
                div()
                    .id(("profile-kind", index))
                    .h(px(30.0))
                    .px(px(13.0))
                    .flex()
                    .items_center()
                    .rounded(px(5.0))
                    .border_1()
                    .border_color(if selected {
                        theme.accent
                    } else {
                        theme.border_strong
                    })
                    .bg(if selected { theme.active } else { theme.panel })
                    .cursor(CursorStyle::PointingHand)
                    .hover(move |style| style.bg(theme.hover))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| this.set_profile_kind(kind, cx))),
            );
        }

        let mut form = div()
            .flex()
            .flex_col()
            .gap(px(14.0))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.0))
                    .child(
                        div()
                            .text_size(px(10.0))
                            .font_weight(FontWeight::BOLD)
                            .text_color(theme.text_faint)
                            .child("PROTOCOL"),
                    )
                    .child(protocol_row),
            )
            .child(div().flex().gap(px(12.0)).child(self.profile_input(
                ProfileField::Name,
                "SESSION NAME",
                "Name shown in the sidebar",
                false,
                theme,
                cx,
            )));

        match profile.kind {
            SessionKind::Ssh | SessionKind::Sftp | SessionKind::Ftp => {
                form = form
                    .child(
                        div()
                            .flex()
                            .gap(px(12.0))
                            .child(self.profile_input(
                                ProfileField::Host,
                                "HOST",
                                "example.com",
                                false,
                                theme,
                                cx,
                            ))
                            .child(self.profile_input(
                                ProfileField::Port,
                                "PORT",
                                if profile.kind == SessionKind::Ftp {
                                    "21"
                                } else {
                                    "22"
                                },
                                false,
                                theme,
                                cx,
                            )),
                    )
                    .child(div().flex().gap(px(12.0)).child(self.profile_input(
                        ProfileField::Username,
                        "USERNAME",
                        if profile.kind == SessionKind::Ftp {
                            "anonymous"
                        } else {
                            "user"
                        },
                        false,
                        theme,
                        cx,
                    )));
                if profile.kind == SessionKind::Ftp {
                    form = form.child(div().flex().gap(px(12.0)).child(self.profile_input(
                        ProfileField::Password,
                        "PASSWORD",
                        "Optional",
                        true,
                        theme,
                        cx,
                    )));
                } else {
                    let auth = profile.auth.unwrap_or_default();
                    form = form.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .text_size(px(10.0))
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(theme.text_faint)
                                    .child("AUTHENTICATION"),
                            )
                            .child(
                                div()
                                    .id("profile-auth")
                                    .h(px(34.0))
                                    .px(px(10.0))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .rounded(px(5.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .cursor(CursorStyle::PointingHand)
                                    .hover(move |style| style.bg(theme.hover))
                                    .child(auth_label(auth))
                                    .child("Click to change  ›")
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.cycle_profile_auth(cx)),
                                    ),
                            ),
                    );
                    match auth {
                        AuthKind::Password => {
                            form =
                                form.child(div().flex().gap(px(12.0)).child(self.profile_input(
                                    ProfileField::Password,
                                    "PASSWORD",
                                    "Saved in encrypted credentials",
                                    true,
                                    theme,
                                    cx,
                                )));
                        }
                        AuthKind::PublicKey => {
                            form = form
                                .child(div().flex().gap(px(12.0)).child(self.profile_input(
                                    ProfileField::PrivateKey,
                                    "PRIVATE KEY",
                                    "~/.ssh/id_ed25519",
                                    false,
                                    theme,
                                    cx,
                                )))
                                .child(div().flex().gap(px(12.0)).child(self.profile_input(
                                    ProfileField::Passphrase,
                                    "PASSPHRASE",
                                    "Optional",
                                    true,
                                    theme,
                                    cx,
                                )));
                        }
                        AuthKind::Agent => {}
                    }
                }
            }
            SessionKind::Local => {
                form = form
                    .child(div().flex().gap(px(12.0)).child(self.profile_input(
                        ProfileField::Shell,
                        "SHELL COMMAND",
                        "Default login shell",
                        false,
                        theme,
                        cx,
                    )))
                    .child(div().flex().gap(px(12.0)).child(self.profile_input(
                        ProfileField::Cwd,
                        "WORKING DIRECTORY",
                        "Home directory",
                        false,
                        theme,
                        cx,
                    )));
            }
            SessionKind::Serial => {
                form = form
                    .child(
                        div()
                            .flex()
                            .gap(px(12.0))
                            .child(self.profile_input(
                                ProfileField::SerialPort,
                                "SERIAL PORT",
                                "/dev/cu.usbserial…",
                                false,
                                theme,
                                cx,
                            ))
                            .child(self.profile_input(
                                ProfileField::BaudRate,
                                "BAUD RATE",
                                "115200",
                                false,
                                theme,
                                cx,
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(12.0))
                            .child(
                                div()
                                    .id("profile-parity")
                                    .h(px(34.0))
                                    .flex_1()
                                    .px(px(10.0))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .rounded(px(5.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .cursor(CursorStyle::PointingHand)
                                    .hover(move |style| style.bg(theme.hover))
                                    .child("Parity")
                                    .child(parity)
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.cycle_profile_parity(cx)),
                                    ),
                            )
                            .child(
                                div()
                                    .id("profile-flow")
                                    .h(px(34.0))
                                    .flex_1()
                                    .px(px(10.0))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .rounded(px(5.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .cursor(CursorStyle::PointingHand)
                                    .hover(move |style| style.bg(theme.hover))
                                    .child("Flow control")
                                    .child(flow_control)
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.cycle_profile_flow_control(cx)
                                    })),
                            ),
                    );
            }
        }

        let title = if editing {
            "Edit Session"
        } else {
            "New Session"
        };
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .track_focus(&self.profile_dialog_focus)
            .on_key_down(cx.listener(Self::on_profile_dialog_key_down))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .bg(rgba(0x00000099)),
            )
            .child(
                div()
                    .w(px(650.0))
                    .max_h(px(570.0))
                    .flex()
                    .flex_col()
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(theme.border_strong)
                    .bg(theme.surface)
                    .occlude()
                    .child(
                        div()
                            .h(px(48.0))
                            .px(px(16.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_between()
                            .border_b_1()
                            .border_color(theme.border)
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.0))
                                    .child(
                                        div()
                                            .font_weight(FontWeight::BOLD)
                                            .child(title),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(10.0))
                                            .text_color(theme.text_faint)
                                            .child("Saved in the shared EdgeTerm profile store"),
                                    ),
                            )
                            .child(
                                div()
                                    .id("profile-close")
                                    .size(px(25.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(4.0))
                                    .cursor(CursorStyle::PointingHand)
                                    .hover(move |style| style.bg(theme.hover))
                                    .child("×")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.close_profile_dialog(window, cx)
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("profile-dialog-body")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .p(px(16.0))
                            .child(form)
                            .when_some(dialog.error.clone(), |body, error| {
                                body.child(
                                    div()
                                        .mt(px(14.0))
                                        .p(px(10.0))
                                        .rounded(px(5.0))
                                        .bg(theme.hover)
                                        .text_color(theme.red)
                                        .child(error),
                                )
                            })
                            .when(dialog.confirm_delete, |body| {
                                body.child(
                                    div()
                                        .mt(px(14.0))
                                        .p(px(10.0))
                                        .rounded(px(5.0))
                                        .border_1()
                                        .border_color(theme.red)
                                        .text_color(theme.red)
                                        .child(format!(
                                            "Delete “{}”? Credentials and profile-scoped commands will also be removed.",
                                            profile.name
                                        )),
                                )
                            }),
                    )
                    .child(
                        div()
                            .h(px(52.0))
                            .px(px(16.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .border_t_1()
                            .border_color(theme.border)
                            .when(editing, |footer| {
                                footer.child(
                                    div()
                                        .id("profile-delete")
                                        .h(px(32.0))
                                        .px(px(12.0))
                                        .flex()
                                        .items_center()
                                        .rounded(px(5.0))
                                        .border_1()
                                        .border_color(theme.red)
                                        .text_color(theme.red)
                                        .cursor(CursorStyle::PointingHand)
                                        .hover(move |style| style.bg(theme.hover))
                                        .child(if dialog.confirm_delete {
                                            "Confirm Delete"
                                        } else {
                                            "Delete…"
                                        })
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            let confirm = this
                                                .profile_dialog
                                                .as_ref()
                                                .is_some_and(|dialog| dialog.confirm_delete);
                                            if confirm {
                                                this.delete_profile_dialog(window, cx);
                                            } else if let Some(dialog) =
                                                this.profile_dialog.as_mut()
                                            {
                                                dialog.confirm_delete = true;
                                                dialog.error = None;
                                                cx.notify();
                                            }
                                        })),
                                )
                            })
                            .child(div().flex_1())
                            .child(
                                div()
                                    .id("profile-cancel")
                                    .h(px(32.0))
                                    .px(px(13.0))
                                    .flex()
                                    .items_center()
                                    .rounded(px(5.0))
                                    .border_1()
                                    .border_color(theme.border_strong)
                                    .cursor(CursorStyle::PointingHand)
                                    .hover(move |style| style.bg(theme.hover))
                                    .child("Cancel")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.close_profile_dialog(window, cx)
                                    })),
                            )
                            .child(
                                div()
                                    .id("profile-save")
                                    .h(px(32.0))
                                    .px(px(15.0))
                                    .flex()
                                    .items_center()
                                    .rounded(px(5.0))
                                    .bg(theme.accent)
                                    .text_color(theme.accent_contrast)
                                    .font_weight(FontWeight::BOLD)
                                    .cursor(CursorStyle::PointingHand)
                                    .hover(|style| style.opacity(0.88))
                                    .child("Save Session")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.save_profile_dialog(window, cx)
                                    })),
                            ),
                    ),
            )
    }

    fn status_bar(&self, theme: Theme) -> Div {
        let tab = self.active_tab();
        let dimensions = format!(
            "Window {}×{}",
            tab.terminal.screen_lines(),
            tab.terminal.columns()
        );
        div()
            .h(px(STATUS_BAR_HEIGHT))
            .flex_none()
            .px(px(12.0))
            .flex()
            .items_center()
            .justify_between()
            .border_t_1()
            .border_color(theme.border)
            .bg(theme.app)
            .text_size(px(11.0))
            .text_color(theme.text_dim)
            .child(tab.state.clone())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(14.0))
                    .child(dimensions)
                    .child("shell")
                    .child(self.clock.clone()),
            )
    }
}

impl Focusable for EdgeTermApp {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.terminal_focus.clone()
    }
}

const PROFILE_COLORS: [&str; 8] = [
    "#4ea1f3", "#3fb950", "#e3b341", "#f85149", "#bc8cff", "#39c5cf", "#f0883e", "#db61a2",
];

fn next_tab_number(tabs: &[SessionTab]) -> usize {
    (1..)
        .find(|number| tabs.iter().all(|tab| tab.number != *number))
        .expect("a free tab number must exist")
}

fn next_tab_ordinal(tabs: &[SessionTab], profile_id: Option<&str>, name: &str) -> usize {
    (0..)
        .find(|ordinal| {
            tabs.iter().all(|tab| {
                let same_profile = match (profile_id, tab.profile_id()) {
                    (Some(left), Some(right)) => left == right,
                    (None, None) => tab.name == name,
                    _ => false,
                };
                !same_profile || tab.ordinal != *ordinal
            })
        })
        .expect("a free tab ordinal must exist")
}

fn blank_profile(color: &str) -> SessionProfile {
    SessionProfile {
        id: String::new(),
        name: String::new(),
        kind: SessionKind::Ssh,
        color: Some(color.into()),
        group_id: None,
        shell: None,
        cwd: None,
        host: None,
        port: Some(22),
        username: None,
        auth: Some(AuthKind::Password),
        password: None,
        private_key_path: None,
        passphrase: None,
        jump_profile_id: None,
        port_name: None,
        baud_rate: Some(115_200),
        data_bits: Some(8),
        stop_bits: Some(1),
        parity: Some("none".into()),
        flow_control: Some("none".into()),
    }
}

fn default_profile_name(profile: &SessionProfile) -> String {
    match profile.kind {
        SessionKind::Local => "Local Shell".into(),
        SessionKind::Serial => profile.port_name.clone().unwrap_or_else(|| "Serial".into()),
        SessionKind::Ssh => profile.host.clone().unwrap_or_else(|| "SSH".into()),
        SessionKind::Sftp => profile.host.clone().unwrap_or_else(|| "SFTP".into()),
        SessionKind::Ftp => profile.host.clone().unwrap_or_else(|| "FTP".into()),
    }
}

fn profile_fields(profile: &SessionProfile) -> Vec<ProfileField> {
    let mut fields = vec![ProfileField::Name];
    match profile.kind {
        SessionKind::Ssh | SessionKind::Sftp | SessionKind::Ftp => {
            fields.extend([
                ProfileField::Host,
                ProfileField::Port,
                ProfileField::Username,
            ]);
            if profile.kind == SessionKind::Ftp
                || profile.auth.unwrap_or_default() == AuthKind::Password
            {
                fields.push(ProfileField::Password);
            } else if profile.auth == Some(AuthKind::PublicKey) {
                fields.extend([ProfileField::PrivateKey, ProfileField::Passphrase]);
            }
        }
        SessionKind::Local => fields.extend([ProfileField::Shell, ProfileField::Cwd]),
        SessionKind::Serial => fields.extend([ProfileField::SerialPort, ProfileField::BaudRate]),
    }
    fields
}

fn profile_field_value(profile: &SessionProfile, field: ProfileField) -> String {
    match field {
        ProfileField::Name => profile.name.clone(),
        ProfileField::Host => profile.host.clone().unwrap_or_default(),
        ProfileField::Port => profile
            .port
            .map(|port| port.to_string())
            .unwrap_or_default(),
        ProfileField::Username => profile.username.clone().unwrap_or_default(),
        ProfileField::Password => profile.password.clone().unwrap_or_default(),
        ProfileField::PrivateKey => profile.private_key_path.clone().unwrap_or_default(),
        ProfileField::Passphrase => profile.passphrase.clone().unwrap_or_default(),
        ProfileField::Shell => profile.shell.clone().unwrap_or_default(),
        ProfileField::Cwd => profile.cwd.clone().unwrap_or_default(),
        ProfileField::SerialPort => profile.port_name.clone().unwrap_or_default(),
        ProfileField::BaudRate => profile
            .baud_rate
            .map(|baud| baud.to_string())
            .unwrap_or_default(),
    }
}

fn set_profile_field_value(profile: &mut SessionProfile, field: ProfileField, value: String) {
    let optional = |value: String| (!value.is_empty()).then_some(value);
    match field {
        ProfileField::Name => profile.name = value,
        ProfileField::Host => profile.host = optional(value),
        ProfileField::Port => profile.port = value.parse().ok(),
        ProfileField::Username => profile.username = optional(value),
        ProfileField::Password => profile.password = optional(value),
        ProfileField::PrivateKey => profile.private_key_path = optional(value),
        ProfileField::Passphrase => profile.passphrase = optional(value),
        ProfileField::Shell => profile.shell = optional(value),
        ProfileField::Cwd => profile.cwd = optional(value),
        ProfileField::SerialPort => profile.port_name = optional(value),
        ProfileField::BaudRate => profile.baud_rate = value.parse().ok(),
    }
}

fn auth_label(auth: AuthKind) -> &'static str {
    match auth {
        AuthKind::Password => "Password",
        AuthKind::PublicKey => "Public key",
        AuthKind::Agent => "SSH agent",
    }
}

fn profile_in_section(kind: SessionKind, section: SessionKind) -> bool {
    match section {
        SessionKind::Ftp => matches!(kind, SessionKind::Ftp | SessionKind::Sftp),
        _ => kind == section,
    }
}

fn profile_kind_color(kind: SessionKind, theme: Theme) -> Hsla {
    match kind {
        SessionKind::Local => theme.green,
        SessionKind::Ssh => theme.accent,
        SessionKind::Ftp => theme.yellow,
        SessionKind::Sftp => theme.directory,
        SessionKind::Serial => rgb(0xbc8cff).into(),
    }
}

fn terminal_run(run: TerminalRun, theme: Theme) -> Div {
    div()
        .h_full()
        .flex()
        .items_center()
        .bg(terminal_color(run.style.background, theme))
        .text_color(terminal_color(run.style.foreground, theme))
        .when(run.style.bold, |style| style.font_weight(FontWeight::BOLD))
        .when(run.style.italic, |style| style.italic())
        .when(run.style.underline, |style| style.underline())
        .child(run.text)
}

fn terminal_gutter(gutter: Option<TerminalGutter>, mode: GutterMode, theme: Theme) -> Div {
    let width = terminal_gutter_width(mode);
    let cursor = gutter.as_ref().is_some_and(|gutter| gutter.cursor);
    let timestamp = gutter
        .as_ref()
        .map(|gutter| gutter.timestamp.clone())
        .unwrap_or_default();
    let line_number = gutter
        .map(|gutter| gutter.line_number.to_string())
        .unwrap_or_default();

    div()
        .w(px(width))
        .h_full()
        .pl(px(6.0))
        .pr(px(8.0))
        .flex_none()
        .flex()
        .items_center()
        .justify_end()
        .gap(px(8.0))
        .border_r_1()
        .border_color(theme.border)
        .text_size(px(12.0))
        .when(cursor, |gutter| gutter.bg(rgba(0x0078d41a)))
        .when(mode.shows_time(), |gutter| {
            gutter.child(div().text_color(theme.gutter_time).child(timestamp))
        })
        .when(mode.shows_line(), |gutter| {
            gutter.child(
                div()
                    .min_w(px(28.0))
                    .w(px(32.0))
                    .text_right()
                    .text_color(theme.gutter_text)
                    .child(line_number),
            )
        })
}

fn terminal_gutter_width(mode: GutterMode) -> f32 {
    match mode {
        GutterMode::Both => 158.0,
        GutterMode::Time => 116.0,
        GutterMode::Line => 48.0,
        GutterMode::Off => 0.0,
    }
}

fn terminal_color(color: Color, theme: Theme) -> Hsla {
    match color {
        Color::Spec(color) => rgb24(color.r, color.g, color.b),
        Color::Indexed(index) => indexed_terminal_color(index),
        Color::Named(named) => match named {
            NamedColor::Foreground => theme.text,
            NamedColor::Background => theme.surface,
            NamedColor::Cursor | NamedColor::BrightForeground => rgb(0xffffff).into(),
            NamedColor::DimForeground => theme.text_dim,
            NamedColor::Black => rgb(0x000000).into(),
            NamedColor::Red => rgb(0xcd3131).into(),
            NamedColor::Green => rgb(0x0dbc79).into(),
            NamedColor::Yellow => rgb(0xe5e510).into(),
            NamedColor::Blue => rgb(0x2472c8).into(),
            NamedColor::Magenta => rgb(0xbc3fbc).into(),
            NamedColor::Cyan => rgb(0x11a8cd).into(),
            NamedColor::White => rgb(0xe5e5e5).into(),
            NamedColor::BrightBlack => rgb(0x666666).into(),
            NamedColor::BrightRed => rgb(0xf14c4c).into(),
            NamedColor::BrightGreen => rgb(0x23d18b).into(),
            NamedColor::BrightYellow => rgb(0xf5f543).into(),
            NamedColor::BrightBlue => rgb(0x3b8eea).into(),
            NamedColor::BrightMagenta => rgb(0xd670d6).into(),
            NamedColor::BrightCyan => rgb(0x29b8db).into(),
            NamedColor::BrightWhite => rgb(0xffffff).into(),
            NamedColor::DimBlack => rgb(0x000000).into(),
            NamedColor::DimRed => rgb(0x7f1d1d).into(),
            NamedColor::DimGreen => rgb(0x075f3c).into(),
            NamedColor::DimYellow => rgb(0x737308).into(),
            NamedColor::DimBlue => rgb(0x123964).into(),
            NamedColor::DimMagenta => rgb(0x5e205e).into(),
            NamedColor::DimCyan => rgb(0x085466).into(),
            NamedColor::DimWhite => rgb(0x737373).into(),
        },
    }
}

fn indexed_terminal_color(index: u8) -> Hsla {
    const ANSI: [u32; 16] = [
        0x000000, 0xcd3131, 0x0dbc79, 0xe5e510, 0x2472c8, 0xbc3fbc, 0x11a8cd, 0xe5e5e5, 0x666666,
        0xf14c4c, 0x23d18b, 0xf5f543, 0x3b8eea, 0xd670d6, 0x29b8db, 0xffffff,
    ];
    match index {
        0..=15 => rgb(ANSI[index as usize]).into(),
        16..=231 => {
            let index = index - 16;
            let component = |value: u8| if value == 0 { 0 } else { 55 + value * 40 };
            rgb24(
                component(index / 36),
                component((index % 36) / 6),
                component(index % 6),
            )
        }
        232..=255 => {
            let value = 8 + (index - 232) * 10;
            rgb24(value, value, value)
        }
    }
}

fn rgb24(red: u8, green: u8, blue: u8) -> Hsla {
    rgb(((red as u32) << 16) | ((green as u32) << 8) | blue as u32).into()
}

fn is_paste_keystroke(event: &KeyDownEvent) -> bool {
    let modifiers = event.keystroke.modifiers;
    let key = event.keystroke.key.as_str();
    #[cfg(target_os = "macos")]
    {
        modifiers.platform && key.eq_ignore_ascii_case("v")
    }
    #[cfg(not(target_os = "macos"))]
    {
        modifiers.control && modifiers.shift && key.eq_ignore_ascii_case("v")
    }
}

fn terminal_key_bytes(event: &KeyDownEvent) -> Option<Vec<u8>> {
    let keystroke = &event.keystroke;
    let modifiers = keystroke.modifiers;
    if modifiers.platform {
        return None;
    }
    if modifiers.control {
        let key = keystroke.key.to_ascii_lowercase();
        let control = match key.as_str() {
            "space" | "@" => Some(0),
            "[" => Some(27),
            "\\" => Some(28),
            "]" => Some(29),
            "^" => Some(30),
            "_" => Some(31),
            "?" => Some(127),
            _ if key.len() == 1 => key
                .as_bytes()
                .first()
                .copied()
                .filter(u8::is_ascii_alphabetic)
                .map(|byte| byte.to_ascii_lowercase() - b'a' + 1),
            _ => None,
        };
        if let Some(control) = control {
            return Some(vec![control]);
        }
    }
    let mut bytes = match keystroke.key.as_str() {
        "enter" => b"\r".to_vec(),
        "backspace" => vec![0x7f],
        "tab" if modifiers.shift => b"\x1b[Z".to_vec(),
        "tab" => b"\t".to_vec(),
        "escape" => b"\x1b".to_vec(),
        "up" => b"\x1b[A".to_vec(),
        "down" => b"\x1b[B".to_vec(),
        "right" => b"\x1b[C".to_vec(),
        "left" => b"\x1b[D".to_vec(),
        "home" => b"\x1b[H".to_vec(),
        "end" => b"\x1b[F".to_vec(),
        "insert" => b"\x1b[2~".to_vec(),
        "delete" => b"\x1b[3~".to_vec(),
        "pageup" => b"\x1b[5~".to_vec(),
        "pagedown" => b"\x1b[6~".to_vec(),
        "f1" => b"\x1bOP".to_vec(),
        "f2" => b"\x1bOQ".to_vec(),
        "f3" => b"\x1bOR".to_vec(),
        "f4" => b"\x1bOS".to_vec(),
        "f5" => b"\x1b[15~".to_vec(),
        "f6" => b"\x1b[17~".to_vec(),
        "f7" => b"\x1b[18~".to_vec(),
        "f8" => b"\x1b[19~".to_vec(),
        "f9" => b"\x1b[20~".to_vec(),
        "f10" => b"\x1b[21~".to_vec(),
        "f11" => b"\x1b[23~".to_vec(),
        "f12" => b"\x1b[24~".to_vec(),
        _ => keystroke.key_char.as_ref()?.as_bytes().to_vec(),
    };
    if modifiers.alt {
        bytes.insert(0, 0x1b);
    }
    Some(bytes)
}

fn default_filer_path() -> PathBuf {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn read_local_directory(path: &Path) -> (PathBuf, Vec<LocalEntry>, Option<String>) {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let directory = match std::fs::read_dir(&canonical) {
        Ok(directory) => directory,
        Err(error) => {
            return (
                canonical,
                Vec::new(),
                Some(format!("Could not read folder: {error}")),
            );
        }
    };
    let mut entries = Vec::new();
    for entry in directory.flatten() {
        let metadata = entry.metadata().ok();
        let is_dir = metadata.as_ref().is_some_and(std::fs::Metadata::is_dir);
        entries.push(LocalEntry {
            path: entry.path(),
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir,
            detail: metadata
                .and_then(|metadata| metadata.modified().ok())
                .map(chrono::DateTime::<chrono::Local>::from)
                .map(|modified| modified.format("%Y/%m/%d").to_string())
                .unwrap_or_default(),
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    (canonical, entries, None)
}

fn open_local_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    command
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open {}: {error}", path.display()))
}

fn parse_hex_input(input: &str) -> Result<Vec<u8>, String> {
    let normalized = input
        .split_whitespace()
        .map(|part| {
            part.strip_prefix("0x")
                .or_else(|| part.strip_prefix("0X"))
                .unwrap_or(part)
        })
        .collect::<String>();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }
    if !normalized.len().is_multiple_of(2) {
        return Err("Hex input must contain complete byte pairs".into());
    }
    (0..normalized.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&normalized[index..index + 2], 16)
                .map_err(|_| "Hex input contains a non-hex character".into())
        })
        .collect()
}

fn status_clock() -> String {
    chrono::Local::now().format("%Y/%-m/%-d %H:%M").to_string()
}

impl Render for EdgeTermApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_terminal_size(window);
        let theme = Theme::for_mode(self.theme_mode);
        div()
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(theme.app)
            .text_color(theme.text)
            .font_family(UI_FONT)
            .text_size(px(12.0))
            .child(self.menu_bar(theme, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .when(self.show_sessions, |layout| {
                        layout
                            .child(self.session_panel(theme, window, cx))
                            .child(div().w(px(SPLITTER_SIZE)).h_full().flex_none())
                    })
                    .child(self.center_panel(theme, cx))
                    .when(self.show_filer, |layout| {
                        layout
                            .child(div().w(px(SPLITTER_SIZE)).h_full().flex_none())
                            .child(self.filer_panel(theme, window, cx))
                    }),
            )
            .when(self.show_sender, |layout| {
                layout
                    .child(div().h(px(SPLITTER_SIZE)).w_full().flex_none())
                    .child(self.sender(theme, window, cx))
            })
            .child(self.status_bar(theme))
            .when_some(self.active_menu, |layout, menu| {
                layout.child(self.menu_dropdown(menu, theme, cx))
            })
            .when(self.profile_dialog.is_some(), |layout| {
                layout.child(self.profile_dialog_view(theme, window, cx))
            })
    }
}

#[cfg(test)]
mod tests {
    use gpui::{Keystroke, Modifiers};

    use super::*;

    fn key_event(key: &str, key_char: Option<&str>, modifiers: Modifiers) -> KeyDownEvent {
        KeyDownEvent {
            keystroke: Keystroke {
                key: key.into(),
                key_char: key_char.map(str::to_owned),
                modifiers,
            },
            is_held: false,
        }
    }

    fn test_tab(number: usize, ordinal: usize, profile_id: Option<&str>, name: &str) -> SessionTab {
        let profile = profile_id.map(|id| {
            let mut profile = blank_profile(PROFILE_COLORS[0]);
            profile.id = id.into();
            profile.name = name.into();
            profile.kind = SessionKind::Local;
            profile
        });
        SessionTab {
            id: uuid::Uuid::new_v4().to_string(),
            number,
            ordinal,
            profile,
            name: name.into(),
            terminal: TerminalModel::new(80, 24, None),
            pty: None,
            pty_writer: None,
            connection_generation: 0,
            state: String::new(),
        }
    }

    #[test]
    fn maps_terminal_control_and_navigation_keys() {
        assert_eq!(
            terminal_key_bytes(&key_event(
                "c",
                Some("c"),
                Modifiers {
                    control: true,
                    ..Default::default()
                },
            )),
            Some(vec![3]),
        );
        assert_eq!(
            terminal_key_bytes(&key_event("up", None, Modifiers::default())),
            Some(b"\x1b[A".to_vec()),
        );
        assert_eq!(
            terminal_key_bytes(&key_event("enter", None, Modifiers::default())),
            Some(b"\r".to_vec()),
        );
    }

    #[test]
    fn maps_utf8_text_without_loss() {
        assert_eq!(
            terminal_key_bytes(&key_event("q", Some("你"), Modifiers::default())),
            Some("你".as_bytes().to_vec()),
        );
    }

    #[test]
    fn parses_spaced_prefixed_and_contiguous_hex() {
        assert_eq!(parse_hex_input("48 65 6c 6c 6f").unwrap(), b"Hello");
        assert_eq!(parse_hex_input("0x48 0X69").unwrap(), b"Hi");
        assert_eq!(parse_hex_input("00ff7f").unwrap(), [0, 255, 127]);
    }

    #[test]
    fn rejects_incomplete_or_invalid_hex() {
        assert!(parse_hex_input("abc").is_err());
        assert!(parse_hex_input("0xzz").is_err());
    }

    #[test]
    fn tab_numbers_and_same_profile_ordinals_reuse_the_first_gap() {
        let tabs = vec![
            test_tab(1, 0, Some("profile-a"), "Build"),
            test_tab(3, 2, Some("profile-a"), "Build"),
            test_tab(4, 1, Some("profile-b"), "Build"),
        ];

        assert_eq!(next_tab_number(&tabs), 2);
        assert_eq!(next_tab_ordinal(&tabs, Some("profile-a"), "Build"), 1);
        assert_eq!(next_tab_ordinal(&tabs, Some("profile-b"), "Build"), 0);
    }

    #[test]
    fn temporary_sessions_share_ordinals_by_name() {
        let tabs = vec![
            test_tab(1, 0, None, "Local Shell"),
            test_tab(2, 2, None, "Local Shell"),
        ];

        assert_eq!(next_tab_ordinal(&tabs, None, "Local Shell"), 1);
        assert_eq!(next_tab_ordinal(&tabs, None, "Scratch"), 0);
    }
}
