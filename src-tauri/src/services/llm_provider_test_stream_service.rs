// Author: Liz
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};

#[derive(Clone, Default)]
pub struct LlmProviderTestStreamService {
    controls: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl LlmProviderTestStreamService {
    pub fn register(&self, test_id: &str) -> AppResult<oneshot::Receiver<()>> {
        let (sender, receiver) = oneshot::channel();
        let mut controls = self
            .controls
            .lock()
            .map_err(|_| AppError::ai("模型测试取消控制锁已损坏"))?;
        controls.insert(test_id.to_string(), sender);
        Ok(receiver)
    }

    pub fn cancel(&self, test_id: &str) -> AppResult<bool> {
        let sender = self
            .controls
            .lock()
            .map_err(|_| AppError::ai("模型测试取消控制锁已损坏"))?
            .remove(test_id);
        if let Some(sender) = sender {
            let _ = sender.send(());
            return Ok(true);
        }
        Ok(false)
    }

    pub fn finish(&self, test_id: &str) {
        if let Ok(mut controls) = self.controls.lock() {
            controls.remove(test_id);
        }
    }

    pub fn cancel_all(&self) -> AppResult<usize> {
        let controls = std::mem::take(
            &mut *self
                .controls
                .lock()
                .map_err(|_| AppError::ai("模型测试取消控制锁已损坏"))?,
        );
        let count = controls.len();
        for (_, sender) in controls {
            let _ = sender.send(());
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::LlmProviderTestStreamService;

    #[test]
    fn cancel_registered_test_once_and_finish_removes_control() {
        let service = LlmProviderTestStreamService::default();
        let mut receiver = service
            .register("test-1")
            .expect("test control should register");

        assert!(
            service.cancel("test-1").expect("cancel should succeed"),
            "registered test should be cancellable"
        );
        assert!(
            receiver.try_recv().is_ok(),
            "cancelled receiver should observe the signal"
        );
        assert!(
            !service
                .cancel("test-1")
                .expect("repeat cancel should succeed"),
            "cancel should be one-shot"
        );

        let _receiver = service
            .register("test-2")
            .expect("second test control should register");
        service.finish("test-2");
        assert!(
            !service
                .cancel("test-2")
                .expect("cancel after finish should succeed"),
            "finished test should not keep a stale control"
        );
    }

    #[test]
    fn cancel_all_notifies_every_registered_test() {
        let service = LlmProviderTestStreamService::default();
        let mut first = service
            .register("test-1")
            .expect("first test should register");
        let mut second = service
            .register("test-2")
            .expect("second test should register");

        assert_eq!(service.cancel_all().expect("all tests should cancel"), 2);
        assert!(first.try_recv().is_ok());
        assert!(second.try_recv().is_ok());
        assert_eq!(
            service.cancel_all().expect("repeat cancel should be safe"),
            0
        );
    }
}
