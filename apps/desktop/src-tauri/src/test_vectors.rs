//! One walker for the shared cross-language vector corpora in
//! `testdata/`. Both desktop test mods (`deep_link` and `settings`) assert
//! their oracle through this module; the TypeScript mirrors
//! (`apps/desktop/tests/policy-vectors.test.mjs`) read the same documents.

/// Load one vector list from the corpus. `file` names the JSON document in
/// `testdata/` and `key` the list within it (`cases`, `headerLines`,
/// `settings`, ...). The documents are compiled into the test binary (no
/// test-time I/O) and every list is non-empty.
pub(crate) fn cases(file: &str, key: &str) -> Vec<serde_json::Value> {
    let text = match file {
        "deep-link-vectors.json" => include_str!("../../../../testdata/deep-link-vectors.json"),
        "policy-vectors.json" => include_str!("../../../../testdata/policy-vectors.json"),
        other => panic!("unknown vector file: {other}"),
    };
    let doc: serde_json::Value = serde_json::from_str(text).expect("vector file parses");
    let cases = doc[key].as_array().expect("vector list").clone();
    assert!(!cases.is_empty(), "{file}:{key} is non-empty");
    cases
}

/// Assert one vector case's accept/reject verdict. Rejections pin the
/// observed class or reason string (`reject` itself, or `reject.rust`
/// where the two languages pin their own wording); accepts run
/// `assert_accept` with the parsed value and the case's `accept` spec.
/// Prose fields (`comment`, `underlying`, ...) never participate.
pub(crate) fn assert_case<T>(
    case: &serde_json::Value,
    result: Result<T, String>,
    assert_accept: impl FnOnce(&serde_json::Value, T),
) {
    let name = case["name"].as_str().expect("case name");
    match &case["reject"] {
        serde_json::Value::Null => {
            let parsed = match result {
                Ok(parsed) => parsed,
                Err(error) => panic!("{name} must accept: {error}"),
            };
            assert_accept(&case["accept"], parsed);
        }
        reject => {
            let expected = reject
                .as_str()
                .map(str::to_owned)
                .or_else(|| reject["rust"].as_str().map(str::to_owned))
                .expect("reject pins a class string or a {rust} reason");
            match result {
                Err(error) => assert_eq!(error, expected, "{name}: wrong rejection"),
                Ok(_) => panic!("{name} must reject"),
            }
        }
    }
}
