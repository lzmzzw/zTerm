// Author: Liz
use std::{
    fmt, io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use portable_pty::{Child, ChildKiller, ExitStatus, MasterPty, PtySize};

/// Only native PTY creation and destruction are serialized on Windows. Normal
/// terminal reads, writes and process waits never acquire this lock.
pub(crate) fn with_pty_lifecycle_lock<T>(operation: impl FnOnce() -> T) -> T {
    #[cfg(windows)]
    let _guard = {
        static LIFECYCLE: Mutex<()> = Mutex::new(());
        LIFECYCLE.lock().unwrap_or_else(|error| error.into_inner())
    };
    operation()
}

struct KillState {
    killer: Box<dyn ChildKiller + Send + Sync>,
    requested: bool,
    #[cfg(windows)]
    job: Option<std::os::windows::io::OwnedHandle>,
}

struct ProcessCleanup {
    state: Mutex<KillState>,
    exited: AtomicBool,
}

impl ProcessCleanup {
    fn kill(&self) -> io::Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        // Closing the Job is required even when the direct child already exited:
        // descendants may still be running. A cloned killer must not retain it.
        #[cfg(windows)]
        if let Some(job) = state.job.take() {
            drop(job);
            state.requested = true;
            return Ok(());
        }
        if state.requested || self.exited.load(Ordering::Acquire) {
            return Ok(());
        }
        state.killer.kill()?;
        state.requested = true;
        Ok(())
    }
}

/// Implements the existing portable-pty Child contract so runtime callers do not
/// need a second process lifecycle. Drop covers failures after spawn as well.
pub struct PtyProcessGuard {
    child: Box<dyn Child + Send + Sync>,
    cleanup: Arc<ProcessCleanup>,
}

impl PtyProcessGuard {
    pub fn new(child: Box<dyn Child + Send + Sync>) -> Self {
        #[cfg(windows)]
        let job = child.as_raw_handle().and_then(|handle| {
            match platform::attach_job(handle) {
                Ok(job) => Some(job),
                Err(error) => {
                    // Preserve compatibility with restricted/nested job hosts.
                    // Never include the command, environment or working folder.
                    static REPORTED: AtomicBool = AtomicBool::new(false);
                    if !REPORTED.swap(true, Ordering::Relaxed) {
                        eprintln!("PTY process-tree cleanup unavailable: {error}");
                    }
                    None
                }
            }
        });
        let cleanup = Arc::new(ProcessCleanup {
            state: Mutex::new(KillState {
                killer: child.clone_killer(),
                requested: false,
                #[cfg(windows)]
                job,
            }),
            exited: AtomicBool::new(false),
        });
        Self { child, cleanup }
    }

    pub(crate) fn guard_master(&self, master: Box<dyn MasterPty + Send>) -> PtyMasterGuard {
        PtyMasterGuard {
            master: Some(master),
            #[cfg(windows)]
            cleanup: Arc::clone(&self.cleanup),
        }
    }
}

impl fmt::Debug for PtyProcessGuard {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PtyProcessGuard")
            .field("pid", &self.child.process_id())
            .finish_non_exhaustive()
    }
}

impl Child for PtyProcessGuard {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.cleanup.exited.store(true, Ordering::Release);
        }
        Ok(status)
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.cleanup.exited.store(true, Ordering::Release);
        Ok(status)
    }

    fn process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        self.child.as_raw_handle()
    }
}

impl ChildKiller for PtyProcessGuard {
    fn kill(&mut self) -> io::Result<()> {
        // In particular on Unix, avoid signalling a reaped/reused process id.
        let _ = self.try_wait();
        self.cleanup.kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(GuardedKiller(Arc::clone(&self.cleanup)))
    }
}

impl Drop for PtyProcessGuard {
    fn drop(&mut self) {
        let _ = self.kill();
    }
}

struct GuardedKiller(Arc<ProcessCleanup>);

impl fmt::Debug for GuardedKiller {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("GuardedPtyKiller")
    }
}

impl ChildKiller for GuardedKiller {
    fn kill(&mut self) -> io::Result<()> {
        self.0.kill()
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self(Arc::clone(&self.0)))
    }
}

pub struct PtyMasterGuard {
    master: Option<Box<dyn MasterPty + Send>>,
    #[cfg(windows)]
    cleanup: Arc<ProcessCleanup>,
}

impl PtyMasterGuard {
    pub fn resize(&self, size: PtySize) -> Result<(), String> {
        self.master
            .as_ref()
            .expect("PTY master is available until drop")
            .resize(size)
            .map_err(|error| error.to_string())
    }
}

impl Drop for PtyMasterGuard {
    fn drop(&mut self) {
        // Runtime structs may drop master before child. Terminate first so a
        // ConPTY close cannot wait on a still-running shell's normal shutdown.
        #[cfg(windows)]
        let _ = self.cleanup.kill();
        if let Some(master) = self.master.take() {
            with_pty_lifecycle_lock(|| drop(master));
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::{
        mem::size_of,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    };
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::HANDLE,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        },
    };

