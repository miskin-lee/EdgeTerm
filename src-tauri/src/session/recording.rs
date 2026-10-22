//! Session recording: the bytes a terminal session receives, written to a
//! file as they arrive.
//!
//! A profile with `record` set gets one file per connection, opened by
//! `Recorder::start` when the session comes up and closed when the session
//! ends. The file holds the raw output stream — escape sequences included,
//! so `cat` replays it in a terminal — between a PuTTY-style header and
//! trailer line that name the session and the times. Only output is
//! recorded; keystrokes reach the file through the far end's echo, so a
//! password typed without echo never lands in it.
//!
//! Writing happens on a thread of its own: the session's read loop (a pty
//! thread, the SSH task, the serial owner thread) only pushes the chunk on
//! a channel and goes back to reading, so a slow disk never stalls the
//! terminal. Every batch is flushed to the OS as soon as the channel is
//! drained, so an application exit loses nothing that was already on
//! screen. A write failure (disk full, folder removed) stops the recording
//! and is logged once; the session itself carries on.

use std::fs::{self, File};
use std::io::{BufWriter, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};

use chrono::{DateTime, Local};

use crate::error::{AppError, Result};
use crate::model::SessionProfile;
use crate::store;

/// Extension of every recording; the contents are the raw byte stream.
const EXTENSION: &str = "log";
/// Longest profile name kept in a file name, so a path stays well inside
/// every platform's limits with the time stamp and a counter added.
const MAX_STEM_CHARS: usize = 64;
/// How many same-second recordings of one profile are told apart by a
/// counter before giving up; more than that is not a real situation.
const MAX_SAME_SECOND: u32 = 1000;

/// Where recordings go when the profile names no folder: next to the
/// configuration in a portable copy, otherwise a folder of the user's
/// Documents (their home when the platform has none), which is where a
/// person looks for a file they made rather than the hidden config dir.
pub fn default_dir() -> PathBuf {
    if let Some(data) = store::portable_data_dir() {
        return data.join("recordings");
    }
    dirs::document_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("EdgeTerm Recordings")
}

/// One recording in progress. Dropping it ends the recording: the writer
/// thread writes the trailer, flushes and exits.
pub struct Recorder {
    tx: Sender<Vec<u8>>,
}

impl Recorder {
    /// Opens the recording for session `id` in the profile's folder (or the
    /// default one) and starts the thread that writes it. An unusable folder
    /// or file is an error rather than a silently unrecorded session: the
    /// user asked for the file and would only find out it was missing later.
    pub fn start(id: &str, profile: &SessionProfile) -> Result<Recorder> {
        let dir = profile
            .record_dir
            .as_deref()
            .map(str::trim)
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_dir);
        let now = Local::now();
        fs::create_dir_all(&dir).map_err(|e| {
            AppError::new(format!(
                "cannot create the recording folder {}: {e}",
                dir.display()
            ))
        })?;
        let (path, file) = create_file(&dir, &file_stem(&profile.name), &now)?;

        let header = format!(
            "==== EdgeTerm: {} ({} {}) — recording started {} ====\r\n",
            profile.name,
            profile.protocol(),
            profile.address(),
            stamp(&now)
        );
        let (tx, rx) = mpsc::channel();
        let writer = Writer {
            rx,
            out: BufWriter::with_capacity(64 * 1024, file),
            path,
        };
        std::thread::Builder::new()
            .name(format!("edgeterm-record-{id}"))
            .spawn(move || writer.run(header))
            .map_err(|e| AppError::new(format!("cannot start the recording thread: {e}")))?;
        Ok(Recorder { tx })
    }

    /// Queues output for the file. Never blocks; after a write failure the
    /// thread is gone and the bytes are dropped.
    pub fn write(&self, bytes: &[u8]) {
        if !bytes.is_empty() {
            let _ = self.tx.send(bytes.to_vec());
        }
    }
}

struct Writer {
    rx: Receiver<Vec<u8>>,
    out: BufWriter<File>,
    path: PathBuf,
}

impl Writer {
    fn run(mut self, header: String) {
        if let Err(e) = self.write_flushed(header.as_bytes()) {
            self.report(&e);
            return;
        }
        while let Ok(mut bytes) = self.rx.recv() {
            // Everything queued behind the chunk goes out in the same write,
            // and the batch is flushed once the queue is empty, so a burst
            // costs one syscall and nothing waits in the buffer afterwards.
            while let Ok(more) = self.rx.try_recv() {
                bytes.extend_from_slice(&more);
            }
            if let Err(e) = self.write_flushed(&bytes) {
                self.report(&e);
                return;
            }
        }
        let trailer = format!("\r\n==== recording ended {} ====\r\n", stamp(&Local::now()));
        if let Err(e) = self.write_flushed(trailer.as_bytes()) {
            self.report(&e);
        }
    }

    fn write_flushed(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.out.write_all(bytes)?;
        self.out.flush()
    }

    /// Every failure ends the thread, so this runs at most once.
    fn report(&self, error: &std::io::Error) {
        eprintln!(
            "EdgeTerm: recording stopped, cannot write {}: {error}",
            self.path.display()
        );
    }
}

