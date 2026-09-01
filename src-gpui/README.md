# EdgeTerm GPUI frontend

This directory contains the native GPUI rewrite. The existing Tauri frontend
remains runnable while features move across, so the migration can be tested on
macOS, Windows, Wayland and X11 without blocking regular EdgeTerm releases.

GPUI is pinned to the latest published release because its public API is still
pre-1.0. Record macOS, Windows, Wayland and X11 verification when advancing the
version.

## Run

```sh
cargo run --manifest-path src-gpui/Cargo.toml
```

The scaffold enables GPUI's `runtime_shaders` feature, so local debug builds
work with Apple's Command Line Tools alone. Release CI should eventually use
full Xcode and precompile the Metal shader library by removing that feature.

## Current migration slice

- A real local PTY starts with the user's default shell.
- `alacritty_terminal` owns the ANSI/VT grid, colors, cursor and scrollback.
- The terminal gutter tracks absolute scrollback line numbers and per-line
  timestamps, hides itself in alternate-screen programs, and supports the four
  display modes from the Tauri application.
- Keyboard input, control/navigation keys and clipboard paste are sent to the
  PTY; bracketed paste is respected when requested by the shell application.
- Terminal and PTY dimensions follow the GPUI window size.
- The local shell can be disconnected, restarted and reconnected without
  restarting the application or losing its terminal buffer.
- Local shells run in independent tabs. Switching tabs preserves each PTY and
  scrollback; tab numbers and repeated-session suffixes stay fixed until close.
- Saved profiles load from the existing EdgeTerm store. The native session
  editor can create, update and delete profiles, and saved local profiles open
  directly in a new terminal tab.
- The Filer reads the real local filesystem, supports path entry, back/up/home/
  refresh navigation, row selection, double-click folder navigation and opening
  files with the platform default application.
- Sender accepts editable text or hexadecimal bytes, cycles line endings, sends
  on Enter or click, and keeps the preset command buttons.
- Session filtering, application menus, light/dark theme switching and the
  Sessions/Filer/Sender panel visibility controls are interactive.

SSH/SFTP/FTP/serial transports, terminal selection/search, IME composition and
mutating file operations are still served only by the existing Tauri
application and will move in later slices. Their saved profiles can already be
managed in the GPUI session editor, but cannot connect yet.
