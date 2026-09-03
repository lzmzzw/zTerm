// Author: Liz
use crate::models::ai::RiskLevel;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRisk {
    pub risk_level: RiskLevel,
    pub reason: String,
    pub expected_effect: String,
}

pub fn classify_command(command: &str) -> CommandRisk {
    let command = command.trim();
    let normalized = command.to_ascii_lowercase();
    if normalized.is_empty() {
        return risk(RiskLevel::Medium, "空命令无法判断风险", "不会执行任何操作");
    }

    if contains_any(
        &normalized,
        &[
            "rm -rf /",
            "mkfs",
            "format ",
            "diskpart",
            "dd if=/dev/zero",
            "dd if=/dev/random",
        ],
    ) {
        return risk(
            RiskLevel::Critical,
            "命令可能破坏文件系统或磁盘数据",
            "可能删除或格式化关键数据",
        );
    }
    if contains_any(&normalized, &["rm -rf", "rm -fr", "rd /s", "rmdir /s"]) {
        return risk(
            RiskLevel::High,
            "命令可能递归删除文件或目录",
            "可能删除目标路径及其子内容",
        );
    }
    if contains_any(
        &normalized,
        &[
            "userdel",
            "deluser",
            "chmod -r 777",
            "systemctl stop",
            "systemctl disable",
            "shutdown",
            "reboot",
            "ufw allow",
            "netsh advfirewall",
            "kubectl delete",
            "docker rm",
            "docker compose down",
        ],
    ) || command_has_mutating_argument(
        &normalized,
        "service",
        &["start", "stop", "restart", "reload", "force-reload"],
    ) || command_has_mutating_argument(
        &normalized,
        "firewall-cmd",
        &[
            "--reload",
            "--complete-reload",
            "--runtime-to-permanent",
            "--permanent",
            "--add-",
            "--remove-",
            "--new-",
            "--delete-",
            "--set-",
            "--change-interface",
        ],
    ) || command_has_mutating_argument(
        command,
        "iptables",
        &["-A", "-D", "-I", "-R", "-F", "-X", "-P", "-N", "-E"],
    ) || command_has_mutating_argument(
        &normalized,
        "iptables",
        &[
            "--append",
            "--delete",
            "--insert",
            "--replace",
            "--flush",
            "--zero",
            "--policy",
            "--new-chain",
            "--delete-chain",
            "--rename-chain",
        ],
    ) {
        return risk(
            RiskLevel::High,
            "命令可能修改权限、用户、服务或网络暴露面",
            "可能改变系统安全状态或服务可用性",
        );
    }
    if contains_any(&normalized, &["rm ", "mv ", "chmod ", "chown ", "kill "]) {
        return risk(
            RiskLevel::Medium,
            "命令可能修改文件或进程状态",
            "可能影响当前会话或目标路径",
        );
    }
    if matches!(
        normalized.as_str(),
        "pwd" | "ls" | "ls -la" | "whoami" | "hostname" | "date"
    ) {
        return risk(RiskLevel::Low, "只读查询命令", "仅显示当前环境信息");
    }
    risk(
        RiskLevel::Medium,
        "无法完全判断命令影响",
        "请确认命令符合预期",
    )
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

fn command_has_mutating_argument(value: &str, command: &str, mutating_arguments: &[&str]) -> bool {
    value
        .lines()
        .flat_map(|line| line.split([';', '|']))
        .any(|segment| {
            let tokens = segment
                .split_whitespace()
                .map(normalize_shell_token)
                .collect::<Vec<_>>();
            tokens.iter().enumerate().any(|(index, token)| {
                command_name(token) == command
                    && tokens[index + 1..].iter().any(|argument| {
                        mutating_arguments.iter().any(|candidate| {
                            argument == candidate
                                || (candidate.ends_with('-') && argument.starts_with(candidate))
                        })
                    })
            })
        })
}

fn normalize_shell_token(token: &str) -> &str {
    token.trim_matches(|character: char| {
        character.is_ascii_punctuation() && !matches!(character, '-' | '_' | '/' | '\\')
    })
}

fn command_name(token: &str) -> &str {
    token.rsplit(['/', '\\']).next().unwrap_or(token)
}

fn risk(risk_level: RiskLevel, reason: &str, expected_effect: &str) -> CommandRisk {
    CommandRisk {
        risk_level,
        reason: reason.to_string(),
        expected_effect: expected_effect.to_string(),
    }
}
