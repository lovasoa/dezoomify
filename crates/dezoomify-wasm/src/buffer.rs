//! Bounded generation-safe byte arena for host-supplied bytes.
//!
//! The host transfers bytes out-of-band (never base64): [`ByteArena::allocate`]
//! reserves zeroed memory and returns an [`ArenaHandle`] (`{id, generation}`),
//! the host fills it with [`ByteArena::write_bytes`], seals it immutable with
//! [`ByteArena::commit`], and the adapter moves it exactly once with
//! [`ByteArena::take_buffer`]. [`ByteArena::free`] releases ownership and is
//! idempotent; reusing a freed slot bumps its generation so stale handles
//! fail with [`AdapterErrorCode::StaleBuffer`][crate::error::AdapterErrorCode]
//! instead of aliasing live memory.
//!
//! Slot lifecycle per generation: `Uncommitted -> Committed -> Consumed`,
//! with `Freed` reachable idempotently from any state. Committed bytes are
//! immutable through this API. All lengths and the retained total use checked
//! arithmetic; any overflow or quota breach is
//! [`AdapterErrorCode::LimitExceeded`][crate::error::AdapterErrorCode], never
//! a panic. `usize` conversions are fallible so 32-bit WASM targets cannot
//! truncate large `u64` lengths.
//!
//! Protocol correlation: [`ByteArena::to_protocol_handle`] projects a live
//! handle onto the canonical [`BufferHandle`][dto] (`buf:{id}` + generation +
//! length); [`ByteArena::resolve_protocol`] parses one back, rejecting wrong
//! ID kinds as malformed and unknown/stale generations as stale.
//!
//! [dto]: dezoomify_protocol::dto::BufferHandle

use crate::error::{AdapterError, AdapterErrorCode};
use dezoomify_protocol::dto::{BufferHandle as ProtocolBufferHandle, BufferId};
use serde::{Deserialize, Serialize};

/// Default per-buffer cap: the browser baseline `max_tile_bytes` (8 MiB).
pub const MAX_BUFFER_BYTES: u64 = 8 << 20;
/// Default retained-bytes cap per session (8 buffers at the per-buffer cap).
pub const MAX_TOTAL_BYTES: u64 = 64 << 20;
/// Default live-buffer cap per session.
pub const MAX_BUFFERS: usize = 256;

/// Opaque handle to one arena generation. Serialize-safe for JS transfer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ArenaHandle {
    /// Slot index. Never reused for a different live allocation without a
    /// generation bump.
    pub id: u32,
    /// Allocation generation of this slot. Mismatches are stale, never
    /// use-after-free.
    pub generation: u32,
}

