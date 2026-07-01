// Author: Liz
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

#[derive(Clone, Default)]
pub struct AiChatStreamService {
    controls: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl AiChatStreamService {
    pub fn register(&self, chat_id: &str) -> AppResult<oneshot::Receiver<()>> {
        let (sender, receiver) = oneshot::channel();
        let mut controls = self
            .controls
            .lock()
            .map_err(|_| AppError::ai("AI 对话取消控制锁已损坏"))?;
        controls.insert(chat_id.to_string(), sender);
        Ok(receiver)
    }

    pub fn cancel(&self, chat_id: &str) -> AppResult<bool> {
        let sender = self
            .controls
            .lock()
            .map_err(|_| AppError::ai("AI 对话取消控制锁已损坏"))?
            .remove(chat_id);
        if let Some(sender) = sender {
            let _ = sender.send(());
            return Ok(true);
        }
        Ok(false)
    }

    pub fn finish(&self, chat_id: &str) {
        if let Ok(mut controls) = self.controls.lock() {
            controls.remove(chat_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AiChatStreamService;

    #[test]
    fn cancel_registered_chat_once_and_finish_removes_control() {
        let service = AiChatStreamService::default();
        let mut receiver = service
            .register("chat-1")
            .expect("chat stream control should register");

        assert!(
            service.cancel("chat-1").expect("cancel should succeed"),
            "registered chat should be cancellable"
        );
        assert!(
            receiver.try_recv().is_ok(),
            "cancelled receiver should observe the signal"
        );
        assert!(
            !service
                .cancel("chat-1")
                .expect("repeat cancel should succeed"),
            "cancel should be one-shot"
        );

        let _receiver = service
            .register("chat-2")
            .expect("second chat stream control should register");
        service.finish("chat-2");
        assert!(
            !service
                .cancel("chat-2")
                .expect("cancel after finish should succeed"),
            "finished chat should not keep a stale control"
        );
    }
}
