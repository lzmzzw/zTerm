// Author: Liz
use crate::models::ai::RiskLevel;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRisk {
    pub risk_level: RiskLevel,
    pub reason: String,
    pub expected_effect: String,
}

pub fn classify_command(command: &str) -> CommandRisk {
    let (risk_level, reason, effect) = match classify_script(command, 0) {
        RiskLevel::Critical => (
            RiskLevel::Critical,
            "命令可能破坏文件系统或磁盘数据",
            "可能删除或格式化关键数据",
        ),
        RiskLevel::High => (
            RiskLevel::High,
            "命令可能删除数据或修改系统安全状态、服务可用性",
            "请核对目标、影响及恢复办法",
        ),
        RiskLevel::Low => (RiskLevel::Low, "只读查询命令", "仅显示当前环境信息"),
        RiskLevel::Medium => (
            RiskLevel::Medium,
            "常规操作或无法完全判断的命令",
            "可能影响当前会话或目标路径",
        ),
    };
    CommandRisk {
        risk_level,
        reason: reason.into(),
        expected_effect: effect.into(),
    }
}

fn classify_script(script: &str, depth: usize) -> RiskLevel {
    if depth >= 8 {
        return RiskLevel::High;
    }
    let (commands, expansions) = shell_commands(script);
    commands
        .iter()
        .map(|words| classify_words(words, depth))
        .chain(
            expansions
                .iter()
                .map(|script| classify_script(script, depth + 1)),
        )
        .max_by_key(risk_rank)
        .unwrap_or(RiskLevel::Medium)
}

