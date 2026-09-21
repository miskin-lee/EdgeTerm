//! Startup workaround for the Linux + NVIDIA Wayland crash
//! (Gdk-Message: Error 71, KWin "error in client communication").
//!
//! Root cause: WebKitGTK's DMA-BUF renderer enables Wayland explicit sync
//! (`wp_linux_drm_syncobj_manager_v1`) on the window surface, while GTK3
//! commits CPU (`wl_shm`) buffers on the same surface without an acquire
//! point. Strict compositors (KWin) kill the connection. See GTK work item
//! #8056 (patch not merged) and WebKit bug #324551.
//!
//! We only act on the exact crashing combination — NVIDIA proprietary driver
//! on the primary GPU under Wayland — and only when the user has not already
//! set one of the escape-hatch variables. Anything we fail to detect means we
//! set nothing: a crash is preferable to disabling rendering features for
//! users on setups we misunderstood.
//!
//! Remove this module once an upstream fix ships in a WebKitGTK release we
//! can require.

use std::path::Path;

/// Primary-GPU identity as read from sysfs: PCI vendor id and the last
/// segment of the `driver` symlink target.
#[derive(Debug, PartialEq)]
struct GpuInfo {
    vendor: String,
    driver: String,
}

const WEBKIT_DISABLE_DMABUF_RENDERER: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const NV_DISABLE_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";

/// Variables a user or distribution may set to steer WebKit/GTK rendering
/// themselves. Any of them being set (non-empty) means we stay out of it.
const ESCAPE_HATCH_VARS: [&str; 4] = [
    WEBKIT_DISABLE_DMABUF_RENDERER,
    NV_DISABLE_EXPLICIT_SYNC,
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "WEBKIT_DMABUF_RENDERER_FORCE_SHM",
];

/// An empty value counts as unset: the NVIDIA driver treats it that way too.
fn is_set(value: Option<String>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// Read the primary GPU (the card with `boot_vga == 1`) from a sysfs root
/// such as `/sys/class/drm`. Connector directories (`card0-DP-1`, matched by
/// the same `card*` prefix) have no `device` subpath and are skipped. The
/// `driver` entry is a symlink to the driver directory, so it must be resolved
/// with `read_link`; reading it as a file fails with EISDIR.
fn collect(sysfs_root: &Path) -> Option<GpuInfo> {
    for entry in std::fs::read_dir(sysfs_root).ok()?.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("card") {
            continue;
        }
        let device = entry.path().join("device");
        if !device.is_dir() {
            continue;
        }
        // A card* entry with a device/ but no boot_vga (platform DRM devices
        // such as tegra or simpledrm, virtio-gpu) cannot be judged from here:
        // look at the next card instead of giving up on the whole scan.
        let Ok(boot_vga) = std::fs::read_to_string(device.join("boot_vga")) else {
            continue;
        };
        if boot_vga.trim() != "1" {
            continue;
        }
        let vendor = std::fs::read_to_string(device.join("vendor")).ok()?;
        let driver = std::fs::read_link(device.join("driver")).ok()?;
        return Some(GpuInfo {
            vendor: vendor.trim().to_string(),
            driver: driver.file_name()?.to_string_lossy().into_owned(),
        });
    }
    None
}

#[derive(PartialEq, Eq, Debug)]
enum SessionType {
    Wayland,
    X11,
}

/// Session type from the environment: `GDK_BACKEND` first (comma-separated;
/// take the first entry we recognise, ignore the rest), then
/// `XDG_SESSION_TYPE`, then presence of `WAYLAND_DISPLAY` / `DISPLAY`.
fn session_type(env: &dyn Fn(&str) -> Option<String>) -> Option<SessionType> {
    if let Some(backends) = env("GDK_BACKEND") {
        for backend in backends.split(',') {
            match backend.trim() {
                "wayland" => return Some(SessionType::Wayland),
                "x11" => return Some(SessionType::X11),
                _ => {}
            }
        }
    }
    if let Some(value) = env("XDG_SESSION_TYPE") {
        match value.trim() {
            "wayland" => return Some(SessionType::Wayland),
            "x11" => return Some(SessionType::X11),
            _ => {}
        }
    }
    if is_set(env("WAYLAND_DISPLAY")) {
        return Some(SessionType::Wayland);
    }
    if is_set(env("DISPLAY")) {
        return Some(SessionType::X11);
    }
    None
}