fn stamp(time: &DateTime<Local>) -> String {
    time.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// Creates `<stem>_<YYYYMMDD>_<HHMMSS>.log` in `dir`, exclusively so two
/// sessions of one profile opened in the same second get separate files
/// (`…_2.log`, `…_3.log`) rather than interleaving in one.
fn create_file(dir: &Path, stem: &str, time: &DateTime<Local>) -> Result<(PathBuf, File)> {
    let base = format!("{stem}_{}", time.format("%Y%m%d_%H%M%S"));
    for attempt in 1..=MAX_SAME_SECOND {
        let name = if attempt == 1 {
            format!("{base}.{EXTENSION}")
        } else {
            format!("{base}_{attempt}.{EXTENSION}")
        };
        let path = dir.join(name);
        match File::options().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(AppError::new(format!(
                    "cannot create the recording {}: {e}",
                    path.display()
                )))
            }
        }
    }
    Err(AppError::new(format!(
        "cannot create a recording in {}: too many files of the same second",
        dir.display()
    )))
}

/// The profile name as the start of a file name: characters no file system
/// or shell is happy with become `_`, surrounding whitespace and dots go
/// (a leading dot hides the file, a trailing one is dropped on Windows),
/// and an empty result is called `session`.
pub(crate) fn file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem: String = cleaned
        .trim_matches(|c: char| c.is_whitespace() || c == '.')
        .chars()
        .take(MAX_STEM_CHARS)
        .collect();
    let stem = stem.trim_end_matches(|c: char| c.is_whitespace() || c == '.');
    if stem.is_empty() {
        "session".to_string()
    } else {
        stem.to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::model::SessionKind;

    fn scratch_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("edgeterm-rec-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The file once the writer thread has closed it: the trailer is the
    /// last thing written, so its presence means everything before it is
    /// on disk too.
    fn wait_for_trailer(path: &Path) -> Vec<u8> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let contents = fs::read(path).unwrap_or_default();
            if contents.ends_with(b"====\r\n")
                && contents.windows(15).any(|w| w == b"recording ended")
            {
                return contents;
            }
            assert!(Instant::now() < deadline, "the recording was never closed");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn records_the_raw_output_between_header_and_trailer() {
        let dir = scratch_dir();
        let mut profile = crate::tests::profile(SessionKind::Local);
        profile.name = "rec: test".into();
        profile.record = true;
        profile.record_dir = Some(dir.display().to_string());

        let recorder = Recorder::start("s1", &profile).expect("start recording");
        // The profile's folder was empty, so the one file in it is the recording.
        let files: Vec<PathBuf> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1, "{files:?}");
        let path = files[0].clone();
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("rec_ test_"), "{name}");
        assert!(name.ends_with(".log"), "{name}");

        recorder.write(b"hello ");
        recorder.write(b"");
        recorder.write(b"\x1b[31mworld\x1b[0m\r\n");
        drop(recorder);

        let contents = wait_for_trailer(&path);
        let text = String::from_utf8_lossy(&contents);
        assert!(
            text.starts_with("==== EdgeTerm: rec: test (shell "),
            "header: {text}"
        );
        assert!(text.contains("recording started"), "{text}");
        let body_start = text.find("====\r\n").unwrap() + "====\r\n".len();
        assert!(
            text[body_start..]
                .starts_with("hello \x1b[31mworld\x1b[0m\r\n\r\n==== recording ended "),
            "body: {:?}",
            &text[body_start..]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_empty_folder_field_means_the_default_and_a_bad_one_is_an_error() {
        let mut profile = crate::tests::profile(SessionKind::Serial);
        profile.record = true;
        // A file where the folder should be: create_dir_all fails on it.
        let dir = scratch_dir();
        let blocker = dir.join("not-a-folder");
        fs::write(&blocker, b"x").unwrap();
        profile.record_dir = Some(blocker.display().to_string());
        let error = Recorder::start("s2", &profile)
            .err()
            .expect("a file in the folder's place must fail");
        assert!(error.0.contains("recording folder"), "{error}");
        fs::remove_dir_all(&dir).unwrap();

        // Blank means the default folder; only the choice of path is checked
        // here, since the default lives in the user's Documents.
        profile.record_dir = Some("   ".into());
        let dir = profile
            .record_dir
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(default_dir);
        assert_eq!(dir, default_dir());
        assert!(
            default_dir().ends_with("EdgeTerm Recordings") || default_dir().ends_with("recordings")
        );
    }

    #[test]
    fn file_stem_is_safe_on_every_platform() {
        assert_eq!(file_stem("prod db"), "prod db");
        assert_eq!(file_stem("user@host:22/tty"), "user@host_22_tty");
        assert_eq!(file_stem(" .hidden. "), "hidden");
        assert_eq!(file_stem("a\u{7}b\"c<d>e|f*g?h\\i"), "a_b_c_d_e_f_g_h_i");
        assert_eq!(file_stem(""), "session");
        assert_eq!(file_stem("..."), "session");
        assert_eq!(file_stem("中文 会话"), "中文 会话");
        let long = "x".repeat(200);
        assert_eq!(file_stem(&long).chars().count(), MAX_STEM_CHARS);
    }

    #[test]
    fn same_second_recordings_get_separate_files() {
        let dir = scratch_dir();
        let now = Local::now();
        let (first, _) = create_file(&dir, "s", &now).unwrap();
        let (second, _) = create_file(&dir, "s", &now).unwrap();
        let (third, _) = create_file(&dir, "s", &now).unwrap();
        let base = format!("s_{}", now.format("%Y%m%d_%H%M%S"));
        assert_eq!(
            first.file_name().unwrap().to_str().unwrap(),
            format!("{base}.log")
        );
        assert_eq!(
            second.file_name().unwrap().to_str().unwrap(),
            format!("{base}_2.log")
        );
        assert_eq!(
            third.file_name().unwrap().to_str().unwrap(),
            format!("{base}_3.log")
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
