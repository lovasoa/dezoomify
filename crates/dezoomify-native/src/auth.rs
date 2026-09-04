//! Scoped in-memory authorization for phase-12 handoffs. Memory-only,
//! never serialized, Debug redacts values, best-effort overwrite on drop
//! (no universal-zeroization claim).

use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct AuthorizationScope {
    pub scheme: String,
    pub host: String,
    pub port: Option<u16>,
    pub path_prefix: String,
    pub job_id: Option<String>,
}

impl AuthorizationScope {
    #[must_use]
    pub fn matches(&self, scheme: &str, host: &str, port: Option<u16>, path: &str) -> bool {
        if !self.scheme.eq_ignore_ascii_case(scheme) {
            return false;
        }
        if !self.host.eq_ignore_ascii_case(host) {
            return false;
        }
        if self.port != port {
            return false;
        }
        if !path.starts_with(self.path_prefix.as_str()) {
            return false;
        }
        true
    }
}

pub struct EphemeralAuthorization {
    scope: AuthorizationScope,
    cookies: HashMap<String, String>,
}

impl EphemeralAuthorization {
    pub fn new(
        scope: AuthorizationScope,
        cookies: HashMap<String, String>,
    ) -> Result<Self, String> {
        if cookies.len() > 64 {
            return Err("too many cookies".to_string());
        }
        for (k, v) in &cookies {
            if k.len() > 256 || v.len() > 4096 {
                return Err("cookie entry too large".to_string());
            }
            if k.contains(['\r', '\n']) || v.contains(['\r', '\n']) {
                return Err("cookie CR/LF rejected".to_string());
            }
        }
        if scope.host.contains("..") || scope.path_prefix.contains("..") {
            return Err("scope traversal rejected".to_string());
        }
        Ok(Self { scope, cookies })
    }

    #[must_use]
    pub fn header_for(
        &self,
        scheme: &str,
        host: &str,
        port: Option<u16>,
        path: &str,
    ) -> Option<String> {
        if !self.scope.matches(scheme, host, port, path) {
            return None;
        }
        let mut pairs: Vec<(&String, &String)> = self.cookies.iter().collect();
        pairs.sort_by(|a, b| a.0.cmp(b.0));
        Some(
            pairs
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }

    #[must_use]
    pub fn scope(&self) -> &AuthorizationScope {
        &self.scope
    }
}

impl Drop for EphemeralAuthorization {
    fn drop(&mut self) {
        // Best-effort overwrite of owned buffers only.
        for value in self.cookies.values_mut() {
            let len = value.len();
            *value = "x".repeat(len);
        }
        self.cookies.clear();
    }
}

impl std::fmt::Debug for EphemeralAuthorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EphemeralAuthorization")
            .field("scope", &self.scope)
            .field("cookies", &format!("<{} redacted>", self.cookies.len()))
            .finish()
    }
}
