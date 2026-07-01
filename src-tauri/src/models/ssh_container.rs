// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub running: bool,
}