fn classify_words(words: &[String], depth: usize) -> RiskLevel {
    if depth >= 8 {
        return RiskLevel::High;
    }
    let mut words = words;
    while let Some(word) = words.first() {
        let name = command_name(word);
        if let Some(operator) = word
            .find(['<', '>'])
            .filter(|index| word[..*index].chars().all(|c| c.is_ascii_digit()))
        {
            let target = word[operator..].trim_start_matches(['<', '>']);
            words = &words[if target.is_empty() {
                words.len().min(2)
            } else {
                1
            }..];
        } else if name == "timeout" {
            words = &words[1..];
            let index = positional_index(words, &["-k", "--kill-after", "-s", "--signal"]);
            words = &words[(index + 1).min(words.len())..];
        } else if matches!(
            name,
            "if" | "then" | "elif" | "else" | "do" | "while" | "until" | "!" | "time"
        ) || word.split_once('=').is_some_and(|(name, _)| {
            !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }) {
            words = &words[1..];
        } else if matches!(name, "sudo" | "env" | "command" | "exec" | "nohup") {
            words = &words[1..];
            if name == "command"
                && words
                    .first()
                    .is_some_and(|word| matches!(word.as_str(), "-v" | "-V"))
            {
                return RiskLevel::Medium;
            }
            while let Some(option) = words.first().filter(|word| word.starts_with('-')) {
                let takes_value = matches!(
                    option.as_str(),
                    "-u" | "-g"
                        | "-h"
                        | "-p"
                        | "-C"
                        | "-T"
                        | "--user"
                        | "--group"
                        | "--host"
                        | "--chdir"
                );
                words = &words[1..];
                if takes_value && !words.is_empty() {
                    words = &words[1..];
                }
            }
        } else {
            break;
        }
    }
    let Some((name, args)) = words.split_first() else {
        return RiskLevel::Medium;
    };
    let name = command_name(name).to_ascii_lowercase();
    let has = |values: &[&str]| args.iter().any(|arg| values.contains(&arg.as_str()));
    let action_index = positional_index(
        args,
        match name.as_str() {
            "systemctl" => &[
                "-H",
                "--host",
                "-M",
                "--machine",
                "-p",
                "--property",
                "-t",
                "--type",
                "--state",
                "--job-mode",
                "--root",
                "--image",
            ],
            "docker" => &["-H", "--host", "--context", "--config", "-l", "--log-level"],
            "kubectl" => &[
                "-n",
                "--namespace",
                "--context",
                "--kubeconfig",
                "--server",
                "--user",
                "--cluster",
            ],
            _ => &[],
        },
    );
    let action = args
        .get(action_index)
        .map(String::as_str)
        .unwrap_or_default();
    if matches!(
        name.as_str(),
        "python"
            | "python3"
            | "python2"
            | "perl"
            | "ruby"
            | "node"
            | "nodejs"
            | "pwsh"
            | "powershell"
    ) {
        // Interpreter payloads are opaque: retain conservative checks for explicit
        // dangerous operations, rather than treating arbitrary program text as shell.
        let payload = args.join(" ").to_ascii_lowercase();
        if ["rm -rf /", "mkfs", "dd if=/dev/zero", "diskpart", "format "]
            .iter()
            .any(|word| payload.contains(word))
        {
            return RiskLevel::Critical;
        }
        if [
            "reboot",
            "shutdown",
            "poweroff",
            "rm -rf",
            "rm -fr",
            "userdel",
            "systemctl stop",
            "systemctl disable",
            "shutil.rmtree",
            "iptables -f",
            "iptables -a",
            "ufw allow",
            "docker rm",
            "kubectl delete",
        ]
        .iter()
        .any(|word| payload.contains(word))
        {
            return RiskLevel::High;
        }
    }
    if name == "find" {
        if let Some(index) = args
            .iter()
            .position(|arg| matches!(arg.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir"))
        {
            return classify_words(&args[index + 1..], depth + 1);
        }
    }
    if name == "xargs" || name == "busybox" {
        let index = positional_index(
            args,
            if name == "xargs" {
                &[
                    "-I",
                    "-i",
                    "--replace",
                    "-n",
                    "--max-args",
                    "-P",
                    "--max-procs",
                    "-L",
                    "--max-lines",
                    "-s",
                    "--max-chars",
                    "-d",
                    "--delimiter",
                    "-E",
                    "--eof",
                ]
            } else {
                &[]
            },
        );
        return classify_words(&args[index..], depth + 1);
    }
    if matches!(name.as_str(), "sh" | "bash" | "dash" | "zsh" | "ksh") {
        if let Some(index) = args
            .iter()
            .position(|arg| arg.starts_with('-') && arg[1..].contains('c'))
        {
            if let Some(script) = args.get(index + 1) {
                return classify_script(script, depth + 1);
            }
        }
    }
    if name == "eval" {
        return classify_script(&args.join(" "), depth + 1);
    }
    if name.starts_with("mkfs")
        || matches!(name.as_str(), "format" | "diskpart")
        || (name == "dd"
            && args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "if=/dev/zero" | "if=/dev/random" | "if=/dev/urandom"
                )
            }))
    {
        return RiskLevel::Critical;
    }
    if name == "rm"
        && (has(&["--recursive"])
            || args.iter().any(|arg| {
                arg.starts_with('-') && !arg.starts_with("--") && arg.contains(['r', 'R'])
            }))
    {
        return if has(&["/", "/*", "/."]) {
            RiskLevel::Critical
        } else {
            RiskLevel::High
        };
    }
    if matches!(name.as_str(), "rd" | "rmdir")
        && args.iter().any(|arg| arg.eq_ignore_ascii_case("/s"))
    {
        return RiskLevel::High;
    }
    if matches!(
        name.as_str(),
        "userdel" | "deluser" | "shutdown" | "reboot" | "poweroff" | "halt"
    ) || (name == "chmod" && has(&["-R", "--recursive"]) && has(&["777"]))
        || (name == "systemctl"
            && matches!(
                action,
                "stop" | "disable" | "mask" | "reboot" | "poweroff" | "halt"
            ))
        || (name == "service"
            && args.get(action_index + 1).is_some_and(|action| {
                matches!(
                    action.as_str(),
                    "start" | "stop" | "restart" | "reload" | "force-reload"
                )
            }))
        || (name == "ufw" && matches!(action, "allow" | "delete" | "disable" | "reset"))
        || (name == "netsh"
            && has(&["advfirewall"])
            && has(&["add", "delete", "set", "reset", "import"]))
        || (name == "kubectl" && action == "delete")
        || (name == "docker"
            && (matches!(action, "rm" | "rmi")
                || (action == "container"
                    && args.get(action_index + 1).is_some_and(|arg| arg == "rm"))
                || (action == "compose" && {
                    let compose_args = &args[action_index + 1..];
                    compose_args
                        .get(positional_index(
                            compose_args,
                            &[
                                "-f",
                                "--file",
                                "-p",
                                "--project-name",
                                "--env-file",
                                "--profile",
                                "--project-directory",
                            ],
                        ))
                        .is_some_and(|arg| arg == "down")
                })))
        || (name == "firewall-cmd"
            && args.iter().any(|arg| {
                matches!(
                    arg.as_str(),
                    "--reload" | "--complete-reload" | "--runtime-to-permanent"
                ) || [
                    "--add-",
                    "--remove-",
                    "--new-",
                    "--delete-",
                    "--set-",
                    "--change-interface",
                ]
                .iter()
                .any(|prefix| arg.starts_with(prefix))
            }))
        || (matches!(name.as_str(), "iptables" | "ip6tables")
            && has(&[
                "-A",
                "-D",
                "-I",
                "-R",
                "-F",
                "-X",
                "-P",
                "-N",
                "-E",
                "-Z",
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
            ]))
    {
        return RiskLevel::High;
    }
    if matches!(name.as_str(), "pwd" | "ls" | "whoami" | "hostname" | "date") {
        RiskLevel::Low
    } else {
        RiskLevel::Medium
    }
}

