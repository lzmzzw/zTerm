// Author: Liz
use crate::error::{AppError, AppResult};

pub(crate) fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use crate::error::AppError;

    use super::required_text;

    #[test]
    fn required_text_trims_non_empty_values() {
        assert_eq!(required_text("名称", "  zTerm  ").unwrap(), "zTerm");
    }

    #[test]
    fn required_text_preserves_the_existing_validation_error() {
        assert_eq!(
            required_text("名称", " \t ").unwrap_err(),
            AppError::validation("名称不能为空")
        );
    }
}
