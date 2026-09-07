use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::{
    error::{AppError, AppResult},
    models::{ai::AiApprovalMode, terminal::RuntimeSessionInfo},
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentCodexSession {
    pub agent_session_id: String,
    pub target_runtime_session_id: String,
    pub target_saved_session_id: Option<String>,
    pub target_label: String,
    pub approval_mode: AiApprovalMode,
    pub runtime: RuntimeSessionInfo,
}

type SessionSlot = Arc<AsyncMutex<Option<AgentCodexSession>>>;

/// A launch/close gate per connection; independent connections can start concurrently.
#[derive(Default)]
pub struct AgentCodexRegistry {
    slots: Mutex<HashMap<String, SessionSlot>>,
}

pub fn connection_key(saved_session_id: Option<&str>, runtime_session_id: &str) -> String {
    match saved_session_id {
        Some(id) => format!("connection:{id}"),
        None => format!("runtime:{runtime_session_id}"),
    }
}

impl AgentCodexRegistry {
    pub async fn clear(&self, key: &str, agent_session_id: &str) -> AppResult<()> {
        let mut slot = self.lock(key).await?;
        if slot
            .as_ref()
            .is_some_and(|session| session.agent_session_id == agent_session_id)
        {
            *slot = None;
        }
        Ok(())
    }

    pub async fn lock(&self, key: &str) -> AppResult<OwnedMutexGuard<Option<AgentCodexSession>>> {
        let slot = self
            .slots
            .lock()
            .map_err(|_| AppError::ai("Agent 会话锁已损坏"))?
            .entry(key.to_string())
            .or_default()
            .clone();
        Ok(slot.lock_owned().await)
    }

    pub async fn find(
        &self,
        agent_session_id: &str,
    ) -> AppResult<Option<OwnedMutexGuard<Option<AgentCodexSession>>>> {
        let slots = self
            .slots
            .lock()
            .map_err(|_| AppError::ai("Agent 会话锁已损坏"))?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for slot in slots {
            let guard = slot.lock_owned().await;
            if guard
                .as_ref()
                .is_some_and(|session| session.agent_session_id == agent_session_id)
            {
                return Ok(Some(guard));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::terminal::RuntimeSessionKind;

    fn session() -> AgentCodexSession {
        AgentCodexSession {
            agent_session_id: "agent-a".into(),
            target_runtime_session_id: "ssh-tab-a".into(),
            target_saved_session_id: Some("ssh-a".into()),
            target_label: "SSH A".into(),
            approval_mode: AiApprovalMode::Safe,
            runtime: RuntimeSessionInfo {
                runtime_session_id: "codex-pty-a".into(),
                saved_session_id: None,
                history_scope_kind: None,
                history_scope_id: None,
                pane_id: "agent:connection:ssh-a".into(),
                title: "Codex".into(),
                kind: RuntimeSessionKind::Local,
                initial_cwd: None,
                cols: 80,
                rows: 30,
            },
        }
    }

    #[tokio::test]
    async fn queued_tab_observes_published_process_and_close_clears_shared_slot() {
        let registry = Arc::new(AgentCodexRegistry::default());
        let mut first = registry.lock("connection:ssh-a").await.unwrap();
        let queued_registry = registry.clone();
        let queued = tokio::spawn(async move {
            queued_registry
                .lock("connection:ssh-a")
                .await
                .unwrap()
                .clone()
        });
        *first = Some(session());
        drop(first);
        let reused = queued.await.unwrap().unwrap();
        assert_eq!(reused.runtime.runtime_session_id, "codex-pty-a");
        assert_eq!(reused.target_runtime_session_id, "ssh-tab-a");
        assert!(registry.find("unrelated-agent").await.unwrap().is_none());
        let mut closing = registry.find("agent-a").await.unwrap().unwrap();
        *closing = None;
        drop(closing);
        assert!(registry.lock("connection:ssh-a").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn late_exit_cleanup_does_not_remove_a_replacement_process() {
        let registry = AgentCodexRegistry::default();
        *registry.lock("connection:ssh-a").await.unwrap() = Some(session());
        registry
            .clear("connection:ssh-a", "previous-agent")
            .await
            .unwrap();
        assert!(registry.find("agent-a").await.unwrap().is_some());
        registry.clear("connection:ssh-a", "agent-a").await.unwrap();
        assert!(registry.find("agent-a").await.unwrap().is_none());
    }

    #[test]
    fn identity_is_connection_scoped_and_transient_runtimes_stay_isolated() {
        assert_eq!(
            connection_key(Some("ssh-1"), "tab-a"),
            connection_key(Some("ssh-1"), "tab-b")
        );
        assert_ne!(
            connection_key(Some("ssh-1"), "a"),
            connection_key(Some("ssh-2"), "a")
        );
        assert_ne!(connection_key(None, "a"), connection_key(None, "b"));
        assert_ne!(connection_key(None, "a"), connection_key(Some("a"), "a"));
    }

    #[tokio::test]
    async fn concurrent_opens_share_gate_without_blocking_other_connections() {
        let registry = Arc::new(AgentCodexRegistry::default());
        let first = registry.lock("connection:a").await.unwrap();
        let pending_registry = registry.clone();
        let mut pending =
            tokio::spawn(async move { pending_registry.lock("connection:a").await.unwrap() });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut pending)
                .await
                .is_err()
        );
        let other = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            registry.lock("connection:b"),
        )
        .await
        .unwrap()
        .unwrap();
        drop(other);
        drop(first);
        assert!(pending.await.is_ok());
    }
}
