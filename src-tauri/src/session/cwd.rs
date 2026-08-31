//! Where a session's shell is right now, for the Filer's "Reveal Working
//! Directory in Filer" action (⌘J / Ctrl+Shift+J). Nothing here follows the
//! directory over time: each query answers for the moment it is made, and
//! only when the user asks.
//!
//! A local shell is asked through the OS: the pty's foreground process group
//! is looked up and its working directory read from the kernel
//! (`proc_pidinfo` on macOS, `/proc/<pid>/cwd` on Linux). An SSH shell is
//! asked through the server: a second exec channel on the same connection
//! runs [`REMOTE_CWD_SCRIPT`], which finds the shell by the `SSH_CONNECTION`
//! variable sshd stamps on every process of the connection and reads the
//! working directory of the foreground job on the shell's terminal. The exec
//! channel carries the very same `SSH_CONNECTION` as the shell channel, so
//! nothing about the client side (ports, NAT, jump hosts) has to be known.

use crate::error::{AppError, Result};

/// The working directory of a local shell's foreground job.
#[cfg(unix)]
pub fn local_shell_cwd(
    master: &dyn portable_pty::MasterPty,
    child: &dyn portable_pty::Child,
) -> Result<String> {
    // The foreground process group is what the user is interacting with — a
    // nested shell, or a program started from the shell — so its leader is
    // the process whose directory the Filer should show. The master side of
    // a pty answers TIOCGPGRP on both macOS and Linux (Terminal.app and
    // iTerm2 make the same call).
    let mut candidates = Vec::new();
    if let Some(fd) = master.as_raw_fd() {
        // SAFETY: plain ioctl on a file descriptor the pty keeps open.
        let pgrp = unsafe { libc::tcgetpgrp(fd) };
        if pgrp > 0 {
            candidates.push(pgrp as u32);
        }
    }
    // The group leader may be gone already (the first stage of a pipeline
    // usually exits first); the shell itself is the fallback.
    if let Some(pid) = child.process_id() {
        if !candidates.contains(&pid) {
            candidates.push(pid);
        }
    }
    let mut last_error = AppError::new("the shell has no process to inspect");
    for pid in candidates {
        match process_cwd(pid) {
            Ok(path) => return Ok(path),
            Err(e) => last_error = e,
        }
    }
    Err(last_error)
}

/// Windows keeps a process's working directory in its PEB, which takes a
/// process-memory read to get at; not attempted yet.
#[cfg(windows)]
pub fn local_shell_cwd(
    _master: &dyn portable_pty::MasterPty,
    _child: &dyn portable_pty::Child,
) -> Result<String> {
    Err(AppError::new(
        "reading a shell's working directory is not supported on Windows yet",
    ))
}

/// The working directory of a process of the current user.
#[cfg(target_os = "macos")]
pub fn process_cwd(pid: u32) -> Result<String> {
    use std::mem::{size_of, size_of_val, MaybeUninit};

    let mut info = MaybeUninit::<libc::proc_vnodepathinfo>::uninit();
    let size = size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    // SAFETY: the buffer is exactly the struct this flavor fills, and its
    // size is passed along.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written < size {
        return Err(AppError::new(format!(
            "cannot read the working directory of process {pid}: {}",
            std::io::Error::last_os_error()
        )));
    }
    // SAFETY: proc_pidinfo reported that it filled the whole struct.
    let info = unsafe { info.assume_init() };
    let path = &info.pvi_cdir.vip_path;
    // SAFETY: vip_path is MAXPATHLEN bytes holding a NUL-terminated C string
    // (libc declares it as [[c_char; 32]; 32] for old compilers).
    let bytes = unsafe { std::slice::from_raw_parts(path.as_ptr().cast::<u8>(), size_of_val(path)) };
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    Ok(String::from_utf8_lossy(&bytes[..end]).into_owned())
}

/// The working directory of a process of the current user.
#[cfg(target_os = "linux")]
pub fn process_cwd(pid: u32) -> Result<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| {
            AppError::new(format!(
                "cannot read the working directory of process {pid}: {e}"
            ))
        })
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub fn process_cwd(pid: u32) -> Result<String> {
    Err(AppError::new(format!(
        "reading the working directory of process {pid} is not supported on this platform"
    )))
}

/// This machine's host name, for telling a local shell's OSC 7 report from
/// one relayed by a remote shell the user ssh'd into by hand.
#[cfg(unix)]
pub fn local_hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer and its length are passed together; gethostname
    // NUL-terminates whenever the name fits.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).into_owned()
}

#[cfg(windows)]
pub fn local_hostname() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_default()
}

/// Prefix of the one stdout line of [`REMOTE_CWD_SCRIPT`] that carries the
/// answer, so anything a login shell's rc file prints (Debian's bash sources
/// `~/.bashrc` for commands run over ssh) cannot be mistaken for it.
const REMOTE_CWD_MARKER: &str = "EDGETERM-CWD ";

