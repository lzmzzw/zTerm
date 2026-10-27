// Author: Liz
//! Native SSH trust policy shared by interactive and background connections.
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use base64::Engine;
use ring::hmac;
use russh::keys::{self, ssh_key::known_hosts::HostPatterns, PublicKey};

// Checking and learning are one operation within this process, including when
// several terminal, exec and SFTP connections encounter a new host together.
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedHostKey {
    host: String,
    port: u16,
    key: PublicKey,
}

impl VerifiedHostKey {
    pub(crate) fn verify(host: &str, port: u16, key: &PublicKey) -> Result<Self, keys::Error> {
        verify_server_key(host, port, key)?;
        Ok(Self {
            host: host.to_owned(),
            port,
            key: key.clone(),
        })
    }

    /// Cached transports must not retain trust after the recorded identity is
    /// removed, changed, revoked or made unreadable. Reuse never learns a key.
    pub(crate) fn recheck(&self) -> Result<(), keys::Error> {
        verify_server_key_at_path(
            &self.host,
            self.port,
            &self.key,
            &known_hosts_path()?,
            false,
        )
    }
}

pub(crate) fn verify_server_key(host: &str, port: u16, key: &PublicKey) -> Result<(), keys::Error> {
    verify_server_key_at_path(host, port, key, &known_hosts_path()?, true)
}

fn known_hosts_path() -> Result<PathBuf, keys::Error> {
    #[cfg(not(test))]
    {
        Ok(dirs::home_dir()
            .ok_or(keys::Error::NoHomeDir)?
            .join(".ssh")
            .join("known_hosts"))
    }
    #[cfg(test)]
    {
        static PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        Ok(PATH
            .get_or_init(|| {
                std::env::temp_dir()
                    .join(format!("zterm-test-known-hosts-{}", uuid::Uuid::new_v4()))
            })
            .clone())
    }
}

fn verify_server_key_at_path(
    host: &str,
    port: u16,
    key: &PublicKey,
    path: &Path,
    allow_new: bool,
) -> Result<(), keys::Error> {
    let _guard = KNOWN_HOSTS_LOCK
        .lock()
        .map_err(|_| std::io::Error::other("SSH 主机密钥校验锁不可用"))?;
    let before = read_known_hosts(path)?;
    // Match the parsed snapshot itself. russh's legacy file reader skips some
    // valid whitespace and host patterns, which could otherwise become TOFU.
    let recorded = recorded_host_keys(&before, host, port)?;
    if read_known_hosts(path)? != before {
        return Err(std::io::Error::other("known_hosts 在校验期间发生变化，请重试").into());
    }
    if recorded.is_empty() {
        if !allow_new {
            return Err(
                std::io::Error::other("SSH 缓存连接的主机密钥已不在 known_hosts 中").into(),
            );
        }
        // Preserve zTerm's existing accept-new / TOFU product behavior.
        keys::known_hosts::learn_known_hosts_path(host, port, key, path)?;
    } else if !recorded
        .iter()
        .any(|(_, known)| known.key_data() == key.key_data())
    {
        // A different algorithm is also a different host identity.
        return Err(keys::Error::KeyChanged {
            line: recorded[0].0,
        });
    }
    Ok(())
}

fn read_known_hosts(path: &Path) -> Result<String, keys::Error> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

fn recorded_host_keys(
    content: &str,
    host: &str,
    port: u16,
) -> Result<Vec<(usize, PublicKey)>, keys::Error> {
    let host_port = if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    };
    let mut recorded = Vec::new();
    for (line_index, source_line) in content.lines().enumerate() {
        let line = source_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Keep the existing interactive policy fail-closed for trust markers,
        // including @revoked, rather than letting a legacy parser skip them.
        if line.starts_with('@') {
            return Err(
                std::io::Error::other("known_hosts 包含当前原生 SSH 不支持的信任标记").into(),
            );
        }
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 3 {
            return Err(std::io::Error::other("known_hosts 包含无法安全校验的条目").into());
        }
        validate_host_patterns(fields[0])?;
        // ssh-key's parser expects literal spaces. Normalize only separators;
        // comments have no bearing on the recorded public key or host patterns.
        let normalized = format!("{} {} {}", fields[0], fields[1], fields[2]);
        let entry = keys::ssh_key::known_hosts::KnownHosts::new(&normalized)
            .next()
            .ok_or_else(|| std::io::Error::other("known_hosts 条目无效"))?
            .map_err(|error| std::io::Error::other(format!("known_hosts 条目无效: {error}")))?;
        if host_matches(entry.host_patterns(), &host_port) {
            recorded.push((line_index + 1, entry.public_key().clone()));
        }
    }
    Ok(recorded)
}

