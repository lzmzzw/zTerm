// Author: Liz
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 128;
const MAX_ACTIVE: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Route {
    session_id: String,
    fingerprint: String,
    generation: u64,
}

#[derive(Default)]
pub(super) struct Scheduler {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    routes: HashMap<String, (Route, Instant)>,
    active: HashMap<String, u64>,
    hosts: HashSet<String>,
    failures: HashMap<String, Failure>,
    serial: u64,
}

struct Failure {
    attempts: u32,
    retry_at: Instant,
}

pub(super) struct Probe {
    scheduler: Arc<Scheduler>,
    key: String,
    failure_key: String,
    host: String,
    token: u64,
    success: bool,
}

impl Scheduler {
    pub(super) fn bind(&self, session_id: &str, fingerprint: String) -> Option<Route> {
        let mut state = self.state.lock().ok()?;
        if let Some((route, used)) = state.routes.get_mut(session_id) {
            if route.fingerprint == fingerprint {
                *used = Instant::now();
                return Some(route.clone());
            }
        }
        state.serial = state.serial.wrapping_add(1);
        let route = Route {
            session_id: session_id.into(),
            fingerprint,
            generation: state.serial,
        };
        if state.routes.len() >= MAX_ENTRIES && !state.routes.contains_key(session_id) {
            if let Some(oldest) = state
                .routes
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(key, _)| key.clone())
            {
                state.routes.remove(&oldest);
            }
        }
        state
            .routes
            .insert(session_id.into(), (route.clone(), Instant::now()));
        Some(route)
    }

    pub(super) fn invalidate(&self, session_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.routes.remove(session_id);
        }
    }

    pub(super) fn current(&self, route: &Route) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| is_current(&state, route))
    }

    pub(super) fn publish(&self, route: &Route, publish: impl FnOnce()) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        if !is_current(&state, route) {
            return false;
        }
        publish();
        true
    }

    pub(super) fn start(self: &Arc<Self>, route: &Route, host: &str, job: &str) -> Option<Probe> {
        let mut state = self.state.lock().ok()?;
        let key = format!("{}:{job}", route.generation);
        let failure_key = key.clone();
        if !is_current(&state, route)
            || state.active.len() >= MAX_ACTIVE
            || state.hosts.contains(host)
            || state
                .failures
                .get(&failure_key)
                .is_some_and(|failure| failure.retry_at > Instant::now())
        {
            return None;
        }
        state.serial = state.serial.wrapping_add(1);
        let token = state.serial;
        state.active.insert(key.clone(), token);
        state.hosts.insert(host.into());
        Some(Probe {
            scheduler: Arc::clone(self),
            key,
            failure_key,
            host: host.into(),
            token,
            success: false,
        })
    }
}

fn is_current(state: &State, route: &Route) -> bool {
    state
        .routes
        .get(&route.session_id)
        .is_some_and(|(current, _)| current == route)
}