    pub(super) fn attach_job(process: RawHandle) -> windows::core::Result<OwnedHandle> {
        // SAFETY: no security attributes/name creates an unnamed, non-inheritable
        // Job. The successful returned handle has exactly one owner below.
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }?;
        let job = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: SDK type, aligned buffer, correct byte size, valid owned Job.
        unsafe {
            SetInformationJobObject(
                HANDLE(job.as_raw_handle()),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )?;
            // The caller owns child for the entire call; no PID lookup/reuse.
            AssignProcessToJobObject(HANDLE(job.as_raw_handle()), HANDLE(process))?;
        }
        Ok(job)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Debug)]
    struct FakeChild {
        kills: Arc<AtomicUsize>,
        exited: bool,
    }

    impl ChildKiller for FakeChild {
        fn kill(&mut self) -> io::Result<()> {
            self.kills.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self {
                kills: Arc::clone(&self.kills),
                exited: self.exited,
            })
        }
    }

    impl Child for FakeChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(self.exited.then(|| ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            self.exited = true;
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    fn fake(exited: bool) -> (PtyProcessGuard, Arc<AtomicUsize>) {
        let kills = Arc::new(AtomicUsize::new(0));
        let guard = PtyProcessGuard::new(Box::new(FakeChild {
            kills: Arc::clone(&kills),
            exited,
        }));
        (guard, kills)
    }

    #[test]
    fn failed_initialization_drops_and_terminates_started_child() {
        let (guard, kills) = fake(false);
        let initialize = || -> io::Result<()> {
            let _child = guard;
            Err(io::Error::other("injected reader acquisition failure"))
        };
        assert!(initialize().is_err());
        assert_eq!(kills.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn explicit_and_cloned_killers_share_one_termination() {
        let (mut guard, kills) = fake(false);
        let mut killer = guard.clone_killer();
        guard.kill().unwrap();
        killer.kill().unwrap();
        drop(guard);
        killer.kill().unwrap();
        assert_eq!(kills.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn already_exited_child_is_not_signalled_again() {
        let (mut guard, kills) = fake(true);
        assert!(guard.try_wait().unwrap().is_some());
        let mut killer = guard.clone_killer();
        drop(guard);
        killer.kill().unwrap();
        assert_eq!(kills.load(Ordering::SeqCst), 0);
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_guard_terminates_local_descendants_even_with_a_cloned_killer() {
        use std::{
            io::Write,
            os::windows::{
                io::{AsRawHandle, FromRawHandle, OwnedHandle},
                process::CommandExt,
            },
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        use windows::Win32::{
            Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };

        struct PidFile(std::path::PathBuf);
        impl Drop for PidFile {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
                let _ = std::fs::remove_file(self.0.with_extension("pending"));
            }
        }
        let path = PidFile(
            std::env::temp_dir().join(format!("zterm-pty-job-{}.pid", uuid::Uuid::new_v4())),
        );
        // Gate descendant spawn until assignment; this touches only processes
        // created by this test and uses a unique temporary PID file.
        let script = "[Console]::ReadLine() | Out-Null; $p=Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; $pending=[IO.Path]::ChangeExtension($env:ZTERM_PTY_TEST_PID,'pending'); [IO.File]::WriteAllText($pending,[string]$p.Id); [IO.File]::Move($pending,$env:ZTERM_PTY_TEST_PID); Start-Sleep -Seconds 60";
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("ZTERM_PTY_TEST_PID", &path.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let guard = PtyProcessGuard::new(Box::new(child));
        assert!(
            guard.cleanup.state.lock().unwrap().job.is_some(),
            "test process must be assigned to Job"
        );
        // Keep wait-only handles rather than querying a PID after termination.
        let root_handle =
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, guard.process_id().unwrap()) }
                .unwrap();
        let root = unsafe { OwnedHandle::from_raw_handle(root_handle.0) };
        let _retained_killer = guard.clone_killer();
        stdin.write_all(b"go\n").unwrap();
        drop(stdin);
        let deadline = Instant::now() + Duration::from_secs(15);
        let descendant_pid = loop {
            if let Ok(text) = std::fs::read_to_string(&path.0) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(Instant::now() < deadline, "descendant must publish PID");
            std::thread::sleep(Duration::from_millis(20));
        };
        // SAFETY: wait-only access to the PID published by our own test child.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, descendant_pid) }.unwrap();
        let descendant = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        assert_eq!(
            unsafe { WaitForSingleObject(HANDLE(descendant.as_raw_handle()), 0) },
            WAIT_TIMEOUT
        );
        drop(guard);
        assert_eq!(
            unsafe { WaitForSingleObject(HANDLE(root.as_raw_handle()), 5000) },
            WAIT_OBJECT_0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(HANDLE(descendant.as_raw_handle()), 5000) },
            WAIT_OBJECT_0
        );
    }
}