/// Hyprland kills the connection outright (WebKit bug #280210) and can hit a
/// NVIDIA EGL/GBM SIGSEGV, so it gets the harsher workaround: disable the
/// DMA-BUF renderer entirely. Detected via the desktop variables (split on
/// `:`/`;`/`,`, case-insensitive) or a `hyprland/` socket dir under
/// `XDG_RUNTIME_DIR`.
fn is_hyprland(env: &dyn Fn(&str) -> Option<String>, path_exists: &dyn Fn(&Path) -> bool) -> bool {
    for key in ["XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP"] {
        if let Some(value) = env(key) {
            if value
                .split([':', ';', ','])
                .any(|part| part.trim().eq_ignore_ascii_case("hyprland"))
            {
                return true;
            }
        }
    }
    // An empty value would make the join() below a cwd-relative path.
    env("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .is_some_and(|dir| path_exists(&Path::new(&dir).join("hyprland")))
}

/// Pure decision: return the variable to set, or `None` to set nothing.
/// `env` abstracts the process environment so the whole matrix is testable.
fn plan(
    env: &dyn Fn(&str) -> Option<String>,
    path_exists: &dyn Fn(&Path) -> bool,
    gpu: &GpuInfo,
) -> Option<&'static str> {
    // The user already steers WebKit/GTK rendering; respect that. (For the
    // X11-with-GDK_BACKEND=wayland false positive below this also applies:
    // __NV_DISABLE_EXPLICIT_SYNC has no effect on X11, so being wrong there
    // is harmless.)
    if ESCAPE_HATCH_VARS.iter().any(|name| is_set(env(name))) {
        return None;
    }
    // Only the proprietary driver is affected; nouveau does not enable
    // explicit sync the same way.
    if gpu.vendor != "0x10de" || gpu.driver != "nvidia" {
        return None;
    }
    match session_type(env) {
        Some(SessionType::Wayland) if is_hyprland(env, path_exists) => {
            Some(WEBKIT_DISABLE_DMABUF_RENDERER)
        }
        Some(SessionType::Wayland) => Some(NV_DISABLE_EXPLICIT_SYNC),
        // X11 does not take this crash path, and disabling DMA-BUF there
        // would also lose WebGL (WebKit #324549) and semantic coloring;
        // leave it alone.
        Some(SessionType::X11) | None => None,
    }
}