/// POSIX `sh` script run on the server, fed through stdin of `sh` so the
/// user's login shell (sshd runs the command through it) never parses it.
///
/// It finds the processes of this SSH connection by the exact
/// `SSH_CONNECTION` value of its own environment — `grep -l` over
/// `/proc/*/environ` narrows the field in one pass, the `tr | grep -x`
/// check then rules out a longer value with the same prefix — keeps the one
/// that has a controlling terminal (that is the shell channel; exec
/// channels have none), and reads the working directory of the foreground
/// process group of that terminal, so a nested shell or a program started
/// from the shell is answered for. Exit codes are mapped in
/// [`parse_remote_cwd`]. Everything used is in busybox as well.
pub const REMOTE_CWD_SCRIPT: &str = r#"LC_ALL=C
export LC_ALL
[ -r /proc/$$/environ ] || exit 4
needle=$(tr '\000' '\n' < /proc/$$/environ | grep '^SSH_CONNECTION=') || exit 2
for f in $(grep -lF -- "$needle" /proc/[0-9]*/environ 2>/dev/null); do
  d=${f%/environ}
  [ "$d" = "/proc/$$" ] && continue
  tr '\000' '\n' < "$d/environ" 2>/dev/null | grep -qxF -- "$needle" || continue
  set -- $(sed 's/^.*) //' "$d/stat" 2>/dev/null)
  [ "${5:-0}" != 0 ] || continue
  cwd=$(readlink "/proc/$6/cwd") || exit 3
  printf 'EDGETERM-CWD %s\n' "$cwd"
  exit 0
done
exit 1
"#;

/// Reads the answer of [`REMOTE_CWD_SCRIPT`] out of what the exec channel
/// returned.
pub fn parse_remote_cwd(stdout: &str, stderr: &str, exit_status: Option<u32>) -> Result<String> {
    if let Some(path) = stdout
        .lines()
        .rev()
        .find_map(|line| line.strip_prefix(REMOTE_CWD_MARKER))
    {
        if !path.is_empty() {
            return Ok(path.to_string());
        }
    }
    let reason = match exit_status {
        Some(1) => "no shell of this connection was found on the server".to_string(),
        Some(2) => "the server did not set SSH_CONNECTION, so the shell cannot be located".to_string(),
        Some(3) => "the foreground process cannot be inspected (running as another user via sudo / su?)".to_string(),
        Some(4) => "the server has no /proc filesystem; only Linux hosts can be asked".to_string(),
        Some(code) => format!("the query exited with status {code}"),
        None => "the server sent no answer".to_string(),
    };
    let detail = stderr.trim();
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!(" ({detail})")
    };
    Err(AppError::new(format!(
        "{reason}{detail}; a shell that reports its directory with OSC 7 is answered everywhere"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_takes_the_marker_line_and_ignores_rc_noise() {
        let out = "Welcome banner from .bashrc\nEDGETERM-CWD /srv/www/app\n";
        assert_eq!(parse_remote_cwd(out, "", Some(0)).unwrap(), "/srv/www/app");
        // Spaces inside the path survive; CRLF from a pty-less channel does
        // not occur, but a stray CR would be stripped by `lines()` anyway.
        let out = "EDGETERM-CWD /home/me/my docs\n";
        assert_eq!(parse_remote_cwd(out, "", Some(0)).unwrap(), "/home/me/my docs");
    }

    #[test]
    fn parse_maps_exit_codes_to_reasons() {
        let no_proc = parse_remote_cwd("", "", Some(4)).unwrap_err().to_string();
        assert!(no_proc.contains("no /proc"), "{no_proc}");
        let other_user = parse_remote_cwd("", "", Some(3)).unwrap_err().to_string();
        assert!(other_user.contains("sudo"), "{other_user}");
        let none = parse_remote_cwd("", "sh: not found", None).unwrap_err().to_string();
        assert!(none.contains("no answer") && none.contains("sh: not found"), "{none}");
        // A marker with nothing after it is not an answer either.
        assert!(parse_remote_cwd("EDGETERM-CWD \n", "", Some(0)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn remote_script_is_valid_posix_sh() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut sh = Command::new("sh")
            .arg("-n")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh");
        sh.stdin
            .take()
            .expect("stdin")
            .write_all(REMOTE_CWD_SCRIPT.as_bytes())
            .expect("write script");
        let output = sh.wait_with_output().expect("wait sh");
        assert!(
            output.status.success(),
            "sh -n rejected the script: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(REMOTE_CWD_SCRIPT.contains(REMOTE_CWD_MARKER));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn process_cwd_reads_a_child_process_directory() {
        let dir = std::env::temp_dir().join(format!("edgeterm-cwd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create dir");
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .current_dir(&dir)
            .spawn()
            .expect("spawn sleep");
        let cwd = process_cwd(child.id());
        let _ = child.kill();
        let _ = child.wait();
        let expected = dir.canonicalize().expect("canonicalize");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(cwd.expect("cwd"), expected.to_string_lossy());
        assert!(process_cwd(u32::MAX - 1).is_err());
    }
}
