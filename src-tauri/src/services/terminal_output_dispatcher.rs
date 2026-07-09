// Author: Liz
use std::{collections::HashMap, sync::mpsc, thread, time::Duration};

use base64::{engine::general_purpose, Engine as _};
use tauri::{AppHandle, Emitter};

use crate::models::terminal::TerminalDataEvent;

const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_DATA_THRESHOLD_BYTES: usize = 32 * 1024;

#[derive(Clone)]
pub struct TerminalOutputDispatcher {
    sender: Option<mpsc::Sender<TerminalOutputMessage>>,
}

impl TerminalOutputDispatcher {
    pub fn new(app: Option<AppHandle>) -> Self {
        let Some(app) = app else {
            return Self { sender: None };
        };
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || run_dispatcher(app, receiver));
        Self {
            sender: Some(sender),
        }
    }

    pub fn push(&self, runtime_session_id: &str, data: String, raw_bytes: Vec<u8>) {
        if data.is_empty() {
            return;
        }
        if let Some(sender) = &self.sender {
            let _ = sender.send(TerminalOutputMessage::Output {
                runtime_session_id: runtime_session_id.to_string(),
                data,
                raw_bytes,
            });
        }
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
    },
    FlushRuntime {
        runtime_session_id: String,
        ack: mpsc::Sender<()>,
    },
}

fn run_dispatcher(app: AppHandle, receiver: mpsc::Receiver<TerminalOutputMessage>) {
    let mut batcher = TerminalOutputBatcher::default();
    loop {
        match receiver.recv_timeout(FLUSH_INTERVAL) {
            Ok(TerminalOutputMessage::Output {
                runtime_session_id,
                data,
                raw_bytes,
            }) => {
                for event in batcher.push(runtime_session_id, data, raw_bytes) {
                    let _ = app.emit("terminal:data", event);
                }
            }
            Ok(TerminalOutputMessage::FlushRuntime {
                runtime_session_id,
                ack,
            }) => {
                if let Some(event) = batcher.flush_runtime(&runtime_session_id) {
                    let _ = app.emit("terminal:data", event);
                }
                let _ = ack.send(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                for event in batcher.flush_all() {
                    let _ = app.emit("terminal:data", event);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                for event in batcher.flush_all() {
                    let _ = app.emit("terminal:data", event);
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
}

impl TerminalOutputBatcher {
    fn push(
        &mut self,
        runtime_session_id: String,
        data: String,
        raw_bytes: Vec<u8>,
    ) -> Vec<TerminalDataEvent> {
        let pending = self.pending.entry(runtime_session_id.clone()).or_default();
        pending.data.push_str(&data);
        pending.raw_bytes.extend(raw_bytes);
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

    #[test]
    fn terminal_output_batcher_combines_chunks_with_raw_base64_continuity() {
        let mut batcher = TerminalOutputBatcher::default();

        assert!(batcher
            .push("runtime-1".to_string(), "a".to_string(), vec![0x61])
            .is_empty());
        assert!(batcher
            .push("runtime-1".to_string(), "b".to_string(), vec![0x62, 0xff])
            .is_empty());

        let event = batcher
            .flush_runtime("runtime-1")
            .expect("runtime output should flush");
        assert_eq!(event.runtime_session_id, "runtime-1");
        assert_eq!(event.data, "ab");
        assert_eq!(event.data_base64, "YWL/");
    }

    #[test]
    fn terminal_output_batcher_flushes_only_requested_runtime_before_exit() {
        let mut batcher = TerminalOutputBatcher::default();
        batcher.push("runtime-1".to_string(), "one".to_string(), b"one".to_vec());
        batcher.push("runtime-2".to_string(), "two".to_string(), b"two".to_vec());

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
