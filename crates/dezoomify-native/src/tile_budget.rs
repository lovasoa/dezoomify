//! Shared retained-output and conversion memory guard.
use dezoomify::model::{Error, LimitContext, LimitReason};

/// Temporarily withhold concurrent input buffers. The writer separately owns
/// `retained` bytes; release the same reservation when its operation returns.
pub(crate) fn reserve_queued(budget: &mut u64, retained: u64, bytes: u64) -> Result<(), Error> {
    memory_check(retained.saturating_add(bytes), *budget)?;
    *budget -= bytes;
    Ok(())
}

/// Restore a successful queued-input or preflight-probe reservation.
pub(crate) fn release_reserved(budget: &mut u64, bytes: u64) {
    *budget = budget.saturating_add(bytes);
}

pub(crate) fn memory_check(required: u64, budget: u64) -> Result<(), Error> {
    if required > budget {
        Err(Error::LimitExceeded {
            limit: LimitContext {
                reason: LimitReason::Memory,
                dimensions: None,
                bytes_required: Some(required),
                bytes_available: Some(budget),
            },
        })
    } else {
        Ok(())
    }
}
