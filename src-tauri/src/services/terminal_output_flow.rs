// Author: Liz
use std::{
    collections::{HashMap, VecDeque},
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

const MAX_UNACKNOWLEDGED_OUTPUT_BYTES: usize = 256 * 1024;
const CONSUMER_OPEN_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalOutputFlowLease {
    pub generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalOutputReservation {
    pub generation: u64,
    pub sequence: u64,
}

pub struct TerminalOutputFlow {
    state: Mutex<TerminalOutputFlowState>,
    changed: Condvar,
    consumer_open_timeout: Duration,
}

impl Default for TerminalOutputFlow {
    fn default() -> Self {
        Self {
            state: Mutex::new(TerminalOutputFlowState::default()),
            changed: Condvar::new(),
            consumer_open_timeout: CONSUMER_OPEN_TIMEOUT,
        }
    }
}

#[derive(Default)]
struct TerminalOutputFlowState {
    runtimes: HashMap<String, RuntimeOutputFlow>,
}

#[derive(Default)]
struct RuntimeOutputFlow {
    generation: u64,
    next_sequence: u64,
    consumer_open: bool,
    closed: bool,
    waiting_for_consumer_since: Option<Instant>,
    stop_reason: Option<String>,
    unacknowledged_bytes: usize,
    pending: VecDeque<PendingOutput>,
}

struct PendingOutput {
    sequence: u64,
    bytes: usize,
}

impl TerminalOutputFlow {
    pub fn open(&self, runtime_session_id: &str) -> TerminalOutputFlowLease {
        let mut state = self
            .state
            .lock()
            .expect("terminal output flow lock was poisoned");
        let runtime = state
            .runtimes
            .entry(runtime_session_id.to_string())
            .or_default();
        if runtime.consumer_open && !runtime.closed {
            return TerminalOutputFlowLease {
                generation: runtime.generation,
            };
        }
        runtime.generation = runtime.generation.saturating_add(1).max(1);
        runtime.consumer_open = true;
        runtime.closed = false;
        runtime.waiting_for_consumer_since = None;
        runtime.stop_reason = None;
        runtime.unacknowledged_bytes = 0;
        runtime.pending.clear();
        self.changed.notify_all();
        TerminalOutputFlowLease {
            generation: runtime.generation,
        }
    }

    pub fn reserve(
        &self,
        runtime_session_id: &str,
        bytes: usize,
    ) -> Option<TerminalOutputReservation> {
        let mut state = self
            .state
            .lock()
            .expect("terminal output flow lock was poisoned");
        loop {
            let runtime = state
                .runtimes
                .entry(runtime_session_id.to_string())
                .or_default();
            if runtime.closed {
                return None;
            }
            if !runtime.consumer_open {
                let waiting_since = runtime
                    .waiting_for_consumer_since
                    .get_or_insert_with(Instant::now);
                let remaining = self
                    .consumer_open_timeout
                    .saturating_sub(waiting_since.elapsed());
                if remaining.is_zero() {
                    runtime.closed = true;
                    runtime.stop_reason = Some(
                        "终端输出消费者未在 10 秒内就绪，已停止连接以保护输出完整性".to_string(),
                    );
                    self.changed.notify_all();
                    return None;
                }
                let (next_state, _) = self
                    .changed
                    .wait_timeout(state, remaining)
                    .expect("terminal output flow lock was poisoned");
                state = next_state;
                continue;
            }

            let reservation = TerminalOutputReservation {
                generation: runtime.generation,
                sequence: runtime.next_sequence.saturating_add(1).max(1),
            };
            let bytes = bytes.max(1);
            if runtime.unacknowledged_bytes == 0
                || runtime.unacknowledged_bytes.saturating_add(bytes)
                    <= MAX_UNACKNOWLEDGED_OUTPUT_BYTES
            {
                runtime.next_sequence = reservation.sequence;
                runtime.unacknowledged_bytes = runtime.unacknowledged_bytes.saturating_add(bytes);
                runtime.pending.push_back(PendingOutput {
                    sequence: reservation.sequence,
                    bytes,
                });
                return Some(reservation);
            }

            state = self
                .changed
                .wait(state)
                .expect("terminal output flow lock was poisoned");
        }
    }

    pub fn acknowledge(&self, runtime_session_id: &str, generation: u64, sequence: u64) -> bool {
        let mut state = self
            .state
            .lock()
            .expect("terminal output flow lock was poisoned");
        let Some(runtime) = state.runtimes.get_mut(runtime_session_id) else {
            return false;
        };
        if !runtime.consumer_open
            || runtime.generation != generation
            || sequence > runtime.next_sequence
        {
            return false;
        }
        while runtime
            .pending
            .front()
            .is_some_and(|pending| pending.sequence <= sequence)
        {
            if let Some(pending) = runtime.pending.pop_front() {
                runtime.unacknowledged_bytes =
                    runtime.unacknowledged_bytes.saturating_sub(pending.bytes);
            }
        }
        self.changed.notify_all();
        true
    }

    pub fn close(&self, runtime_session_id: &str, generation: Option<u64>) {
        let mut state = self
            .state
            .lock()
            .expect("terminal output flow lock was poisoned");
        let runtime = match generation {
            Some(generation) => {
                let Some(runtime) = state.runtimes.get_mut(runtime_session_id) else {
                    return;
                };
                if generation != runtime.generation {
                    return;
                }
                runtime
            }
            None => {
                let Some(runtime) = state.runtimes.get_mut(runtime_session_id) else {
                    return;
                };
                runtime
            }
        };
        runtime.consumer_open = false;
        runtime.closed = true;
        runtime.unacknowledged_bytes = 0;
        runtime.pending.clear();
        self.changed.notify_all();
    }

    pub fn remove(&self, runtime_session_id: &str) {
        let mut state = self
            .state
            .lock()
            .expect("terminal output flow lock was poisoned");
        state.runtimes.remove(runtime_session_id);
        self.changed.notify_all();
    }

    pub fn stop_reason(&self, runtime_session_id: &str) -> Option<String> {
        let state = self
            .state
            .lock()
            .expect("terminal output flow lock was poisoned");
        state
            .runtimes
            .get(runtime_session_id)
            .and_then(|runtime| runtime.stop_reason.clone())
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, thread, time::Duration};

    use super::{TerminalOutputFlow, MAX_UNACKNOWLEDGED_OUTPUT_BYTES};

    impl TerminalOutputFlow {
        fn with_consumer_timeout(consumer_open_timeout: Duration) -> Self {
            Self {
                state: std::sync::Mutex::new(super::TerminalOutputFlowState::default()),
                changed: std::sync::Condvar::new(),
                consumer_open_timeout,
            }
        }
    }

    #[test]
    fn acknowledgement_releases_a_full_runtime_window_without_affecting_others() {
        let flow = std::sync::Arc::new(TerminalOutputFlow::default());
        let lease = flow.open("slow");
        let first = flow
            .reserve("slow", MAX_UNACKNOWLEDGED_OUTPUT_BYTES)
            .expect("first reservation");
        let (sender, receiver) = mpsc::channel();
        let waiting = std::sync::Arc::clone(&flow);
        let worker = thread::spawn(move || {
            sender
                .send(waiting.reserve("slow", 1))
                .expect("send reservation");
        });

        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        flow.open("other");
        assert!(
            flow.reserve("other", 1).is_some(),
            "other runtime must not wait"
        );
        flow.acknowledge("slow", lease.generation, first.sequence);
        assert!(receiver
            .recv_timeout(Duration::from_millis(250))
            .expect("window should resume")
            .is_some());
        worker.join().expect("waiting worker");
    }

    #[test]
    fn close_releases_a_reader_waiting_for_credit_before_the_runtime_is_removed() {
        let flow = std::sync::Arc::new(TerminalOutputFlow::default());
        flow.open("runtime");
        flow.reserve("runtime", MAX_UNACKNOWLEDGED_OUTPUT_BYTES)
            .expect("first reservation");
        let (sender, receiver) = mpsc::channel();
        let waiting = std::sync::Arc::clone(&flow);
        let worker = thread::spawn(move || {
            sender
                .send(waiting.reserve("runtime", 1))
                .expect("send close result");
        });

        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        flow.close("runtime", None);
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_millis(250))
                .expect("close should wake reader"),
            None
        );
        worker.join().expect("waiting worker");
        flow.remove("runtime");
        let state = flow.state.lock().expect("flow state");
        assert!(
            !state.runtimes.contains_key("runtime"),
            "the caller must remove only after the waiting reader exits"
        );
    }

    #[test]
    fn stale_generation_acknowledgements_are_ignored() {
        let flow = std::sync::Arc::new(TerminalOutputFlow::default());
        let first_lease = flow.open("runtime");
        flow.close("runtime", None);
        let second_lease = flow.open("runtime");
        let second = flow
            .reserve("runtime", MAX_UNACKNOWLEDGED_OUTPUT_BYTES)
            .expect("second reservation");
        let (sender, receiver) = mpsc::channel();
        let waiting = std::sync::Arc::clone(&flow);
        let worker = thread::spawn(move || {
            sender
                .send(waiting.reserve("runtime", 1))
                .expect("send reservation");
        });

        assert!(!flow.acknowledge("runtime", first_lease.generation, second.sequence));
        assert!(!flow.acknowledge("runtime", second_lease.generation, second.sequence + 1));
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        assert!(flow.acknowledge("runtime", second_lease.generation, second.sequence));
        assert!(receiver
            .recv_timeout(Duration::from_millis(250))
            .expect("valid acknowledgement must release credit")
            .is_some());
        worker.join().expect("waiting worker");
    }

    #[test]
    fn missing_consumer_stops_output_with_an_explanation() {
        let flow = TerminalOutputFlow::with_consumer_timeout(Duration::ZERO);

        assert_eq!(flow.reserve("runtime", 1), None);
        assert!(flow
            .stop_reason("runtime")
            .is_some_and(|reason| reason.contains("消费者")));
    }

    #[test]
    fn close_of_an_unknown_or_already_removed_runtime_does_not_create_a_tombstone() {
        let flow = TerminalOutputFlow::default();
        flow.close("unknown", Some(1));
        flow.close("unknown", None);
        flow.open("removed");
        flow.remove("removed");
        flow.close("removed", None);

        let state = flow.state.lock().expect("flow state");
        assert!(!state.runtimes.contains_key("unknown"));
        assert!(!state.runtimes.contains_key("removed"));
    }
}
