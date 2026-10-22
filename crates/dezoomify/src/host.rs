//! Platform capabilities used by the shared asynchronous algorithm.
use crate::model::*;

/// The single authored capability list; bindings expand the same declaration.
#[macro_export]
macro_rules! host_members {
    ($consumer:ident) => {
        $consumer! {
            async {
                observe => observe(interaction: Interaction) -> JobInputs;
                fetch => fetch(request: ResourceRequest, interaction: Interaction) -> ResourceRead;
                parse_html => parseHtml(query: HtmlQuery) -> HtmlDocument;
                probe => probe(tile: Tile) -> ProbeOutcome;
                begin_output => beginOutput(plan: OutputPlan) -> ();
                acquire_tile => acquireTile(request: TileAcquisition) -> ();
                finish => finish(request: FinishRequest) -> Output;
                choose_image => chooseImage(catalog: Catalog) -> u32;
                choose_level => chooseLevel(image: Image) -> u32;
                /// Check cancellation; acquisition gates also wait for permission to proceed.
                /// Return timing sampled after the gate opens, on the shared `HostTiming` scale.
                checkpoint => checkpoint(gate: Gate) -> HostTiming;
                /// Wait at least `delay_ms` milliseconds, aborting on cancellation, then
                /// return completion timing on the same scale as `checkpoint`.
                sleep => sleep(delay_ms: u32) -> HostTiming;
            }
            sync {
                report(progress: Progress);
                warn(message: String);
            }
            settle();
        }
    };
}

macro_rules! declare_host {
    (async { $( $(#[$doc:meta])* $method:ident => $js:ident( $( $arg:ident: $ty:ty ),* ) -> $out:ty; )* }
     sync { $( $notify:ident($value:ident: $value_ty:ty); )* } settle();) => {
        #[allow(async_fn_in_trait)]
        pub trait Host {
            $( $(#[$doc])* async fn $method(&self, $( $arg: $ty ),*) -> Result<$out, Error>; )*
            $( fn $notify(&self, $value: $value_ty); )*
            async fn settle(&self);
        }
    }
}
host_members!(declare_host);