impl Probe {
    pub(super) fn succeeded(&mut self) {
        self.success = true;
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let Ok(mut state) = self.scheduler.state.lock() else {
            return;
        };
        if state.active.get(&self.key) != Some(&self.token) {
            return;
        }
        state.active.remove(&self.key);
        state.hosts.remove(&self.host);
        if self.success {
            state.failures.remove(&self.failure_key);
        } else {
            let attempts = state
                .failures
                .get(&self.failure_key)
                .map_or(1, |failure| failure.attempts.saturating_add(1));
            // 1, 2, 4 ... 60 seconds, with independently sampled 0..250 ms jitter.
            let seconds = (1u64 << attempts.saturating_sub(1).min(6)).min(60);
            let jitter = (uuid::Uuid::new_v4().as_u128() % 251) as u64;
            if state.failures.len() >= MAX_ENTRIES {
                if let Some(oldest) = state
                    .failures
                    .iter()
                    .min_by_key(|(_, failure)| failure.retry_at)
                    .map(|(key, _)| key.clone())
                {
                    state.failures.remove(&oldest);
                }
            }
            state.failures.insert(
                self.failure_key.clone(),
                Failure {
                    attempts,
                    retry_at: Instant::now()
                        + Duration::from_secs(seconds)
                        + Duration::from_millis(jitter),
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_refresh_shares_host_and_global_limits_without_queueing() {
        let scheduler = Arc::new(Scheduler::default());
        let routes: Vec<_> = (0..6)
            .map(|index| {
                scheduler
                    .bind(&index.to_string(), index.to_string())
                    .unwrap()
            })
            .collect();
        let mut probes: Vec<_> = (0..4)
            .map(|index| {
                scheduler
                    .start(&routes[index], &index.to_string(), "commands")
                    .unwrap()
            })
            .collect();
        assert!(scheduler.start(&routes[4], "4", "paths").is_none());
        probes.pop().unwrap().succeeded();
        let mut available = scheduler.start(&routes[4], "4", "paths").unwrap();
        assert!(scheduler.start(&routes[5], "4", "commands").is_none());
        available.succeeded();
        drop(available);
        assert!(scheduler.start(&routes[5], "4", "commands").is_some());
    }

    #[test]
    fn completion_refresh_backoff_grows_and_success_resets_failure_state() {
        let scheduler = Arc::new(Scheduler::default());
        let route = scheduler.bind("session", "route".into()).unwrap();
        let key = format!("{}:commands", route.generation);
        for attempt in 1..=4 {
            let before = Instant::now();
            drop(scheduler.start(&route, "host", "commands").unwrap());
            assert!(scheduler.start(&route, "host", "commands").is_none());
            let mut state = scheduler.state.lock().unwrap();
            let failure = state.failures.get_mut(&key).unwrap();
            assert_eq!(failure.attempts, attempt);
            assert!(failure.retry_at >= before + Duration::from_secs(1 << (attempt - 1)));
            failure.retry_at = Instant::now();
        }
        let mut probe = scheduler.start(&route, "host", "commands").unwrap();
        probe.succeeded();
        drop(probe);
        assert!(!scheduler.state.lock().unwrap().failures.contains_key(&key));
    }

    #[test]
    fn completion_refresh_command_failure_does_not_starve_path_probes() {
        let scheduler = Arc::new(Scheduler::default());
        let route = scheduler.bind("session", "route".into()).unwrap();
        drop(scheduler.start(&route, "host", "commands").unwrap());
        assert!(scheduler.start(&route, "host", "commands").is_none());
        let mut path_probe = scheduler
            .start(&route, "host", "path:/new-directory")
            .unwrap();
        assert!(scheduler
            .start(&route, "host", "path:/other-directory")
            .is_none());
        path_probe.succeeded();
        drop(path_probe);
        // A successful path probe must not reset command-discovery backoff.
        assert!(scheduler.start(&route, "host", "commands").is_none());
    }

    #[tokio::test]
    async fn completion_refresh_cancel_and_panic_release_activity() {
        let scheduler = Arc::new(Scheduler::default());
        let route = scheduler.bind("session", "route".into()).unwrap();
        let permit = scheduler.start(&route, "host", "commands").unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _permit = permit;
            started_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(scheduler.state.lock().unwrap().active.is_empty());
        assert!(scheduler.state.lock().unwrap().hosts.is_empty());
        let new_route = scheduler.bind("session", "new route".into()).unwrap();
        let permit = scheduler.start(&new_route, "host", "paths").unwrap();
        let task = tokio::spawn(async move {
            let _permit = permit;
            panic!("test probe panic");
        });
        assert!(task.await.unwrap_err().is_panic());
        assert!(scheduler.state.lock().unwrap().active.is_empty());
        assert!(scheduler.state.lock().unwrap().hosts.is_empty());
    }

    #[test]
    fn completion_refresh_generation_discards_old_results_and_metadata_is_bounded() {
        let scheduler = Arc::new(Scheduler::default());
        let old = scheduler.bind("session", "old route".into()).unwrap();
        let new = scheduler.bind("session", "new route".into()).unwrap();
        assert!(!scheduler.publish(&old, || panic!("obsolete publication")));
        assert!(scheduler.publish(&new, || {}));
        for index in 0..MAX_ENTRIES + 8 {
            let route = scheduler
                .bind(&index.to_string(), index.to_string())
                .unwrap();
            drop(
                scheduler
                    .start(&route, &index.to_string(), "commands")
                    .unwrap(),
            );
        }
        let state = scheduler.state.lock().unwrap();
        assert!(state.routes.len() <= MAX_ENTRIES);
        assert!(state.failures.len() <= MAX_ENTRIES);
        assert!(state.active.is_empty());
        assert!(state.hosts.is_empty());
    }
}
