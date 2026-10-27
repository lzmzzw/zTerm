//! Capture the launching Explorer folder before Tauri creates or focuses a window.
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};

use windows::{
    core::{w, Interface},
    Win32::{
        Foundation::HWND,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IServiceProvider,
                CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
            },
            Threading::{GetStartupInfoW, STARTUPINFOW},
            Variant::VARIANT,
        },
        UI::{
            Shell::{
                IFolderView, IPersistFolder2, IShellBrowser, IShellWindows, IWebBrowser2,
                SHGetPathFromIDListEx, SID_STopLevelBrowser, ShellWindows, GPFIDL_DEFAULT,
            },
            WindowsAndMessaging::{
                FindWindowExW, GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
                IsWindowVisible,
            },
        },
    },
};

/// Single-instance forwarding reads the new process's cwd itself. Normalize it
/// before installing that plugin, so cold and warm launches carry the same path.
pub fn prepare_working_directory() {
    let mut diagnostic = LaunchDiagnostic::default();
    if std::env::args_os().len() != 1 {
        diagnostic.stage = "explicit_arguments";
        diagnostic.save_if_enabled();
        return; // Explicit --open-local and other launch arguments retain priority.
    }
    let explorer = launching_explorer_directory(&mut diagnostic);
    diagnostic.directory_resolved = explorer.is_some();
    let current = std::env::current_dir()
        .ok()
        .and_then(|path| dunce::canonicalize(path).ok());
    let install = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().and_then(|path| dunce::canonicalize(path).ok()));
    let directory = startup_directory(
        explorer,
        current.as_deref(),
        install.as_deref(),
        dirs::home_dir(),
    );
    if let Some(directory) = directory {
        diagnostic.directory_matches_inherited = current.as_ref() == Some(&directory);
        if let Err(error) = std::env::set_current_dir(directory) {
            diagnostic.directory_set_failed = true;
            eprintln!("could not prepare local launch directory: {error}");
        }
    }
    diagnostic.save_if_enabled();
}

/// Opt-in, bounded startup diagnostics. Never serialize paths or arguments.
#[derive(Default, serde::Serialize)]
struct LaunchDiagnostic {
    stage: &'static str,
    startup_flags: u32,
    directory_resolved: bool,
    directory_matches_inherited: bool,
    directory_set_failed: bool,
    elapsed_ms: u128,
}

impl LaunchDiagnostic {
    fn save_if_enabled(&self) {
        let folder = std::env::temp_dir();
        if !folder.join("zterm-launch-diagnostics.enabled").is_file() {
            return;
        }
        if let Ok(json) = serde_json::to_vec_pretty(self) {
            let _ = std::fs::write(folder.join("zterm-launch-diagnostic.json"), json);
        }
    }
}

fn startup_directory(
    explorer: Option<PathBuf>,
    inherited: Option<&Path>,
    install: Option<&Path>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    // Explorer is authoritative even when it is displaying the installation folder.
    explorer.or_else(|| match (inherited, install) {
        (Some(current), Some(install)) if current == install => home,
        _ => None, // Retain the caller's cwd when there is no override.
    })
}

fn launching_explorer_directory(diagnostic: &mut LaunchDiagnostic) -> Option<PathBuf> {
    diagnostic.stage = "foreground_not_explorer";
    // Capture the handle now; enumerating whichever window is foreground later
    // could select another Explorer after a slow Shell COM call.
    let foreground = unsafe { GetForegroundWindow() };
    let mut class = [0u16; 64];
    let length = unsafe { GetClassNameW(foreground, &mut class) };
    if length == 0 || String::from_utf16_lossy(&class[..length as usize]) != "CabinetWClass" {
        return None;
    }
    let mut startup = STARTUPINFOW::default();
    unsafe { GetStartupInfoW(&mut startup) };
    diagnostic.startup_flags = startup.dwFlags.0;
    // Explorer address-bar resolution may use a registered shortcut too.
    // STARTF_TITLEISLINKNAME does not distinguish it from a shortcut click.
    // A background script can start zTerm while Explorer happens to be in front.
    // Only the Explorer process that created this process may supply its folder.
    let mut explorer_pid = 0;
    unsafe { GetWindowThreadProcessId(foreground, Some(&mut explorer_pid)) };
    let mut processes = sysinfo::System::new();
    let current_pid = sysinfo::Pid::from_u32(std::process::id());
    processes.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[current_pid]),
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );
    diagnostic.stage = "parent_unavailable";
    let parent_pid = processes.process(current_pid)?.parent()?.as_u32();
    diagnostic.stage = "parent_not_foreground_explorer";
    if explorer_pid == 0 || parent_pid != explorer_pid {
        return None;
    }
    let handle = foreground.0 as usize;
    let active_tab = active_explorer_tab(foreground).map(|tab| tab.0 as usize);
    let (sender, receiver) = mpsc::sync_channel(1);
    diagnostic.stage = "com_thread_start_failed";
    let started = std::time::Instant::now();
    std::thread::Builder::new()
        .name("explorer-launch-directory".into())
        .spawn(move || {
            let result = explorer_directory(
                HWND(handle as *mut _),
                active_tab.map(|tab| HWND(tab as *mut _)),
            );
            let _ = sender.send(result);
        })
        .ok()?;
    // An unresponsive Explorer must not prevent the terminal from starting.
    let result = receiver.recv_timeout(Duration::from_millis(1500));
    diagnostic.elapsed_ms = started.elapsed().as_millis();
    diagnostic.stage = match &result {
        Ok(Some(_)) => "directory_resolved",
        Ok(None) => "shell_directory_unavailable",
        Err(mpsc::RecvTimeoutError::Timeout) => "shell_timeout",
        Err(mpsc::RecvTimeoutError::Disconnected) => "com_thread_disconnected",
    };
    result.ok().flatten()
}

