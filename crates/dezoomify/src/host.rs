//! Platform capabilities used by the shared asynchronous algorithm.
use crate::model::*;

/// The single authored capability list; bindings expand the same declaration.
#[macro_export]
macro_rules! host_members {
    ($consumer:ident) => {
        $consumer! {
            async {
                fetch => fetch(request: ResourceRequest, interaction: Interaction) -> ResourceRead;
                probe => probe(tile: Tile) -> ProbeOutcome;
                acquire_tile => acquireTile(tile: Tile) -> TileReceipt;
                finish => finish(request: FinishRequest) -> Output;
                choose_image => chooseImage(catalog: Catalog) -> u32;
                choose_level => chooseLevel(image: Image) -> u32;
                choose_partial => choosePartial(missing: MissingTiles) -> RecoveryChoice;
                checkpoint => checkpoint(gate: Gate) -> ();
                sleep => sleep(delay_ms: u32) -> ();
            }
            report(progress: Progress);
            settle();
        }
    };
}

macro_rules! declare_host {
    (async { $( $method:ident => $js:ident( $( $arg:ident: $ty:ty ),* ) -> $out:ty; )* }
     report($progress:ident: $progress_ty:ty); settle();) => {
        #[allow(async_fn_in_trait)]
        pub trait Host {
            $( async fn $method(&self, $( $arg: $ty ),*) -> Result<$out, Error>; )*
            fn report(&self, $progress: $progress_ty);
            async fn settle(&self);
        }
    }
}
host_members!(declare_host);
