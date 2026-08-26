#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <chrono>
#include <cstdint>
#include <optional>

namespace vayu::http {

/**
 * Identifies one live-stream claim on one resource.
 *
 * Never zero and never reused *within a slot*, so a stream that was evicted
 * while it was not writing cannot act on the claim that replaced it - see
 * LiveClaimSlot.
 */
using LiveClaim = std::uint64_t;

/**
 * The single-watcher slot an SSE endpoint hands out (issue #506).
 *
 * Every engine SSE endpoint occupies one cpp-httplib pool thread for as long as
 * its stream is open (the server uses the default task queue), so an unbounded
 * number of watchers on one resource is an unbounded number of parked threads.
 * One holder at a time is the rule; the subtlety is how a holder is retired.
 *
 * A claim held by a **provably dead** stream is taken over rather than refused:
 * the holder only notices its socket died when the next write fails, up to one
 * poll interval later, so a client reconnecting inside that window used to meet
 * a 409 - which `EventSource` treats as fatal, killing the stream for good. A
 * holder that has not written successfully for `stale_after` is not writing, so
 * its slot is given to the newcomer. Every live holder writes at least a
 * keep-alive well inside that window, so a genuinely live stream is never
 * evicted and a second concurrent watcher is still refused.
 *
 * `stale_after` is passed per call rather than held, because the window is
 * derived from the owner's own cadence (an inbox's poll interval, a stream's
 * keep-alive interval) and those differ per resource.
 *
 * **Not** internally synchronized: every method must be called under the lock
 * that guards the owning record, which is also the lock its other fields are
 * read under. That is what lets an owner adopt it without changing its locking
 * - `InboxManager` holds one per inbox under its own `mutex_`,
 * `SseStreamContext` one under a mutex of its own.
 */
class LiveClaimSlot {
    public:
    /**
     * Claim the slot, or report that a live holder has it.
     *
     * @param stale_after How long without a successful write makes the current
     *                    holder presumed dead and its slot takeable.
     */
    std::optional<LiveClaim> try_claim (std::chrono::milliseconds stale_after) {
        if (holder_ != 0) {
            const auto since = std::chrono::steady_clock::now () - last_write_;
            if (since < stale_after) {
                return std::nullopt;
            }
        }
        holder_     = ++next_claim_;
        last_write_ = std::chrono::steady_clock::now ();
        return holder_;
    }

    /**
     * Record that @p claim just wrote to its socket, and report whether it is
     * still the holder.
     *
     * False means the claim was taken over while this stream was not writing -
     * the caller must end its stream without releasing, since the slot now
     * belongs to someone else.
     */
    bool note_write (LiveClaim claim) {
        if (holder_ != claim) {
            return false;
        }
        last_write_ = std::chrono::steady_clock::now ();
        return true;
    }

    /// Release @p claim's slot. A no-op when @p claim is no longer the holder,
    /// so an evicted holder cannot release its successor's slot.
    void release (LiveClaim claim) {
        if (holder_ == claim) {
            holder_ = 0;
        }
    }

    private:
    /// 0 means unclaimed.
    LiveClaim holder_ = 0;
    /// Source of claim tokens; monotonic so a token is never reused, and
    /// therefore never mistaken for a later claim on the same slot.
    LiveClaim next_claim_ = 0;
    /// When the holder last wrote to its socket successfully. A holder writes
    /// at least a keep-alive every interval, so a long gap here is the only
    /// evidence available that its socket is gone: cpp-httplib reports that
    /// only through the next failing write.
    std::chrono::steady_clock::time_point last_write_;
};

} // namespace vayu::http
