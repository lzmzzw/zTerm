// Author: Liz

pub(crate) fn find_bytes(bytes: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        Some(0)
    } else {
        bytes
            .windows(needle.len())
            .position(|window| window == needle)
    }
}

/// 文本快照的流式解码状态。原始终端字节不经过此缓冲，避免二进制协议等待补齐字符。
#[derive(Default)]
pub(crate) struct TerminalUtf8Decoder {
    pending: Vec<u8>,
}

impl TerminalUtf8Decoder {
    pub(crate) fn decode(&mut self, bytes: &[u8]) -> String {
        if self.pending.is_empty() {
            return self.decode_complete_prefix(bytes);
        }

        let mut joined = std::mem::take(&mut self.pending);
        joined.extend_from_slice(bytes);
        self.decode_complete_prefix(&joined)
    }

    fn decode_complete_prefix(&mut self, mut bytes: &[u8]) -> String {
        let mut text = String::with_capacity(bytes.len());
        while !bytes.is_empty() {
            match std::str::from_utf8(bytes) {
                Ok(valid) => {
                    text.push_str(valid);
                    break;
                }
                Err(error) => {
                    let (valid, rest) = bytes.split_at(error.valid_up_to());
                    text.push_str(std::str::from_utf8(valid).expect("validated UTF-8 prefix"));
                    match error.error_len() {
                        Some(invalid_len) => {
                            text.push(char::REPLACEMENT_CHARACTER);
                            bytes = &rest[invalid_len..];
                        }
                        None => {
                            // from_utf8 已确认这是可能合法的末尾前缀，最多保留三个字节。
                            self.pending.extend_from_slice(rest);
                            break;
                        }
                    }
                }
            }
        }
        text
    }

    /// EOF 或读取失败时仅将未闭合的文本前缀记作一个替换字符，重复调用为空。
    pub(crate) fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        self.pending.clear();
        char::REPLACEMENT_CHARACTER.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalUtf8Decoder;

    fn decoded(chunks: &[&[u8]]) -> String {
        let mut decoder = TerminalUtf8Decoder::default();
        let mut text = String::new();
        for chunk in chunks {
            text.push_str(&decoder.decode(chunk));
            assert!(decoder.pending.len() <= 3);
        }
        text.push_str(&decoder.finish());
        assert!(decoder.finish().is_empty());
        text
    }

    #[test]
    fn every_split_preserves_multibyte_terminal_text() {
        let input = "提示> 中文🚀\r\n\x1b[32m完成\x1b[0m";
        for split in 0..=input.len() {
            assert_eq!(
                decoded(&[&input.as_bytes()[..split], &input.as_bytes()[split..]]),
                input,
                "split at {split}"
            );
        }
        let chunks = input.as_bytes().chunks(1).collect::<Vec<_>>();
        assert_eq!(decoded(&chunks), input);
    }

    #[test]
    fn invalid_and_incomplete_sequences_match_whole_stream_lossy_decoding() {
        let cases: &[&[u8]] = &[
            b"ok\xff\xfeend",
            b"\xe4\xb8",
            b"\xe4A\xad",
            b"\xf0\x9f\x9a",
            b"\xf0\x80\x80\x80",
            b"\xed\xa0\x80",
            b"\xc0\xaf",
            b"\xe2\x82\xac\xff\xe4\xb8\xad\xf0\x9f",
        ];
        for bytes in cases {
            for split in 0..=bytes.len() {
                assert_eq!(
                    decoded(&[&bytes[..split], &bytes[split..]]),
                    String::from_utf8_lossy(bytes),
                    "bytes {bytes:?}, split at {split}"
                );
            }
        }
    }

    #[test]
    fn empty_reads_do_not_finish_a_pending_character() {
        let mut decoder = TerminalUtf8Decoder::default();
        assert_eq!(decoder.decode(&[0xe4]), "");
        assert_eq!(decoder.decode(&[]), "");
        assert_eq!(decoder.decode(&[0xb8, 0xad]), "中");
        assert_eq!(decoder.finish(), "");
    }
}