impl ArenaHandle {
    /// Canonical `buf:{id}` protocol identifier for this handle.
    #[must_use]
    pub fn buffer_id(self) -> Option<BufferId> {
        BufferId::new(format!("buf:{}", self.id))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SlotState {
    Uncommitted,
    Committed,
    Consumed,
    Freed,
}

#[derive(Debug)]
struct Slot {
    generation: u32,
    state: SlotState,
    data: Vec<u8>,
}
/// Bounded arena. Single-threaded by construction (owned by one `Session`);
/// the host must not call back into it while another call borrows it —
/// see the reentrancy rule in `lib.rs` (polling/draining only, no callbacks).
#[derive(Debug)]
pub struct ByteArena {
    slots: Vec<Slot>,
    /// Indices with state `Consumed` or `Freed`, available for reuse.
    free_list: Vec<usize>,
    /// Live allocations (`Uncommitted` + `Committed`).
    live: usize,
    /// Sum of live allocation lengths.
    total_retained: u64,
    max_buffer_bytes: u64,
    max_total_bytes: u64,
    max_buffers: usize,
}

impl ByteArena {
    /// Create an arena with explicit quotas (validated by `Session` first).
    #[must_use]
    pub fn with_limits(max_buffer_bytes: u64, max_total_bytes: u64, max_buffers: usize) -> Self {
        Self {
            slots: Vec::new(),
            free_list: Vec::new(),
            live: 0,
            total_retained: 0,
            max_buffer_bytes,
            max_total_bytes,
            max_buffers,
        }
    }

    /// Create an arena with default quotas.
    #[must_use]
    pub fn new() -> Self {
        Self::with_limits(MAX_BUFFER_BYTES, MAX_TOTAL_BYTES, MAX_BUFFERS)
    }

    /// Currently retained live bytes.
    #[must_use]
    pub fn total_retained(&self) -> u64 {
        self.total_retained
    }

    /// Reserve `length` zeroed bytes and return a writable handle.
    ///
    /// # Errors
    ///
    /// `limit-exceeded` on oversized `length`, quota breach, or overflow.
    pub fn allocate(&mut self, length: u64) -> Result<ArenaHandle, AdapterError> {
        if length > self.max_buffer_bytes {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!(
                    "allocation of {length} bytes exceeds per-buffer cap {}",
                    self.max_buffer_bytes
                ),
            ));
        }
        let retained = self.total_retained.checked_add(length).ok_or_else(|| {
            AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "allocation overflows retained-bytes accounting",
            )
        })?;
        if retained > self.max_total_bytes {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!(
                    "allocation of {length} bytes exceeds session total cap {}",
                    self.max_total_bytes
                ),
            ));
        }
        if self.live >= self.max_buffers {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!("session buffer count cap {} reached", self.max_buffers),
            ));
        }
        let length_usize = usize::try_from(length).map_err(|_| {
            AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "allocation length does not fit this target",
            )
        })?;
        if let Some(index) = self.free_list.pop() {
            let slot = self.slots.get_mut(index).ok_or_else(|| {
                AdapterError::new(
                    AdapterErrorCode::StaleBuffer,
                    "free-list entry points at no slot",
                )
            })?;
            debug_assert!(matches!(slot.state, SlotState::Consumed | SlotState::Freed));
            slot.generation = slot
                .generation
                .checked_add(1)
                .and_then(|next| {
                    // Generation zero is reserved as "never allocated"; skip it.
                    if next == 0 {
                        next.checked_add(1)
                    } else {
                        Some(next)
                    }
                })
                .ok_or_else(|| {
                    AdapterError::new(AdapterErrorCode::LimitExceeded, "slot generation exhausted")
                })?;
            slot.state = SlotState::Uncommitted;
            slot.data = vec![0u8; length_usize];
            self.live += 1;
            self.total_retained = retained;
            let id = u32::try_from(index).map_err(|_| {
                AdapterError::new(
                    AdapterErrorCode::LimitExceeded,
                    "slot index does not fit a handle",
                )
            })?;
            Ok(ArenaHandle {
                id,
                generation: slot.generation,
            })
        } else {
            let index = self.slots.len();
            let id = u32::try_from(index).map_err(|_| {
                AdapterError::new(
                    AdapterErrorCode::LimitExceeded,
                    "slot index does not fit a handle",
                )
            })?;
            self.slots.push(Slot {
                generation: 1,
                state: SlotState::Uncommitted,
                data: vec![0u8; length_usize],
            });
            self.live += 1;
            self.total_retained = retained;
            Ok(ArenaHandle { id, generation: 1 })
        }
    }

    /// Copy host bytes into an uncommitted allocation at `offset`.
    ///
    /// # Errors
    ///
    /// `stale-buffer` for unknown/forged/freed/consumed handles or generation
    /// mismatch; `wrong-state` for sealed handles; `limit-exceeded` when the
    /// write would run past the allocation (checked, never panicking).
    pub fn write_bytes(
        &mut self,
        handle: ArenaHandle,
        offset: u64,
        data: &[u8],
    ) -> Result<(), AdapterError> {
        let index = self.index_of(handle)?;
        let slot = self.slots.get_mut(index).ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::StaleBuffer, "unknown buffer handle")
        })?;
        if slot.generation != handle.generation {
            return Err(AdapterError::new(
                AdapterErrorCode::StaleBuffer,
                "stale buffer generation",
            ));
        }
        match slot.state {
            SlotState::Freed | SlotState::Consumed => {
                return Err(AdapterError::new(
                    AdapterErrorCode::StaleBuffer,
                    "buffer ownership already released",
                ));
            }
            SlotState::Committed => {
                return Err(AdapterError::new(
                    AdapterErrorCode::WrongState,
                    "committed buffer is immutable",
                ));
            }
            SlotState::Uncommitted => {}
        }
        let data_len = u64::try_from(data.len()).map_err(|_| {
            AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "write length does not fit accounting",
            )
        })?;
        let end = offset.checked_add(data_len).ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::LimitExceeded, "write offset overflows")
        })?;
        let capacity = slot.data.len() as u64;
        if end > capacity {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!(
                    "write of {} bytes at offset {offset} exceeds allocation of {capacity} bytes",
                    data.len()
                ),
            ));
        }
        let start = offset as usize;
        let stop = end as usize;
        slot.data
            .get_mut(start..stop)
            .ok_or_else(|| {
                AdapterError::new(
                    AdapterErrorCode::LimitExceeded,
                    "write range invalid after bounds check",
                )
            })?
            .copy_from_slice(data);
        Ok(())
    }

    /// Seal an allocation at `actual` bytes (`actual <= allocated`), making it
    /// immutable and eligible for consumption or processing input.
    ///
    /// # Errors
    ///
    /// `stale-buffer` for unknown/stale/released handles; `wrong-state` when
    /// already sealed; `limit-exceeded` when `actual` exceeds the allocation.
    pub fn commit(&mut self, handle: ArenaHandle, actual: u64) -> Result<(), AdapterError> {
        let index = self.index_of(handle)?;
        // Read-only checks first so failures leave the slot untouched.
        let capacity = {
            let slot = self.slot_checked(index, handle)?;
            match slot.state {
                SlotState::Freed | SlotState::Consumed => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::StaleBuffer,
                        "buffer ownership already released",
                    ));
                }
                SlotState::Committed => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "buffer already committed",
                    ));
                }
                SlotState::Uncommitted => {}
            }
            slot.data.len() as u64
        };
        if actual > capacity {
            return Err(AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                format!("commit of {actual} bytes exceeds allocation of {capacity} bytes"),
            ));
        }
        let actual_usize = usize::try_from(actual).map_err(|_| {
            AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "commit length does not fit this target",
            )
        })?;
        let slot = self.slots.get_mut(index).ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::StaleBuffer, "unknown buffer handle")
        })?;
        let dropped = (slot.data.len() as u64).saturating_sub(actual);
        slot.data.truncate(actual_usize);
        slot.state = SlotState::Committed;
        self.total_retained = self.total_retained.saturating_sub(dropped);
        Ok(())
    }

    /// Move committed bytes out exactly once. The slot becomes `Consumed`;
    /// any later use of the handle is `stale-buffer`.
    ///
    /// # Errors
    ///
    /// `stale-buffer` for unknown/stale/released or double consumption;
    /// `wrong-state` for unsealed allocations.
    pub fn take_buffer(&mut self, handle: ArenaHandle) -> Result<Vec<u8>, AdapterError> {
        let index = self.index_of(handle)?;
        let live_freed: u64 = {
            let slot = self.slot_checked(index, handle)?;
            match slot.state {
                SlotState::Freed | SlotState::Consumed => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::StaleBuffer,
                        "buffer already consumed or freed",
                    ));
                }
                SlotState::Uncommitted => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "buffer is not committed",
                    ));
                }
                SlotState::Committed => slot.data.len() as u64,
            }
        };
        let slot = self.slots.get_mut(index).ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::StaleBuffer, "unknown buffer handle")
        })?;
        let bytes = std::mem::take(&mut slot.data);
        slot.state = SlotState::Consumed;
        self.live = self.live.saturating_sub(1);
        self.total_retained = self.total_retained.saturating_sub(live_freed);
        self.free_list.push(index);
        Ok(bytes)
    }

    /// Release a handle. Idempotent: freeing a freed handle succeeds without
    /// touching accounting twice. Forged or stale handles are rejected.
    ///
    /// # Errors
    ///
    /// `stale-buffer` for unknown handles or generation mismatch only.
    pub fn free(&mut self, handle: ArenaHandle) -> Result<(), AdapterError> {
        let index = self.index_of(handle)?;
        let slot = self.slots.get_mut(index).ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::StaleBuffer, "unknown buffer handle")
        })?;
        if slot.generation != handle.generation {
            return Err(AdapterError::new(
                AdapterErrorCode::StaleBuffer,
                "stale buffer generation",
            ));
        }
        match slot.state {
            SlotState::Uncommitted | SlotState::Committed => {
                let held = slot.data.len() as u64;
                slot.data = Vec::new();
                slot.state = SlotState::Freed;
                self.live = self.live.saturating_sub(1);
                self.total_retained = self.total_retained.saturating_sub(held);
                self.free_list.push(index);
            }
            SlotState::Consumed => {
                // Ownership already moved out by `take_buffer` (which queued
                // the reuse entry); just mark the state.
                slot.state = SlotState::Freed;
            }
            SlotState::Freed => {}
        }
        Ok(())
    }

    /// Release every slot (session disposal). Handles are all stale after.
    pub fn clear(&mut self) {
        self.slots.clear();
        self.free_list.clear();
        self.live = 0;
        self.total_retained = 0;
    }

    /// Project a live handle onto its canonical protocol reference.
    ///
    /// # Errors
    ///
    /// `stale-buffer` for unknown/stale handles.
    pub fn to_protocol_handle(
        &self,
        handle: ArenaHandle,
    ) -> Result<ProtocolBufferHandle, AdapterError> {
        let index = self.index_of(handle)?;
        let slot = self.slots.get(index).ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::StaleBuffer, "unknown buffer handle")
        })?;
        if slot.generation != handle.generation {
            return Err(AdapterError::new(
                AdapterErrorCode::StaleBuffer,
                "stale buffer generation",
            ));
        }
        let id = handle.buffer_id().ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::Malformed, "buffer id out of range")
        })?;
        let length = u64::try_from(slot.data.len()).map_err(|_| {
            AdapterError::new(
                AdapterErrorCode::LimitExceeded,
                "buffer length does not fit the wire",
            )
        })?;
        Ok(ProtocolBufferHandle {
            id,
            generation: handle.generation,
            length,
            checksum: None,
        })
    }

    /// Parse a canonical protocol buffer reference back to an arena handle
    /// and require it to be sealed (`Committed`).
    ///
    /// # Errors
    ///
    /// `malformed` for wrong ID kinds or shapes; `stale-buffer` for unknown
    /// or stale generations; `wrong-state` for live but unsealed buffers.
    pub fn resolve_protocol(
        &self,
        reference: &ProtocolBufferHandle,
    ) -> Result<ArenaHandle, AdapterError> {
        let text = reference.id.as_str();
        let suffix = text.strip_prefix("buf:").ok_or_else(|| {
            AdapterError::new(
                AdapterErrorCode::Malformed,
                "buffer reference has the wrong id kind",
            )
        })?;
        let id: u32 = suffix.parse().map_err(|_| {
            AdapterError::new(
                AdapterErrorCode::Malformed,
                "buffer reference id is not numeric",
            )
        })?;
        let handle = ArenaHandle {
            id,
            generation: reference.generation,
        };
        let index = self.index_of(handle)?;
        let slot = self.slots.get(index).ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::StaleBuffer, "unknown buffer handle")
        })?;
        if slot.generation != handle.generation {
            return Err(AdapterError::new(
                AdapterErrorCode::StaleBuffer,
                "stale buffer generation",
            ));
        }
        match slot.state {
            SlotState::Committed => Ok(handle),
            SlotState::Uncommitted => Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "referenced buffer is not committed",
            )),
            SlotState::Consumed | SlotState::Freed => Err(AdapterError::new(
                AdapterErrorCode::StaleBuffer,
                "referenced buffer ownership already released",
            )),
        }
    }

    /// Borrow a committed input alongside a writable uncommitted output for
    /// one pure processing call. Distinct slots only (in-place is rejected).
    ///
    /// # Errors
    ///
    /// `stale-buffer` for released/unknown/stale handles; `wrong-state` for
    /// bad seal states or input/output aliasing.
    pub fn processing_pair(
        &mut self,
        input: ArenaHandle,
        output: ArenaHandle,
    ) -> Result<(&[u8], &mut [u8]), AdapterError> {
        let input_index = self.index_of(input)?;
        let output_index = self.index_of(output)?;
        if input_index == output_index {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "in-place processing is forbidden in adapter v1",
            ));
        }
        {
            let slot = self.slot_checked(input_index, input)?;
            match slot.state {
                SlotState::Committed => {}
                SlotState::Uncommitted => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "processing input is not committed",
                    ));
                }
                SlotState::Consumed | SlotState::Freed => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::StaleBuffer,
                        "processing input ownership already released",
                    ));
                }
            }
        }
        {
            let slot = self.slot_checked(output_index, output)?;
            match slot.state {
                SlotState::Uncommitted => {}
                SlotState::Committed => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::WrongState,
                        "processing output is sealed; allocate a fresh buffer",
                    ));
                }
                SlotState::Consumed | SlotState::Freed => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::StaleBuffer,
                        "processing output ownership already released",
                    ));
                }
            }
        }
        // Both indices are valid (checked above); split for disjoint borrows.
        if input_index < output_index {
            let (head, tail) = self.slots.split_at_mut(output_index);
            let input_bytes = head.get(input_index).map(|slot| slot.data.as_slice());
            let output_bytes = tail.first_mut().map(|slot| slot.data.as_mut_slice());
            match (input_bytes, output_bytes) {
                (Some(input_bytes), Some(output_bytes)) => Ok((input_bytes, output_bytes)),
                _ => Err(AdapterError::new(
                    AdapterErrorCode::StaleBuffer,
                    "buffer handle invalidated",
                )),
            }
        } else {
            let (head, tail) = self.slots.split_at_mut(input_index);
            let output_bytes = head
                .get_mut(output_index)
                .map(|slot| slot.data.as_mut_slice());
            let input_bytes = tail.first().map(|slot| slot.data.as_slice());
            match (input_bytes, output_bytes) {
                (Some(input_bytes), Some(output_bytes)) => Ok((input_bytes, output_bytes)),
                _ => Err(AdapterError::new(
                    AdapterErrorCode::StaleBuffer,
                    "buffer handle invalidated",
                )),
            }
        }
    }

    fn index_of(&self, handle: ArenaHandle) -> Result<usize, AdapterError> {
        let index = usize::try_from(handle.id).map_err(|_| {
            AdapterError::new(AdapterErrorCode::StaleBuffer, "unknown buffer handle")
        })?;
        if self.slots.get(index).is_none() {
            return Err(AdapterError::new(
                AdapterErrorCode::StaleBuffer,
                "unknown buffer handle",
            ));
        }
        Ok(index)
    }

    fn slot_checked(&self, index: usize, handle: ArenaHandle) -> Result<&Slot, AdapterError> {
        let slot = self.slots.get(index).ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::StaleBuffer, "unknown buffer handle")
        })?;
        if slot.generation != handle.generation {
            return Err(AdapterError::new(
                AdapterErrorCode::StaleBuffer,
                "stale buffer generation",
            ));
        }
        Ok(slot)
    }
}

