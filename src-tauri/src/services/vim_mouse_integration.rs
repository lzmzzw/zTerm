//! Vim configuration inherited only by terminals created by zTerm.
pub(crate) fn vim_init() -> String {
    let script = include_str!("vim_mouse_init.vim")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "")
        .replace('\n', "\\n");
    format!("execute \"{script}\"")
}

pub(crate) fn original_init(value: Option<String>) -> String {
    match value {
        Some(value) if value != vim_init() => value,
        Some(_) => std::env::var("ZTERM_USER_VIMINIT").unwrap_or_default(),
        None => String::new(),
    }
}

pub(crate) fn ssh_shell_command() -> String {
    // Use a POSIX bootstrap independently of the user's interactive shell.
    // No shell input is injected, and no remote startup file is modified.
    let init = vim_init().replace('\'', "'\"'\"'");
    let script = format!(
        "if [ \"${{VIMINIT-}}\" != '{init}' ]; then ZTERM_USER_VIMINIT=${{VIMINIT-}}; fi; export ZTERM_USER_VIMINIT; VIMINIT='{init}'; export VIMINIT; exec \"${{SHELL:-/bin/sh}}\" -l"
    );
    format!("/bin/sh -c '{}'", script.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_init_is_an_ex_command_and_shell_quoted() {
        let init = vim_init();
        assert!(init.starts_with("execute \""));
        assert!(!init.contains('\n'));
        assert!(init.contains("VimEnter * set mouse=a"));
        let shell = ssh_shell_command();
        assert!(shell.starts_with("/bin/sh -c '"));
        assert!(shell.contains("exec"));
        assert!(!shell.contains(" >"));
        assert_eq!(
            original_init(Some("let g:custom = 42".into())),
            "let g:custom = 42"
        );
    }
}