fn validate_host_patterns(patterns: &str) -> Result<(), keys::Error> {
    let invalid = || std::io::Error::other("known_hosts 包含无效或不支持的主机匹配规则");
    if patterns.starts_with('|') {
        let fields: Vec<_> = patterns.split('|').collect();
        if fields.len() != 4 || fields[1] != "1" {
            return Err(invalid().into());
        }
        let decoder = base64::engine::general_purpose::STANDARD;
        let salt = decoder.decode(fields[2]).map_err(|_| invalid())?;
        let hash = decoder.decode(fields[3]).map_err(|_| invalid())?;
        if salt.is_empty() || hash.len() != 20 {
            return Err(invalid().into());
        }
    } else {
        for pattern in patterns.split(',') {
            let pattern = pattern.strip_prefix('!').unwrap_or(pattern);
            if pattern.is_empty() || pattern.starts_with('|') {
                return Err(invalid().into());
            }
        }
    }
    Ok(())
}

fn host_matches(patterns: &HostPatterns, host: &str) -> bool {
    match patterns {
        HostPatterns::HashedName { salt, hash } => {
            // SHA-1 here is the existing OpenSSH hashed-hostname format only.
            let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, salt);
            hmac::verify(&key, host.as_bytes(), hash).is_ok()
        }
        HostPatterns::Patterns(patterns) => {
            let mut matched = false;
            for pattern in patterns {
                if let Some(excluded) = pattern.strip_prefix('!') {
                    if wildcard_matches(excluded, host) {
                        return false;
                    }
                } else if wildcard_matches(pattern, host) {
                    matched = true;
                }
            }
            matched
        }
    }
}

