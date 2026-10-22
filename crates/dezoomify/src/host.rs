//! Platform capabilities for one [`crate::dezoomify`] invocation. The declaration
//! below owns both the Rust trait and the generated TypeScript `Host` contract.
#![deny(missing_docs)]

use crate::model::*;

/// The single authored capability list; bindings expand the same declaration.
#[macro_export]
macro_rules! host_members {
    ($consumer:ident) => {
        $consumer! {
            /// Platform resources and interactions for one `dezoomify` invocation.
            ///
            /// Discovery and selection precede geometry probes, then output preflight,
            /// ordinary tile acquisitions, and finalization. Probes may already retain
            /// output. Acquisitions and metadata reads can overlap; completion order
            /// is unspecified. The core owns retries, pacing, and backoff; hosts perform
            /// individual attempts and own I/O, decoding, and output resources.
            ///
            /// On success or error, the core awaits `settle` after its other calls
            /// have returned or their futures have been dropped. Hosts must track
            /// work that outlives those futures. Signal cancellation through the host
            /// and await the job; dropping a Rust job future skips this cleanup.
            /// Keep the host and its dependencies alive until settlement completes;
            /// use a fresh host for each job. Fallible methods return typed `Error`
            /// values (TypeScript promises reject with the same serialized shapes).
            async {
                /// Supply more discovery evidence under the interaction policy.
                /// Return new or improved evidence; an empty batch exhausts the current
                /// policy. The core may ask again, including with interaction allowed.
                observe => observe(interaction: Interaction) -> JobInputs;
                /// Read one resource, preserving its redirected base URI. Honor the
                /// interaction policy and `ResourceRequest` range/credential rules.
                /// Return the `needs-access` outcome when permission is unavailable.
                fetch => fetch(request: ResourceRequest, interaction: Interaction) -> ResourceRead;
                /// Query supplied HTML without executing scripts or loading resources.
                /// Return selector-keyed matches in document order, excluding
                /// template/noscript subtrees. Leave URLs for the core to resolve.
                parse_html => parseHtml(query: HtmlQuery) -> HtmlDocument;
                /// Measure one geometry probe before output preflight. `missing` is a
                /// search observation, not a failed output tile. Propagate cancellation
                /// and output errors. On availability, retain the tile at its placement
                /// for reuse if its role includes output.
                probe => probe(tile: Tile) -> ProbeOutcome;
                /// Announce the resolved plan once, before ordinary acquisitions.
                /// Preserve probe output. Hosts may preflight destinations and resource
                /// requirements here; acceptance does not guarantee later allocation
                /// or publication will succeed.
                begin_output => beginOutput(plan: OutputPlan) -> ();
                /// Perform one tile attempt, awaiting any required approval before I/O.
                /// Success means the tile has joined output; retain resources as needed
                /// until finish/settlement. Calls for different tiles can overlap;
                /// retries of the same tile are sequential and must not duplicate output.
                acquire_tile => acquireTile(request: TileAcquisition) -> ();
                /// Finalize after all required tiles succeeded, including reused probes.
                /// Called at most once; report the actual save disposition, which need
                /// not mean a browser download has finished. Failure still leads to settle.
                finish => finish(request: FinishRequest) -> Output;
                /// Return a zero-based index into `catalog.entries`, even for a single
                /// entry. Selecting a deferred entry can lead to another catalog choice.
                /// The core rejects out-of-range indices with `invalid-state`.
                choose_image => chooseImage(catalog: Catalog) -> u32;
                /// Return a zero-based index into `image.levels` in its supplied order,
                /// not a source format's zoom identifier. The core checks the range.
                choose_level => chooseLevel(image: Image) -> u32;
                /// Check cancellation at either gate; the acquisition gate also waits
                /// for pause/retry approval to clear. Pausing does not cancel work that
                /// is already running. Return `cancelled` when cancellation is signalled.
                /// Sample `HostTiming` after the gate opens, on the invocation's shared scale.
                checkpoint => checkpoint(gate: Gate) -> HostTiming;
                /// Wait at least `delay_ms` milliseconds for core-owned pacing or backoff,
                /// or return `cancelled`. Return completion timing on the `HostTiming` scale.
                /// Calls may overlap; leave scheduling and retries to the core.
                sleep => sleep(delay_ms: u32) -> HostTiming;
            }
            sync {
                /// Deliver a progress snapshot synchronously. Totals may be unknown
                /// during discovery/planning; completion is the job result, not a count.
                report(progress: Progress);
                /// Deliver a nonfatal discovery warning synchronously. Diagnostic
                /// prose is for presentation, never a machine-readable failure kind.
                warn(message: String);
            }
            /// Stop and drain remaining host work and release invocation resources,
            /// including on validation failure before any other capability was called.
            /// Preserve independently owned saved output. Cleanup must not fail or
            /// replace the job result; after it completes, no job work may use resources.
            settle();
        }
    };
}

macro_rules! declare_host {
    ($(#[doc = $host_doc:literal])* async {
        $( $(#[doc = $method_doc:literal])* $method:ident => $js:ident( $( $arg:ident: $ty:ty ),* ) -> $out:ty; )*
     }
     sync { $( $(#[doc = $notify_doc:literal])* $notify:ident($value:ident: $value_ty:ty); )* }
     $(#[doc = $settle_doc:literal])* settle();) => {
        $(#[doc = $host_doc])*
        #[allow(async_fn_in_trait)]
        pub trait Host {
            $( $(#[doc = $method_doc])* async fn $method(&self, $( $arg: $ty ),*) -> Result<$out, Error>; )*
            $( $(#[doc = $notify_doc])* fn $notify(&self, $value: $value_ty); )*
            $(#[doc = $settle_doc])*
            async fn settle(&self);
        }
    }
}
host_members!(declare_host);