impl Default for ByteArena {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn committed_arena(bytes: &[u8]) -> (ByteArena, ArenaHandle) {
        let mut arena = ByteArena::new();
        let length = u64::try_from(bytes.len()).unwrap();
        let handle = arena.allocate(length).unwrap();
        arena.write_bytes(handle, 0, bytes).unwrap();
        arena.commit(handle, length).unwrap();
        (arena, handle)
    }

    #[test]
    fn round_trip_is_exactly_once() {
        let (mut arena, handle) = committed_arena(b"tile-bytes");
        let taken = arena.take_buffer(handle).unwrap();
        assert_eq!(taken, b"tile-bytes");
        let again = arena.take_buffer(handle);
        assert_eq!(again.unwrap_err().code(), AdapterErrorCode::StaleBuffer);
    }

    #[test]
    fn free_is_idempotent_but_forged_handles_fail() {
        let mut arena = ByteArena::new();
        let handle = arena.allocate(8).unwrap();
        arena.free(handle).unwrap();
        arena.free(handle).unwrap();
        let forged = ArenaHandle {
            id: 9999,
            generation: 1,
        };
        assert_eq!(
            arena.free(forged).unwrap_err().code(),
            AdapterErrorCode::StaleBuffer
        );
    }

    #[test]
    fn reuse_bumps_generation() {
        let mut arena = ByteArena::new();
        let first = arena.allocate(4).unwrap();
        arena.free(first).unwrap();
        let second = arena.allocate(4).unwrap();
        assert_eq!(second.id, first.id);
        assert_ne!(second.generation, first.generation);
        assert_eq!(
            arena.write_bytes(first, 0, b"stale").unwrap_err().code(),
            AdapterErrorCode::StaleBuffer
        );
    }
}