fn command_name(token: &str) -> &str {
    token.rsplit(['/', '\\']).next().unwrap_or(token)
}
fn positional_index(args: &[String], value_options: &[&str]) -> usize {
    let mut index = 0;
    while let Some(option) = args.get(index).filter(|arg| arg.starts_with('-')) {
        index += if value_options.contains(&option.as_str()) {
            2
        } else {
            1
        };
    }
    index.min(args.len())
}
fn risk_rank(level: &RiskLevel) -> u8 {
    match level {
        RiskLevel::Low => 0,
        RiskLevel::Medium => 1,
        RiskLevel::High => 2,
        RiskLevel::Critical => 3,
    }
}

// A risk heuristic, not a shell sandbox. Keep quoted data/comments out of command
// matching, but assess executable substitutions and shell -c/eval contents separately.
fn shell_commands(script: &str) -> (Vec<Vec<String>>, Vec<String>) {
    let chars: Vec<char> = script.chars().collect();
    let mut commands = Vec::new();
    let mut expansions = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        if c == '\\' && quote != Some('\'') {
            if let Some(next) = chars.get(index + 1) {
                if *next != '\n' && *next != '\r' {
                    word.push(*next);
                }
                index += 2;
                continue;
            }
        }
        if quote != Some('\'') && (c == '`' || (c == '$' && chars.get(index + 1) == Some(&'('))) {
            let start = index + if c == '`' { 1 } else { 2 };
            let end = expansion_end(&chars, start, if c == '`' { '`' } else { ')' });
            expansions.push(chars[start..end].iter().collect());
            word.push_str("__expansion__");
            index = (end + 1).min(chars.len());
            continue;
        }
        if let Some(delimiter) = quote {
            if c == delimiter {
                quote = None;
            } else {
                word.push(c);
            }
        } else if matches!(c, '\'' | '"') {
            quote = Some(c);
        } else if c == '#' && word.is_empty() {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        } else if c.is_whitespace() || matches!(c, ';' | '|' | '&' | '(' | ')' | '{' | '}') {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            if matches!(c, '\n' | '\r' | ';' | '|' | '&' | '(' | ')' | '{' | '}')
                && !words.is_empty()
            {
                commands.push(std::mem::take(&mut words));
            }
        } else {
            word.push(c);
        }
        index += 1;
    }
    if !word.is_empty() {
        words.push(word);
    }
    if !words.is_empty() {
        commands.push(words);
    }
    (commands, expansions)
}

fn expansion_end(chars: &[char], start: usize, terminator: char) -> usize {
    let mut nesting: usize = 0;
    let mut quote = None;
    let mut index = start;
    while index < chars.len() {
        let c = chars[index];
        if c == '\\' && quote != Some('\'') {
            index += 2;
            continue;
        }
        if quote.is_none() && c == terminator && nesting == 0 {
            return index;
        }
        if let Some(delimiter) = quote {
            if c == delimiter {
                quote = None;
            }
        } else if matches!(c, '\'' | '"') {
            quote = Some(c);
        } else if c == '(' {
            nesting += 1;
        } else if c == ')' {
            nesting = nesting.saturating_sub(1);
        }
        index += 1;
    }
    chars.len()
}
