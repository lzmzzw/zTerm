// Author: Liz
use std::{
    collections::HashMap,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose, Engine as _};
use tauri::{AppHandle, Emitter};

use crate::{
    models::terminal::TerminalDataEvent,
    services::terminal_output_flow::{
        TerminalOutputFlow, TerminalOutputFlowLease, TerminalOutputReservation,
    },
};

const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_DATA_THRESHOLD_BYTES: usize = 32 * 1024;
const OUTPUT_QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
pub struct TerminalOutputDispatcher {
    sender: Option<mpsc::SyncSender<TerminalOutputMessage>>,
    flow: std::sync::Arc<TerminalOutputFlow>,
}

impl TerminalOutputDispatcher {
    pub fn new(app: Option<AppHandle>) -> Self {
        let flow = std::sync::Arc::new(TerminalOutputFlow::default());
        let Some(app) = app else {
            return Self { sender: None, flow };
        };
        let (sender, receiver) = mpsc::sync_channel(OUTPUT_QUEUE_CAPACITY);
        thread::spawn(move || run_dispatcher(app, receiver));
        Self {
            sender: Some(sender),
            flow,
        }
    }

    pub fn push(&self, runtime_session_id: &str, data: String, raw_bytes: Vec<u8>) -> bool {
        if data.is_empty() {
            return true;
        }
        // Headless services and unit tests do not have an event consumer. They
        // deliberately keep the existing direct reader behavior.
        let Some(sender) = &self.sender else {
            return true;
        };
        let Some(flow) = self.flow.reserve(runtime_session_id, raw_bytes.len()) else {
            return false;
        };
        sender
            .send(TerminalOutputMessage::Output {
                runtime_session_id: runtime_session_id.to_string(),
                data,
                raw_bytes,
                flow,
            })
            .is_ok()
    }

    pub fn open_runtime(&self, runtime_session_id: &str) -> TerminalOutputFlowLease {
        self.flow.open(runtime_session_id)
    }

    pub fn acknowledge_runtime(
        &self,
        runtime_session_id: &str,
        generation: u64,
        sequence: u64,
    ) -> bool {
        self.flow
            .acknowledge(runtime_session_id, generation, sequence)
    }

    pub fn close_runtime(&self, runtime_session_id: &str, generation: Option<u64>) {
        self.flow.close(runtime_session_id, generation);
    }

    pub fn remove_runtime(&self, runtime_session_id: &str) {
        self.flow.remove(runtime_session_id);
    }

    pub fn stop_reason(&self, runtime_session_id: &str) -> Option<String> {
        self.flow.stop_reason(runtime_session_id)
    }

    pub fn flush_runtime(&self, runtime_session_id: &str) {
        let Some(sender) = &self.sender else {
            return;
        };
        let (ack_sender, ack_receiver) = mpsc::channel();
        let _ = sender.send(TerminalOutputMessage::FlushRuntime {
            runtime_session_id: runtime_session_id.to_string(),
            ack: ack_sender,
        });
        let _ = ack_receiver.recv_timeout(Duration::from_millis(500));
    }
}

enum TerminalOutputMessage {
    Output {
        runtime_session_id: String,
        data: String,
        raw_bytes: Vec<u8>,
        flow: TerminalOutputReservation,
    },
    FlushRuntime {
        runtime_session_id: String,
        ack: mpsc::Sender<()>,
    },
}

fn run_dispatcher(app: AppHandle, receiver: mpsc::Receiver<TerminalOutputMessage>) {
    run_dispatcher_events(receiver, |event| {
        let _ = app.emit("terminal:data", event);
    });
}

