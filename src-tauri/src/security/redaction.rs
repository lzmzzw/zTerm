// Author: Liz
use crate::error::AppError;

pub fn redact_error(error: &AppError) -> String {
    redact_sensitive(&error.to_string())
}

pub fn redact_sensitive(input: &str) -> String {
    let private_key_redacted = redact_private_key_blocks(input);
    let url_redacted = redact_url_passwords(&private_key_redacted);
    let token_redacted = redact_prefixed_tokens(&url_redacted, "sk-");
    let bearer_redacted = redact_bearer_tokens(&token_redacted);
    redact_assignment_values(
        &bearer_redacted,
        &["password", "passwd", "api_key", "apikey", "token", "secret"],
    )
}

fn redact_private_key_blocks(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(begin) = rest.find("-----BEGIN") {
        output.push_str(&rest[..begin]);
        let after_begin = &rest[begin..];
        if let Some(end) = after_begin.find("-----END") {
            let after_end_marker = &after_begin[end..];
            if let Some(close) = after_end_marker.find("-----") {
                output.push_str("<redacted-secret>");
                rest = &after_end_marker[close + 5..];
                continue;
            }
        }
        output.push_str("<redacted-secret>");
        return output;
    }
    output.push_str(rest);
    output
}

fn redact_url_passwords(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(relative) = input[index..].find("://") {
        let scheme_separator = index + relative;
        let authority_start = scheme_separator + "://".len();
        let token_end = input[authority_start..]
            .find(|ch: char| ch.is_whitespace() || matches!(ch, ';' | ',' | '"' | '\''))
            .map(|offset| authority_start + offset)
            .unwrap_or(input.len());
        let authority_and_path = &input[authority_start..token_end];
        if let Some(at_offset) = authority_and_path.find('@') {
            let userinfo = &authority_and_path[..at_offset];
            if let Some(colon_offset) = userinfo.rfind(':') {
                let password_start = authority_start + colon_offset + 1;
                let password_end = authority_start + at_offset;
                if password_start < password_end {
                    output.push_str(&input[index..password_start]);
                    output.push_str("<redacted-secret>");
                    index = password_end;
                    continue;
                }
            }
        }
        output.push_str(&input[index..authority_start]);
        index = authority_start;
    }
    output.push_str(&input[index..]);
    output
}

fn redact_prefixed_tokens(input: &str, prefix: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find(prefix) {
        output.push_str(&rest[..index]);
        output.push_str("<redacted-secret>");
        let tail = &rest[index + prefix.len()..];
        let end = tail
            .find(|ch: char| ch.is_whitespace() || matches!(ch, ';' | ',' | '"' | '\''))
            .unwrap_or(tail.len());
        rest = &tail[end..];
    }
    output.push_str(rest);
    output
}

fn redact_bearer_tokens(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(relative) = lower[index..].find("bearer ") {
        let bearer_start = index + relative;
        let token_start = bearer_start + "bearer ".len();
        let token_end = input[token_start..]
            .find(|ch: char| ch.is_whitespace() || matches!(ch, ';' | ',' | '"' | '\''))
            .map(|offset| token_start + offset)
            .unwrap_or(input.len());
        output.push_str(&input[index..token_start]);
        output.push_str("<redacted-secret>");
        index = token_end;
    }
    output.push_str(&input[index..]);
    output
}

fn redact_assignment_values(input: &str, keys: &[&str]) -> String {
    let mut output = input.to_string();
    for key in keys {
        output = redact_key_assignment(&output, key);
    }
    output
}

fn redact_key_assignment(input: &str, key: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while let Some(relative) = input[index..].to_ascii_lowercase().find(key) {
        let key_start = index + relative;
        let key_end = key_start + key.len();
        let mut cursor = key_end;
        while input[cursor..].starts_with(' ') {
            cursor += 1;
        }
        if !(input[cursor..].starts_with('=') || input[cursor..].starts_with(':')) {
            output.push_str(&input[index..key_end]);
            index = key_end;
            continue;
        }
        cursor += 1;
        while input[cursor..].starts_with(' ') {
            cursor += 1;
        }
        let value_end = input[cursor..]
            .find(|ch: char| ch.is_whitespace() || matches!(ch, ';' | ',' | '"' | '\''))
            .map(|offset| cursor + offset)
            .unwrap_or(input.len());
        output.push_str(&input[index..cursor]);
        output.push_str("<redacted-secret>");
        index = value_end;
    }
    output.push_str(&input[index..]);
    output
}
