use tauri::Context;

const WEBVIEW2_HIDE_CURSOR_REGRESSION_FIRST_MAJOR: u32 = 152;
const WRY_DEFAULT_DISABLED_FEATURES: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
const WRY_DEFAULT_AUTOPLAY_POLICY: &str = "--autoplay-policy=no-user-gesture-required";
const HIDE_CURSOR_WHILE_TYPING_DISABLED_FEATURE: &str = "HideCursorWhileTyping";

pub fn apply_webview2_compatibility(context: &mut Context<tauri::Wry>) {
    let Ok(runtime_version) = tauri::webview_version() else {
        return;
    };
    let Some(main_window) = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
    else {
        return;
    };
    let Some(args) = browser_args_for_webview2_version(
        &runtime_version,
        main_window.additional_browser_args.as_deref(),
    ) else {
        return;
    };

    main_window.additional_browser_args = Some(args);
}

fn browser_args_for_webview2_version(
    runtime_version: &str,
    existing_args: Option<&str>,
) -> Option<String> {
    // Keep the workaround across Evergreen updates until a fixed runtime is verified.
    webview2_major_version(runtime_version)
        .is_some_and(|major| major >= WEBVIEW2_HIDE_CURSOR_REGRESSION_FIRST_MAJOR)
        .then(|| {
            let mut args = existing_args.map(str::to_owned).unwrap_or_else(|| {
                format!("{WRY_DEFAULT_DISABLED_FEATURES} {WRY_DEFAULT_AUTOPLAY_POLICY}")
            });
            append_disabled_feature(&mut args, HIDE_CURSOR_WHILE_TYPING_DISABLED_FEATURE);
            args
        })
}

fn webview2_major_version(version: &str) -> Option<u32> {
    version.split('.').next()?.parse().ok()
}

fn append_disabled_feature(args: &mut String, feature: &str) {
    const DISABLED_FEATURES_PREFIX: &str = "--disable-features=";

    if let Some(argument_start) = args.find(DISABLED_FEATURES_PREFIX) {
        let feature_start = argument_start + DISABLED_FEATURES_PREFIX.len();
        let feature_end = args[feature_start..]
            .find(char::is_whitespace)
            .map_or(args.len(), |index| feature_start + index);

        if args[feature_start..feature_end]
            .split(',')
            .any(|item| item == feature)
        {
            return;
        }

        args.insert_str(feature_end, &format!(",{feature}"));
        return;
    }

    if !args.is_empty() {
        args.push(' ');
    }
    args.push_str(DISABLED_FEATURES_PREFIX);
    args.push_str(feature);
}

#[cfg(test)]
mod tests {
    use super::{browser_args_for_webview2_version, webview2_major_version};

    #[test]
    fn keeps_the_workaround_after_webview2_updates() {
        assert_eq!(webview2_major_version("151.0.4129.93"), Some(151));
        assert_eq!(webview2_major_version("152.0.4191.66"), Some(152));
        assert_eq!(webview2_major_version("153.0.4270.0"), Some(153));
        assert_eq!(webview2_major_version("invalid"), None);

        assert!(browser_args_for_webview2_version("151.0.4129.93", None).is_none());
        assert!(browser_args_for_webview2_version("invalid", None).is_none());
        for version in [
            "152.0.4191.66",
            "153.0.4270.0",
            "154.0.4258.62",
            "155.0.0.0",
        ] {
            let args = browser_args_for_webview2_version(version, None)
                .unwrap_or_else(|| panic!("pointer workaround missing for WebView2 {version}"));
            assert!(args.contains("HideCursorWhileTyping"));
        }
    }

    #[test]
    fn preserves_wry_default_arguments_when_config_has_none() {
        assert_eq!(
            browser_args_for_webview2_version("152.0.4191.66", None),
            Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,HideCursorWhileTyping --autoplay-policy=no-user-gesture-required".to_string())
        );
    }

    #[test]
    fn keeps_existing_browser_arguments_and_merges_the_disabled_feature() {
        assert_eq!(
            browser_args_for_webview2_version(
                "154.0.4258.62",
                Some("--disable-features=ExistingFeature --proxy-server=http://proxy:8080"),
            ),
            Some(
                "--disable-features=ExistingFeature,HideCursorWhileTyping --proxy-server=http://proxy:8080"
                    .to_string()
            )
        );
    }

    #[test]
    fn does_not_duplicate_an_existing_disabled_feature() {
        assert_eq!(
            browser_args_for_webview2_version(
                "154.0.4258.62",
                Some("--disable-features=ExistingFeature,HideCursorWhileTyping"),
            ),
            Some("--disable-features=ExistingFeature,HideCursorWhileTyping".to_string())
        );
    }
}
