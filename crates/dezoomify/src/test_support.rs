//! Deterministic resource acquisition for format tests.
use crate::core::discovery::{DiscoveryInput, DiscoveryLimits};
use crate::core::{DiscoveryCatalog, DiscoveryError, FormatSpec, Registry, Request};
use crate::model::{Error, ErrorPhase, ResourceRead, ResourceResponse};
use std::cell::RefCell;

pub fn discover(
    spec: FormatSpec,
    uri: &str,
    replies: &[(&[u8], Option<&str>)],
) -> (Result<DiscoveryCatalog, DiscoveryError>, Vec<Request>) {
    let mut registry = Registry::new();
    registry.register(spec);
    let requests = RefCell::new(Vec::new());
    let result = futures::executor::block_on(registry.discover(
        vec![DiscoveryInput::new(uri)],
        DiscoveryLimits::default(),
        |request, _| {
            let index = requests.borrow().len();
            requests.borrow_mut().push(request);
            let response = replies
                .get(index)
                .map(|(bytes, final_uri)| ResourceRead::Response {
                    response: ResourceResponse {
                        bytes: bytes.to_vec(),
                        final_uri: final_uri.map(str::to_owned),
                    },
                });
            async move {
                response.ok_or_else(|| {
                    Error::new("DISCOVERY_FAILED", ErrorPhase::Discovery, "missing fixture")
                })
            }
        },
    ));
    (result, requests.into_inner())
}
