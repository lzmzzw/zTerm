// Author: Liz
use std::{fs::OpenOptions, io::Write, sync::Mutex, time::SystemTime};
use tauri::{AppHandle, Manager};

static LOG_LOCK: Mutex<usize> = Mutex::new(0);
static SESSION_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
const PREFIX: &[u8] = b"**\x18B";

pub fn record_session(app: &AppHandle, runtime: &str, stage: &str, header: &str) {
    if !enabled() {
        return;
    }
    let Ok(mut sessions) = SESSION_IDS.lock() else {
        return;
    };
    let index = if let Some(index) = sessions.iter().position(|id| id == runtime) {
        index
    } else if sessions.len() < 128 {
        sessions.push(runtime.to_string());
        sessions.len() - 1
    } else {
        return;
    };
    record(app, stage, &format!("session={} {header}", index + 1));
}

pub fn enabled() -> bool {
    std::env::var("ZTERM_ZMODEM_DIAGNOSTICS").as_deref() == Ok("1")
}

pub fn record(app: &AppHandle, stage: &str, header: &str) {
    if !enabled() {
        return;
    }
    let Ok(mut count) = LOG_LOCK.lock() else {
        return;
    };
    if *count >= 512 {
        return;
    }
    let Ok(directory) = app.path().app_log_dir() else {
        return;
    };
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join(format!("zmodem-diagnostic-{}.log", std::process::id()));
    if path
        .metadata()
        .is_ok_and(|metadata| metadata.len() > 128 * 1024)
    {
        return;
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if *count == 0 {
        let version = tauri::webview_version().unwrap_or_else(|_| "unavailable".into());
        let _ = writeln!(
            file,
            "diagnostic=3 app={} webview={version}",
            env!("CARGO_PKG_VERSION")
        );
    }
    let _ = writeln!(file, "{timestamp} {stage} {header}");
    *count += 1;
}

// Buffer only a protocol candidate. Ordinary terminal data is never retained in the log.
#[derive(Default)]
pub struct StartupObserver {
    pending: Vec<u8>,
}

// Recognize the hex body even if the transport stripped the CAN/padding prefix.
// The three preceding bytes are masked except for protocol/control-byte values.
#[derive(Default)]
pub struct HexBodyObserver {
    previous: Vec<u8>,
    pending: Vec<u8>,
    preamble: String,
}

impl HexBodyObserver {
    pub fn consume(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut headers = Vec::new();
        for &byte in bytes {
            if !self.pending.is_empty() {
                let valid = match self.pending.len() {
                    1 => byte == b'0',
                    2 => matches!(byte, b'0' | b'1'),
                    _ => byte.is_ascii_hexdigit(),
                };
                if valid {
                    self.pending.push(byte);
                    if self.pending.len() == 15 {
                        headers.push(
                            format!("{} {}", self.preamble, format_header(&self.pending))
                                .trim()
                                .to_string(),
                        );
                        self.pending.clear();
                    }
                } else {
                    self.pending.clear();
                }
            } else if byte == b'B' {
                self.pending.push(byte);
                self.preamble = self
                    .previous
                    .iter()
                    .map(|b| {
                        if matches!(*b, 24 | 42 | 27 | 239 | 191 | 189) {
                            format!("{b:02x}")
                        } else {
                            "other".to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
            }
            self.previous.push(byte);
            if self.previous.len() > 3 {
                self.previous.remove(0);
            }
        }
        headers
    }
}

impl StartupObserver {
    pub fn consume(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut headers = Vec::new();
        for &byte in bytes {
            if self.pending.len() < PREFIX.len() {
                self.pending.push(byte);
                while !PREFIX.starts_with(&self.pending) {
                    self.pending.remove(0);
                }
                continue;
            }
            if self.pending.len() < 18 && byte.is_ascii_hexdigit() {
                self.pending.push(byte);
                continue;
            }
            if self.pending.len() >= 18 && matches!(byte, 13 | 10 | 138 | 17 | 239 | 191 | 189) {
                self.pending.push(byte);
                if matches!(byte, 10 | 138) || self.pending.len() == 24 {
                    headers.push(format_header(&self.pending));
                    self.pending.clear();
                }
                continue;
            }
            headers.push(format!("{} other", format_header(&self.pending)));
            self.pending.clear();
            if byte == b'*' {
                self.pending.push(byte);
            }
        }
        headers
    }
}

fn format_header(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn valid_frontend_record(stage: &str, header: &str) -> bool {
    matches!(
        stage,
        "frontend-input"
            | "frontend-fragment"
            | "frontend-ready"
            | "frontend-send"
            | "frontend-receive"
            | "frontend-parse-error"
            | "frontend-missing-base64"
            | "frontend-body"
            | "frontend-ctrl-c"
            | "frontend-rz"
            | "xterm-ctrl-c"
            | "xterm-ctrl-c-replay"
    ) && header.len() <= 80
        && header.split_whitespace().all(|part| {
            part == "other" || (part.len() == 2 && part.bytes().all(|b| b.is_ascii_hexdigit()))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_headers_survive_every_fragment_boundary_without_logging_surrounding_text() {
        let header = b"**\x18B0100000023be50\r\x8a\x11";
        for split in 0..=header.len() {
            let mut observer = StartupObserver::default();
            let mut result = observer.consume(b"ordinary text password=not-a-protocol\r\n");
            result.extend(observer.consume(&header[..split]));
            result.extend(observer.consume(&header[split..]));
            result.extend(observer.consume(b"ordinary tail"));
            assert_eq!(result, vec![format_header(&header[..20])]);
        }
    }
    #[test]
    fn corrupted_terminator_is_visible_but_unrelated_text_is_not_logged() {
        let mut observer = StartupObserver::default();
        let result = observer.consume(b"**\x18B0100000023be50\r\xef\xbf\xbdsecret\n");
        assert_eq!(
            result,
            vec![format!(
                "{} other",
                format_header(b"**\x18B0100000023be50\r\xef\xbf\xbd")
            )]
        );
    }
    #[test]
    fn frontend_cannot_inject_arbitrary_log_content() {
        assert!(valid_frontend_record("frontend-input", "2a 2a 18 42 other"));
        assert!(!valid_frontend_record("arbitrary-stage", ""));
        assert!(!valid_frontend_record("frontend-input", "secret\ntext"));
        assert!(!valid_frontend_record("frontend-input", &"2a ".repeat(30)));
    }

    #[test]
    fn malformed_prefix_is_detected_without_logging_surrounding_text() {
        for header in [
            b"**B0100000023be50".as_slice(),
            b"**\x18B0100000023be50".as_slice(),
        ] {
            for split in 0..=header.len() {
                let mut observer = HexBodyObserver::default();
                assert!(observer.consume(b"ordinary-private-text.").is_empty());
                let mut result = observer.consume(&header[..split]);
                result.extend(observer.consume(&header[split..]));
                assert_eq!(result.len(), 1);
                assert!(result[0].ends_with(&format_header(b"B0100000023be50")));
                assert!(!result[0].contains("private"));
                assert!(observer.consume(b"ordinary tail").is_empty());
            }
        }
    }
}