fn active_explorer_tab(window: HWND) -> Option<HWND> {
    // Explorer places the selected Windows 11 tab first in child Z order.
    // Capture it before COM calls; visibility alone includes inactive tabs.
    // Older Explorer versions do not expose this tab host.
    unsafe { FindWindowExW(Some(window), None, w!("ShellTabWindowClass"), None) }.ok()
}

fn explorer_directory(foreground: HWND, active_tab: Option<HWND>) -> Option<PathBuf> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .ok()?;
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }
    let _apartment = Apartment;
    let windows: IShellWindows =
        unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_LOCAL_SERVER) }.ok()?;
    let mut candidate = None;
    for index in 0..unsafe { windows.Count() }.ok()? {
        let Some(path) = browser_directory(&windows, index, foreground, active_tab) else {
            continue;
        };
        if candidate.as_ref().is_some_and(|previous| previous != &path) {
            return None; // Never guess between different tabs/windows.
        }
        candidate = Some(path);
    }
    candidate
}

fn browser_directory(
    windows: &IShellWindows,
    index: i32,
    foreground: HWND,
    active_tab: Option<HWND>,
) -> Option<PathBuf> {
    let browser: IWebBrowser2 = unsafe { windows.Item(&VARIANT::from(index)) }
        .ok()?
        .cast()
        .ok()?;
    if unsafe { browser.HWND() }.ok()?.0 != foreground.0 as isize {
        return None;
    }
    let provider: IServiceProvider = browser.cast().ok()?;
    let shell: IShellBrowser = unsafe { provider.QueryService(&SID_STopLevelBrowser) }.ok()?;
    if let Some(active_tab) = active_tab {
        if unsafe { shell.GetWindow() }.ok()? != active_tab {
            return None;
        }
    }
    let view = unsafe { shell.QueryActiveShellView() }.ok()?;
    // Reject hidden folder views as well; visibility is not a tab selector.
    if !unsafe { IsWindowVisible(view.GetWindow().ok()?) }.as_bool() {
        return None;
    }
    // Read the active view's folder, not the enumerated browser's LocationURL:
    // the latter can still refer to an inactive Windows 11 tab.
    let folder_view: IFolderView = view.cast().ok()?;
    let folder: IPersistFolder2 = unsafe { folder_view.GetFolder() }.ok()?;
    let item_id_list = unsafe { folder.GetCurFolder() }.ok()?;
    let mut path = vec![0u16; 32768];
    let resolved = unsafe { SHGetPathFromIDListEx(item_id_list, &mut path, GPFIDL_DEFAULT) };
    unsafe { CoTaskMemFree(Some(item_id_list.cast())) };
    if !resolved.as_bool() {
        return None; // Virtual locations such as Home/Search have no filesystem cwd.
    }
    let length = path.iter().position(|value| *value == 0)?;
    use std::os::windows::ffi::OsStringExt;
    let directory = PathBuf::from(std::ffi::OsString::from_wide(&path[..length]));
    directory.is_dir().then_some(directory)
}

#[cfg(test)]
mod tests {
    use super::startup_directory;
    use std::path::{Path, PathBuf};

    /// Set the observed Explorer HWND and the selected filesystem tab path.
    #[test]
    #[ignore = "requires a real Explorer window with a known selected tab"]
    fn selected_explorer_tab_resolves_expected_directory() {
        use super::*;
        let handle = std::env::var("ZTERM_TEST_EXPLORER_HWND")
            .expect("set observed Explorer HWND")
            .parse::<usize>()
            .unwrap();
        let expected = PathBuf::from(
            std::env::var_os("ZTERM_TEST_EXPLORER_DIRECTORY").expect("set selected tab directory"),
        );
        let window = HWND(handle as *mut _);
        let actual = explorer_directory(window, active_explorer_tab(window))
            .expect("selected filesystem tab must resolve even with inactive tabs");
        assert_eq!(
            dunce::canonicalize(actual).unwrap(),
            dunce::canonicalize(expected).unwrap()
        );
    }

    #[test]
    fn explorer_overrides_the_home_directory_inherited_from_windows() {
        let folder = PathBuf::from(r"C:\Work space\中文");
        assert_eq!(
            startup_directory(
                Some(folder.clone()),
                Some(Path::new(r"C:\Users\demo")),
                Some(Path::new(r"C:\Apps\zTerm")),
                Some(PathBuf::from(r"C:\Users\demo"))
            ),
            Some(folder)
        );
    }

    #[test]
    fn browsing_the_installation_folder_does_not_redirect_to_home() {
        let install = PathBuf::from(r"C:\Apps\zTerm");
        assert_eq!(
            startup_directory(
                Some(install.clone()),
                Some(&install),
                Some(&install),
                Some(PathBuf::from(r"C:\Users\demo"))
            ),
            Some(install)
        );
    }

    #[test]
    fn ordinary_launch_from_installation_uses_home() {
        let install = Path::new(r"C:\Apps\zTerm");
        let home = PathBuf::from(r"C:\Users\demo");
        assert_eq!(
            startup_directory(None, Some(install), Some(install), Some(home.clone())),
            Some(home)
        );
    }

    #[test]
    fn unknown_explorer_location_keeps_the_callers_directory() {
        assert_eq!(
            startup_directory(
                None,
                Some(Path::new(r"C:\Work")),
                Some(Path::new(r"C:\Apps\zTerm")),
                Some(PathBuf::from(r"C:\Users\demo"))
            ),
            None
        );
    }
}
