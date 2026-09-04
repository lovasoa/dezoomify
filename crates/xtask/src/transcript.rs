//! Canonical transcript serialization: UTF-8, LF, sorted object keys, stable
//! enum tags, decimal integers, no wall-clock fields.
//!
//! Consumed by later-phase transcript verification (job/wasm); the phase-03
//! coverage is the fixed-point unit test below.
#![allow(dead_code)]

pub fn canonicalize(value: &serde_json::Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out.push('\n');
    out
}

fn write_canonical(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::Null => out.push_str("null"),
        serde_json::Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        serde_json::Value::Number(n) => out.push_str(&n.to_string()),
        serde_json::Value::String(s) => {
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        serde_json::Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(&serde_json::Value::String((*k).clone()), out);
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::canonicalize;

    #[test]
    fn transcripts() {
        let a: serde_json::Value =
            serde_json::from_str(r#"{"z":1,"a":{"y":[3,2,1],"b":"x"},"n":null}"#).expect("parse");
        let first = canonicalize(&a);
        let b: serde_json::Value = serde_json::from_str(&first).expect("reparse");
        let second = canonicalize(&b);
        assert_eq!(first, second, "canonical form must be a fixed point");
        assert_eq!(
            first,
            "{\"a\":{\"b\":\"x\",\"y\":[3,2,1]},\"n\":null,\"z\":1}\n"
        );
        assert!(first.ends_with('\n') && !first.contains('\r'));
    }
}
