// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::now_ms;

    #[test]
    fn current_time_is_a_non_negative_unix_millisecond_value() {
        assert!(now_ms() > 0);
    }
}
