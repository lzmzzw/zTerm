//! Capture the launching Explorer folder before Tauri creates or focuses a window.
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};

use windows::{
    core::Interface,
    Win32::{
        Foundation::HWND,
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IServiceProvider,
                CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
            },
            Threading::{GetStartupInfoW, STARTF_TITLEISLINKNAME, STARTUPINFOW},
            Variant::VARIANT,
        },
        UI::{
            Shell::{
                IFolderView, IPersistFolder2, IShellBrowser, IShellWindows, IWebBrowser2,
                SHGetPathFromIDListEx, SID_STopLevelBrowser, ShellWindows, GPFIDL_DEFAULT,
            },
            WindowsAndMessaging::{
                GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible,
            },
        },
    },
};

/// Single-instance forwarding reads the new process's cwd itself. Normalize it
/// before installing that plugin, so cold and warm launches carry the same path.
pub fn prepare_working_directory() {
    if std::env::args_os().len() != 1 {
        return; // Explicit --open-local and other launch arguments retain priority.
    }
    let explorer = launching_explorer_directory();
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
        if let Err(error) = std::env::set_current_dir(directory) {
            eprintln!("could not prepare local launch directory: {error}");
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

fn launching_explorer_directory() -> Option<PathBuf> {
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
    if startup.dwFlags.contains(STARTF_TITLEISLINKNAME) {
        return None; // Opening a shortcut is an ordinary launch, not address-bar navigation.
    }
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
    let parent_pid = processes.process(current_pid)?.parent()?.as_u32();
    if explorer_pid == 0 || parent_pid != explorer_pid {
        return None;
    }
    let handle = foreground.0 as usize;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("explorer-launch-directory".into())
        .spawn(move || {
            let result = explorer_directory(HWND(handle as *mut _));
            let _ = sender.send(result);
        })
        .ok()?;
    // An unresponsive Explorer must not prevent the terminal from starting.
    receiver
        .recv_timeout(Duration::from_millis(1500))
        .ok()
        .flatten()
}

fn explorer_directory(foreground: HWND) -> Option<PathBuf> {
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
        let Some(path) = browser_directory(&windows, index, foreground) else {
            continue;
        };
        if candidate.as_ref().is_some_and(|previous| previous != &path) {
            return None; // Never guess between different tabs/windows.
        }
        candidate = Some(path);
    }
    candidate
}

fn browser_directory(windows: &IShellWindows, index: i32, foreground: HWND) -> Option<PathBuf> {
    let browser: IWebBrowser2 = unsafe { windows.Item(&VARIANT::from(index)) }
        .ok()?
        .cast()
        .ok()?;
    if unsafe { browser.HWND() }.ok()?.0 != foreground.0 as isize {
        return None;
    }
    let provider: IServiceProvider = browser.cast().ok()?;
    let shell: IShellBrowser = unsafe { provider.QueryService(&SID_STopLevelBrowser) }.ok()?;
    let view = unsafe { shell.QueryActiveShellView() }.ok()?;
    // Windows 11 exposes inactive tabs in ShellWindows too. Only the visible
    // shell view belonging to the captured Explorer can supply this request.
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
