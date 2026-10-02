//! Behavior of the secret/credential query-key vocabulary: secret-bearing
//! source URLs are refused before use.

use dezoomify::model::{has_secret_params, is_secret_key};

#[test]
fn secret_bearing_urls_are_refused() {
    assert!(has_secret_params("https://example.com/item?token=secret"));
    assert!(has_secret_params("https://example.com/item?APIKEY=secret"));
    assert!(has_secret_params("https://example.com/item?token"));
    assert!(has_secret_params("https://example.com/item?%74oken=secret"));
    assert!(has_secret_params("https://example.com/item#token=secret"));
    assert!(has_secret_params("not a url"));
}

#[test]
fn ordinary_urls_pass_and_paths_never_match() {
    assert!(!has_secret_params(
        "https://example.com/cookie-recipe/view?page=1"
    ));
    assert!(!has_secret_params("https://example.com/view?page=1&src=a"));
    assert!(is_secret_key("ToKeN"));
    assert!(!is_secret_key("tokens"));
}