/// Set the workaround variable, if the crashing combination is detected.
/// Runs at the very start of `run()`: single-threaded, before GTK/WebKit/EGL
/// are initialised. Detection failures are silent by design (see plan()).
pub fn apply() {
    let env = |name: &str| std::env::var(name).ok();
    let path_exists = |path: &Path| path.exists();
    let Some(gpu) = collect(Path::new("/sys/class/drm")) else {
        return;
    };
    let Some(name) = plan(&env, &path_exists, &gpu) else {
        return;
    };
    // std::env::set_var becomes unsafe in edition 2024; revisit if the crate
    // is bumped.
    std::env::set_var(name, "1");
    eprintln!(
        "edgeterm: set {name}=1 (NVIDIA primary GPU on Wayland; workaround for \
GTK work item #8056 / WebKit bug #324551)"
    );
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "edgeterm-nvidia-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Fake one card in a sysfs tree. `driver` must be a symlink, exactly as
    /// in the real sysfs, so read_link resolution is exercised.
    fn fake_card(root: &Path, vendor: &str, boot_vga: &str, driver: &str) {
        let device = root.join("card0/device");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("vendor"), format!("{vendor}\n")).unwrap();
        std::fs::write(device.join("boot_vga"), format!("{boot_vga}\n")).unwrap();
        std::os::unix::fs::symlink(
            format!("/sys/bus/pci/drivers/{driver}"),
            device.join("driver"),
        )
        .unwrap();
    }

    fn env_from<'a>(map: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            map.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        }
    }

    fn no_paths(_: &Path) -> bool {
        false
    }

    fn nvidia_gpu() -> GpuInfo {
        GpuInfo {
            vendor: "0x10de".into(),
            driver: "nvidia".into(),
        }
    }

    #[test]
    fn kwin_wayland_nvidia_sets_explicit_sync() {
        let env = env_from(&[
            ("XDG_SESSION_TYPE", "wayland"),
            ("XDG_CURRENT_DESKTOP", "KDE"),
        ]);
        // Literal on purpose: the NVIDIA driver only reads the exact variable
        // name, so a typo in the constant must fail right here.
        assert_eq!(
            plan(&env, &no_paths, &nvidia_gpu()),
            Some("__NV_DISABLE_EXPLICIT_SYNC")
        );
    }

    #[test]
    fn hyprland_desktop_sets_dmabuf_renderer() {
        let env = env_from(&[
            ("XDG_SESSION_TYPE", "wayland"),
            ("XDG_CURRENT_DESKTOP", "Hyprland"),
        ]);
        assert_eq!(
            plan(&env, &no_paths, &nvidia_gpu()),
            Some(WEBKIT_DISABLE_DMABUF_RENDERER)
        );
    }

    #[test]
    fn hyprland_runtime_dir_sets_dmabuf_renderer() {
        let env = env_from(&[
            ("XDG_SESSION_TYPE", "wayland"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ]);
        let paths = |p: &Path| p == Path::new("/run/user/1000/hyprland");
        assert_eq!(
            plan(&env, &paths, &nvidia_gpu()),
            Some(WEBKIT_DISABLE_DMABUF_RENDERER)
        );
    }

    #[test]
    fn x11_sets_nothing() {
        let env = env_from(&[("XDG_SESSION_TYPE", "x11")]);
        assert_eq!(plan(&env, &no_paths, &nvidia_gpu()), None);
    }

    #[test]
    fn unknown_session_sets_nothing() {
        let env = env_from(&[("XDG_SESSION_TYPE", "tty")]);
        assert_eq!(plan(&env, &no_paths, &nvidia_gpu()), None);
        assert_eq!(plan(&env_from(&[]), &no_paths, &nvidia_gpu()), None);
    }

    #[test]
    fn non_nvidia_gpu_sets_nothing() {
        let env = env_from(&[("XDG_SESSION_TYPE", "wayland")]);
        let intel = GpuInfo {
            vendor: "0x8086".into(),
            driver: "i915".into(),
        };
        assert_eq!(plan(&env, &no_paths, &intel), None);
        let nouveau = GpuInfo {
            vendor: "0x10de".into(),
            driver: "nouveau".into(),
        };
        assert_eq!(plan(&env, &no_paths, &nouveau), None);
    }

    #[test]
    fn escape_hatch_var_blocks_the_workaround() {
        let session = &[("XDG_SESSION_TYPE", "wayland")];
        for name in ESCAPE_HATCH_VARS {
            let mut map = session.to_vec();
            map.push((name, "1"));
            let env = env_from(&map);
            assert_eq!(plan(&env, &no_paths, &nvidia_gpu()), None, "{name}");
        }
    }

    #[test]
    fn empty_escape_hatch_value_counts_as_unset() {
        let env = env_from(&[
            ("XDG_SESSION_TYPE", "wayland"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", ""),
        ]);
        assert_eq!(
            plan(&env, &no_paths, &nvidia_gpu()),
            Some(NV_DISABLE_EXPLICIT_SYNC)
        );
    }

    #[test]
    fn gdk_backend_first_recognised_entry_wins() {
        let gpu = nvidia_gpu();
        let wayland = env_from(&[("GDK_BACKEND", "wayland,x11")]);
        assert_eq!(plan(&wayland, &no_paths, &gpu), Some(NV_DISABLE_EXPLICIT_SYNC));
        let x11 = env_from(&[("GDK_BACKEND", "x11")]);
        assert_eq!(plan(&x11, &no_paths, &gpu), None);
        // Unknown entries are skipped until one is recognised.
        let mixed = env_from(&[("GDK_BACKEND", "foo,wayland")]);
        assert_eq!(plan(&mixed, &no_paths, &gpu), Some(NV_DISABLE_EXPLICIT_SYNC));
        let unknown_only = env_from(&[("GDK_BACKEND", "foo,bar")]);
        assert_eq!(plan(&unknown_only, &no_paths, &gpu), None);
    }

    #[test]
    fn collect_reads_primary_nvidia_card() {
        let root = temp_dir("collect");
        fake_card(&root, "0x10de", "1", "nvidia");
        let gpu = collect(&root).expect("primary nvidia card");
        assert_eq!(gpu.vendor, "0x10de");
        assert_eq!(gpu.driver, "nvidia");
    }

    #[test]
    fn collect_skips_connector_dirs_and_secondary_cards() {
        let root = temp_dir("connector");
        // Connector directory from the same card* glob: no device subpath.
        std::fs::create_dir_all(root.join("card0-DP-1")).unwrap();
        // Secondary GPU without boot_vga == 1.
        fake_card(&root, "0x8086", "0", "i915");
        assert_eq!(collect(&root), None);
    }

    #[test]
    fn collect_fails_when_boot_vga_is_missing() {
        let root = temp_dir("no-boot-vga");
        let device = root.join("card0/device");
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("vendor"), "0x10de\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/nvidia", device.join("driver")).unwrap();
        assert_eq!(collect(&root), None);
    }

    #[test]
    fn collect_fails_when_sysfs_root_is_unreadable() {
        assert_eq!(collect(&temp_dir("missing").join("nope")), None);
    }

    #[test]
    fn display_vars_fall_back_to_session_type() {
        let gpu = nvidia_gpu();
        let wayland = env_from(&[("WAYLAND_DISPLAY", "wayland-0")]);
        assert_eq!(
            plan(&wayland, &no_paths, &gpu),
            Some(NV_DISABLE_EXPLICIT_SYNC)
        );
        let x11 = env_from(&[("DISPLAY", ":0")]);
        assert_eq!(plan(&x11, &no_paths, &gpu), None);
    }

    #[test]
    fn empty_xdg_runtime_dir_does_not_probe_relative_paths() {
        // An empty XDG_RUNTIME_DIR would make the Hyprland probe cwd-relative;
        // the matcher below would report a match if the probe ran anyway.
        let env = env_from(&[("XDG_SESSION_TYPE", "wayland"), ("XDG_RUNTIME_DIR", "")]);
        let paths = |p: &Path| p == Path::new("hyprland");
        assert_eq!(
            plan(&env, &paths, &nvidia_gpu()),
            Some(NV_DISABLE_EXPLICIT_SYNC)
        );
    }

    #[test]
    fn collect_skips_unjudgeable_cards_and_connectors_before_the_primary() {
        let root = temp_dir("skip-ahead");
        // Connector entry from the same card* glob: no device subpath.
        std::fs::create_dir_all(root.join("card0-DP-1")).unwrap();
        // A card whose device/ has no boot_vga cannot be judged.
        let unjudgeable = root.join("card1/device");
        std::fs::create_dir_all(&unjudgeable).unwrap();
        std::fs::write(unjudgeable.join("vendor"), "0x10de\n").unwrap();
        // The real primary card comes last.
        let primary = root.join("card2/device");
        std::fs::create_dir_all(&primary).unwrap();
        std::fs::write(primary.join("vendor"), "0x10de\n").unwrap();
        std::fs::write(primary.join("boot_vga"), "1\n").unwrap();
        std::os::unix::fs::symlink("/sys/bus/pci/drivers/nvidia", primary.join("driver"))
            .unwrap();
        let gpu = collect(&root).expect("primary card after skippable entries");
        assert_eq!(gpu.vendor, "0x10de");
        assert_eq!(gpu.driver, "nvidia");
    }
}