fn run_dispatcher_events(
    receiver: mpsc::Receiver<TerminalOutputMessage>,
    mut emit: impl FnMut(TerminalDataEvent),
) {
    let mut batcher = TerminalOutputBatcher::default();
    let mut flush_at = Instant::now() + FLUSH_INTERVAL;
    loop {
        let now = Instant::now();
        if now >= flush_at {
            for event in batcher.flush_all() {
                emit(event);
            }
            flush_at = now + FLUSH_INTERVAL;
        }
        match receiver.recv_timeout(flush_at.saturating_duration_since(Instant::now())) {
            Ok(TerminalOutputMessage::Output {
                runtime_session_id,
                data,
                raw_bytes,
                flow,
            }) => {
                for event in batcher.push(runtime_session_id, data, raw_bytes, flow) {
                    emit(event);
                }
            }
            Ok(TerminalOutputMessage::FlushRuntime {
                runtime_session_id,
                ack,
            }) => {
                if let Some(event) = batcher.flush_runtime(&runtime_session_id) {
                    emit(event);
                }
                let _ = ack.send(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                for event in batcher.flush_all() {
                    emit(event);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                for event in batcher.flush_all() {
                    emit(event);
                }
                return;
            }
        }
    }
}

#[derive(Default)]
struct TerminalOutputBatcher {
    pending: HashMap<String, PendingTerminalOutput>,
}

#[derive(Default)]
struct PendingTerminalOutput {
    data: String,
    raw_bytes: Vec<u8>,
    generation: u64,
    sequence: u64,
}

impl TerminalOutputBatcher {
    fn push(
        &mut self,
        runtime_session_id: String,
        data: String,
        raw_bytes: Vec<u8>,
        flow: TerminalOutputReservation,
    ) -> Vec<TerminalDataEvent> {
        let pending = self.pending.entry(runtime_session_id.clone()).or_default();
        pending.data.push_str(&data);
        pending.raw_bytes.extend(raw_bytes);
        pending.generation = flow.generation;
        pending.sequence = flow.sequence;
        if pending.raw_bytes.len() >= FLUSH_DATA_THRESHOLD_BYTES {
            self.flush_runtime(&runtime_session_id)
                .into_iter()
                .collect()
        } else {
            Vec::new()
        }
    }

    fn flush_runtime(&mut self, runtime_session_id: &str) -> Option<TerminalDataEvent> {
        let pending = self.pending.remove(runtime_session_id)?;
        if pending.data.is_empty() {
            return None;
        }
        Some(TerminalDataEvent {
            runtime_session_id: runtime_session_id.to_string(),
            generation: pending.generation,
            sequence: pending.sequence,
            data: pending.data,
            data_base64: general_purpose::STANDARD.encode(pending.raw_bytes),
        })
    }

    fn flush_all(&mut self) -> Vec<TerminalDataEvent> {
        let runtime_ids = self.pending.keys().cloned().collect::<Vec<_>>();
        runtime_ids
            .into_iter()
            .filter_map(|runtime_id| self.flush_runtime(&runtime_id))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalOutputBatcher;
    use crate::services::terminal_output_flow::TerminalOutputReservation;

    fn flow(sequence: u64) -> TerminalOutputReservation {
        TerminalOutputReservation {
            generation: 1,
            sequence,
        }
    }

    #[test]
    fn continuous_other_runtime_does_not_delay_small_output() {
        use std::{sync::mpsc, thread, time::Duration};
        let (sender, receiver) = mpsc::channel();
        let (emitted, events) = mpsc::channel();
        let worker = thread::spawn(move || {
            super::run_dispatcher_events(receiver, |event| {
                emitted.send(event).unwrap();
            })
        });
        sender
            .send(super::TerminalOutputMessage::Output {
                runtime_session_id: "quiet".into(),
                data: "prompt".into(),
                raw_bytes: b"prompt".to_vec(),
                flow: flow(1),
            })
            .unwrap();
        let producer = thread::spawn(move || {
            for _ in 0..100 {
                sender
                    .send(super::TerminalOutputMessage::Output {
                        runtime_session_id: "busy".into(),
                        data: "x".into(),
                        raw_bytes: vec![b'x'],
                        flow: flow(1),
                    })
                    .unwrap();
                thread::sleep(Duration::from_millis(2));
            }
        });
        let event = events.recv_timeout(Duration::from_millis(100));
        let mut saw_quiet = event
            .as_ref()
            .is_ok_and(|event| event.runtime_session_id == "quiet");
        if !saw_quiet {
            saw_quiet = events
                .recv_timeout(Duration::from_millis(30))
                .is_ok_and(|event| event.runtime_session_id == "quiet");
        }
        producer.join().unwrap();
        worker.join().unwrap();
        assert!(
            saw_quiet,
            "quiet runtime must flush on a deadline under continuous traffic"
        );
    }

    #[test]
    fn terminal_output_batcher_combines_chunks_with_raw_base64_continuity() {
        let mut batcher = TerminalOutputBatcher::default();

        assert!(batcher
            .push(
                "runtime-1".to_string(),
                "a".to_string(),
                vec![0x61],
                flow(1)
            )
            .is_empty());
        assert!(batcher
            .push(
                "runtime-1".to_string(),
                "b".to_string(),
                vec![0x62, 0xff],
                flow(2)
            )
            .is_empty());

        let event = batcher
            .flush_runtime("runtime-1")
            .expect("runtime output should flush");
        assert_eq!(event.runtime_session_id, "runtime-1");
        assert_eq!((event.generation, event.sequence), (1, 2));
        assert_eq!(event.data, "ab");
        assert_eq!(event.data_base64, "YWL/");
    }

    #[test]
    fn terminal_output_batcher_flushes_only_requested_runtime_before_exit() {
        let mut batcher = TerminalOutputBatcher::default();
        batcher.push(
            "runtime-1".to_string(),
            "one".to_string(),
            b"one".to_vec(),
            flow(1),
        );
        batcher.push(
            "runtime-2".to_string(),
            "two".to_string(),
            b"two".to_vec(),
            flow(1),
        );

        let event = batcher
            .flush_runtime("runtime-1")
            .expect("first runtime should flush");
        assert_eq!(event.data, "one");

        let remaining = batcher.flush_all();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].runtime_session_id, "runtime-2");
        assert_eq!(remaining[0].data, "two");
    }
}
