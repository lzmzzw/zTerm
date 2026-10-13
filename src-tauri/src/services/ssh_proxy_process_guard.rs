// Author: Liz
use crate::error::AppResult;

#[cfg(windows)]
pub use windows::ProxyProcessGuard;

#[cfg(not(windows))]
pub struct ProxyProcessGuard;

#[cfg(not(windows))]
impl ProxyProcessGuard {
    pub fn attach(_: &tokio::process::Child) -> AppResult<Self> {
        Ok(Self)
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use crate::error::AppError;
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        ptr,
    };

    type Handle = *mut c_void;
    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const EXTENDED_LIMIT_INFORMATION: i32 = 9;

    // Layout matches Windows JOBOBJECT_BASIC_LIMIT_INFORMATION.
    #[repr(C)]
    struct BasicLimitInformation {
        process_user_time_limit: i64,
        job_user_time_limit: i64,
        limit_flags: u32,
        min_working_set_size: usize,
        max_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    // IO_COUNTERS contains six unsigned 64-bit counters.
    #[repr(C)]
    struct IoCounters {
        read_operations: u64,
        write_operations: u64,
        other_operations: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }

    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        #[cfg(test)]
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        #[cfg(test)]
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    }

    /// An unnamed, non-inheritable Job handle. Its final close kills assigned
    /// processes and descendants created after assignment, even after parent exit.
    /// OwnedHandle owns CloseHandle and is Send/Sync; no raw-handle unsafe impl.
    pub struct ProxyProcessGuard {
        _job: OwnedHandle,
    }

    impl ProxyProcessGuard {
        pub fn attach(child: &tokio::process::Child) -> AppResult<Self> {
            let process = child
                .raw_handle()
                .ok_or_else(|| AppError::ssh("SSH 代理进程已退出，无法建立进程清理组"))?;
            // SAFETY: null attributes/name create an unnamed non-inheritable job.
            let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if raw.is_null() {
                return Err(last_error("创建 SSH 代理进程清理组失败"));
            }
            // SAFETY: successful CreateJobObjectW returns a uniquely owned handle.
            let job = unsafe { OwnedHandle::from_raw_handle(raw) };
            // SAFETY: this C structure consists solely of integer fields, all zero-valid.
            let mut limits: ExtendedLimitInformation = unsafe { zeroed() };
            limits.basic.limit_flags = KILL_ON_JOB_CLOSE;
            // SAFETY: correctly aligned repr(C) buffer remains live for the call.
            let configured = unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    EXTENDED_LIMIT_INFORMATION,
                    (&limits as *const ExtendedLimitInformation).cast(),
                    size_of::<ExtendedLimitInformation>() as u32,
                )
            };
            if configured == 0 {
                return Err(last_error("配置 SSH 代理进程清理组失败"));
            }
            // SAFETY: child borrows a live process handle; job remains owned here.
            if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process) } == 0 {
                return Err(last_error("绑定 SSH 代理进程清理组失败"));
            }
            Ok(Self { _job: job })
        }
    }

    fn last_error(message: &str) -> AppError {
        AppError::ssh(format!("{message}: {}", std::io::Error::last_os_error()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{process::Stdio, time::Duration};
        use tokio::{io::AsyncWriteExt, process::Command};

        #[test]
        fn windows_job_structures_match_sdk_abi_and_guard_is_send_sync() {
            assert_eq!(size_of::<IoCounters>(), 48);
            assert_eq!(std::mem::offset_of!(BasicLimitInformation, limit_flags), 16);
            #[cfg(target_pointer_width = "64")]
            {
                assert_eq!(size_of::<BasicLimitInformation>(), 64);
                assert_eq!(size_of::<ExtendedLimitInformation>(), 144);
                assert_eq!(std::mem::offset_of!(ExtendedLimitInformation, io), 64);
            }
            #[cfg(target_pointer_width = "32")]
            {
                assert_eq!(size_of::<BasicLimitInformation>(), 48);
                assert_eq!(size_of::<ExtendedLimitInformation>(), 112);
            }
            fn send_sync<T: Send + Sync>() {}
            send_sync::<ProxyProcessGuard>();
        }

        #[tokio::test]
        async fn closing_job_terminates_local_root_and_spawned_descendant() {
            struct PidFile(std::path::PathBuf);
            impl Drop for PidFile {
                fn drop(&mut self) {
                    let _ = std::fs::remove_file(&self.0);
                }
            }
            let path = PidFile(
                std::env::temp_dir()
                    .join(format!("zterm-proxy-job-test-{}.pid", uuid::Uuid::new_v4())),
            );
            // The stdin gate ensures assignment precedes descendant creation.
            let script = "[Console]::ReadLine() | Out-Null; $p=Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText($env:ZTERM_TEST_CHILD_PID_PATH,[string]$p.Id); Start-Sleep -Seconds 120";
            let mut root = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", script])
                .env("ZTERM_TEST_CHILD_PID_PATH", &path.0)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let guard = ProxyProcessGuard::attach(&root).unwrap();
            root.stdin
                .as_mut()
                .unwrap()
                .write_all(b"go\n")
                .await
                .unwrap();
            let pid = tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    if let Ok(text) = std::fs::read_to_string(&path.0) {
                        if let Ok(pid) = text.trim().parse::<u32>() {
                            break pid;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("local descendant must start");
            // SAFETY: SYNCHRONIZE-only access, non-inheritable handle for test PID.
            let raw = unsafe { OpenProcess(0x0010_0000, 0, pid) };
            assert!(!raw.is_null(), "must obtain descendant wait handle");
            // SAFETY: successful OpenProcess creates a uniquely owned handle.
            let descendant = unsafe { OwnedHandle::from_raw_handle(raw) };
            // SAFETY: valid owned process handle, nonblocking query.
            assert_eq!(
                unsafe { WaitForSingleObject(descendant.as_raw_handle(), 0) },
                258
            );
            drop(guard);
            tokio::time::timeout(Duration::from_secs(5), root.wait())
                .await
                .unwrap()
                .unwrap();
            // SAFETY: owned wait handle remains live throughout bounded wait.
            assert_eq!(
                unsafe { WaitForSingleObject(descendant.as_raw_handle(), 5000) },
                0,
                "closing Job must stop descendant too"
            );
        }
    }
}