// OpenSSH host patterns use '*' and '?' with case-insensitive literal bytes.
// Remember only the last star, avoiding recursive or exponential backtracking.
fn wildcard_matches(pattern: &str, host: &str) -> bool {
    let pattern = pattern.as_bytes();
    let host = host.as_bytes();
    let (mut pattern_index, mut host_index) = (0, 0);
    let (mut star, mut after_star) = (None, 0);
    while host_index < host.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?'
                || pattern[pattern_index].eq_ignore_ascii_case(&host[host_index]))
        {
            pattern_index += 1;
            host_index += 1;
        } else if pattern.get(pattern_index) == Some(&b'*') {
            star = Some(pattern_index);
            after_star = host_index;
            pattern_index += 1;
        } else if let Some(star_index) = star {
            after_star += 1;
            host_index = after_star;
            pattern_index = star_index + 1;
        } else {
            return false;
        }
    }
    while pattern.get(pattern_index) == Some(&b'*') {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("zterm-host-key-{}", uuid::Uuid::new_v4())))
        }

        fn path(&self) -> PathBuf {
            self.0.join("known_hosts")
        }

        fn write(&self, content: &str) {
            std::fs::create_dir_all(&self.0).unwrap();
            std::fs::write(self.path(), content).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn key(seed: u8) -> PublicKey {
        keys::PrivateKey::new(
            keys::ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]).into(),
            "test-only",
        )
        .unwrap()
        .public_key()
        .clone()
    }

    #[test]
    fn first_use_learns_but_reuse_requires_existing_trust() {
        let fixture = Fixture::new();
        let key = key(71);
        assert!(
            verify_server_key_at_path("example.test", 2222, &key, &fixture.path(), false).is_err()
        );
        verify_server_key_at_path("example.test", 2222, &key, &fixture.path(), true).unwrap();
        verify_server_key_at_path("example.test", 2222, &key, &fixture.path(), false).unwrap();
        assert!(std::fs::read_to_string(fixture.path())
            .unwrap()
            .contains("[example.test]:2222"));
        assert!(
            verify_server_key_at_path("example.test", 22, &key, &fixture.path(), false).is_err()
        );
        std::fs::remove_file(fixture.path()).unwrap();
        assert!(
            verify_server_key_at_path("example.test", 2222, &key, &fixture.path(), false).is_err()
        );
    }

    #[test]
    fn changed_key_is_rejected_without_rewriting_trust() {
        let fixture = Fixture::new();
        verify_server_key_at_path("example.test", 22, &key(72), &fixture.path(), true).unwrap();
        let original = std::fs::read(fixture.path()).unwrap();
        assert!(
            verify_server_key_at_path("example.test", 22, &key(73), &fixture.path(), true).is_err()
        );
        assert_eq!(std::fs::read(fixture.path()).unwrap(), original);
    }

    #[test]
    fn revoked_malformed_and_unreadable_files_fail_closed() {
        let fixture = Fixture::new();
        let key = key(74);
        fixture.write(&format!(
            "@revoked example.test {}\n",
            key.to_openssh().unwrap()
        ));
        assert!(
            verify_server_key_at_path("example.test", 22, &key, &fixture.path(), true).is_err()
        );
        fixture.write("example.test ssh-ed25519 invalid-base64\n");
        assert!(
            verify_server_key_at_path("example.test", 22, &key, &fixture.path(), true).is_err()
        );
        std::fs::remove_file(fixture.path()).unwrap();
        std::fs::create_dir(fixture.path()).unwrap();
        assert!(
            verify_server_key_at_path("example.test", 22, &key, &fixture.path(), true).is_err()
        );
    }

    #[test]
    fn whitespace_and_unrelated_patterns_preserve_existing_connections() {
        let fixture = Fixture::new();
        let key = key(75);
        let public = key.to_openssh().unwrap();
        fixture.write(&format!(
            "  # comment\n\t*.other.test\t{public}\n   example.test\t{}\n",
            public.replace(' ', "\t")
        ));
        let original = std::fs::read(fixture.path()).unwrap();
        verify_server_key_at_path("example.test", 22, &key, &fixture.path(), false).unwrap();
        assert_eq!(std::fs::read(fixture.path()).unwrap(), original);

        fixture.write(&format!("*.other.test {public}\n"));
        verify_server_key_at_path("example.test", 22, &key, &fixture.path(), true).unwrap();
        verify_server_key_at_path("example.test", 22, &key, &fixture.path(), false).unwrap();
    }

    #[test]
    fn matching_patterns_reject_changed_keys_and_respect_exclusions_and_ports() {
        let fixture = Fixture::new();
        let known_key = key(76);
        let public = known_key.to_openssh().unwrap();
        for pattern in ["*.test", "other.invalid,example.????", "[*.test]:2222"] {
            let port = if pattern.starts_with('[') { 2222 } else { 22 };
            fixture.write(&format!("{pattern} {public}\n"));
            let original = std::fs::read(fixture.path()).unwrap();
            verify_server_key_at_path("example.test", port, &known_key, &fixture.path(), false)
                .unwrap();
            assert!(verify_server_key_at_path(
                "example.test",
                port,
                &key(77),
                &fixture.path(),
                true
            )
            .is_err());
            assert_eq!(std::fs::read(fixture.path()).unwrap(), original);
        }
        let content = format!("!example.test,*.test {public}\n");
        assert!(recorded_host_keys(&content, "example.test", 22)
            .unwrap()
            .is_empty());
        assert_eq!(
            recorded_host_keys(&content, "another.test", 22)
                .unwrap()
                .len(),
            1
        );
        let reversed = format!("*.test,!example.test {public}\n");
        assert!(recorded_host_keys(&reversed, "example.test", 22)
            .unwrap()
            .is_empty());
        assert!(
            recorded_host_keys(&format!("[*.test]:2222 {public}\n"), "example.test", 22)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn hashed_host_entries_are_verified_without_relearning() {
        let fixture = Fixture::new();
        let known_key = key(78);
        let salt = [42; 20];
        let hmac_key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, &salt);
        let hash = hmac::sign(&hmac_key, b"[example.test]:2222");
        let encoder = base64::engine::general_purpose::STANDARD;
        fixture.write(&format!(
            "  |1|{}|{}\t{}\n",
            encoder.encode(salt),
            encoder.encode(hash.as_ref()),
            known_key.to_openssh().unwrap()
        ));
        let original = std::fs::read(fixture.path()).unwrap();
        verify_server_key_at_path("example.test", 2222, &known_key, &fixture.path(), false)
            .unwrap();
        assert!(
            verify_server_key_at_path("example.test", 2222, &key(79), &fixture.path(), true)
                .is_err()
        );
        assert!(
            verify_server_key_at_path("example.test", 22, &known_key, &fixture.path(), false)
                .is_err()
        );
        assert_eq!(std::fs::read(fixture.path()).unwrap(), original);
    }

    #[test]
    fn malformed_or_unknown_host_rules_never_become_first_use() {
        let fixture = Fixture::new();
        let key = key(80);
        for pattern in [
            "|2|invalid|invalid",
            "|1|YQ==|Yg==",
            "!|1|YQ==|Yg==",
            "example.test,,other.test",
            "example.test,",
        ] {
            fixture.write(&format!("{pattern} {}\n", key.to_openssh().unwrap()));
            let original = std::fs::read(fixture.path()).unwrap();
            assert!(
                verify_server_key_at_path("example.test", 22, &key, &fixture.path(), true).is_err()
            );
            assert_eq!(std::fs::read(fixture.path()).unwrap(), original);
        }
    }

    #[test]
    fn wildcard_matcher_handles_star_fallback_and_ascii_case() {
        for (pattern, host, expected) in [
            ("EXAMPLE.TEST", "example.test", true),
            ("*.test", "example.test", true),
            ("?.test", "example.test", false),
            ("*.example.*.test", "one.example.two.test", true),
            ("a*a?", "abbaa", true),
            ("a*a?", "aba", false),
            ("*", "", true),
            ("a", "", false),
            ("*test", "test.invalid", false),
        ] {
            assert_eq!(
                wildcard_matches(pattern, host),
                expected,
                "{pattern} / {host}"
            );
        }
    }
}
