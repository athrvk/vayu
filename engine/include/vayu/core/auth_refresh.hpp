#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/auth_resolver.hpp"
#include "vayu/types.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace vayu::core {

/**
 * @brief A run's live OAuth 2.0 credential, refreshed while the run is going.
 *
 * A load run used to resolve auth exactly once, so a run outliving its token
 * turned into a 401 storm the report never explained. This is the shared cell
 * that fixes it: the run's refresh watchdog re-acquires the token before it
 * expires and publishes the new header value here, and the *submitting* thread
 * copies it onto the request it hands to the event loop.
 *
 * Only header-placed tokens are covered - see `http::plan_auth_refresh` for
 * every case that stays inert.
 *
 * Threading: exactly one publisher (the watchdog) and one reader (the strategy
 * thread, which is the event loop's sole producer). The reader's hot path is a
 * relaxed load of `generation`; it takes the mutex only on the tick after a
 * refresh actually happened, which is once per token lifetime.
 */
class AuthRefreshState {
    public:
    explicit AuthRefreshState (vayu::http::AuthRefreshPlan plan);

    /// The oauth2 config the watchdog re-acquires with.
    [[nodiscard]] const nlohmann::json& config () const {
        return plan_.config;
    }
    /// Header the token is placed on (`Authorization` today).
    [[nodiscard]] const std::string& header_name () const {
        return plan_.header_name;
    }
    /// Absolute expiry (ms since epoch) of the token currently published.
    [[nodiscard]] int64_t expires_at_ms () const {
        return expires_at_ms_.load (std::memory_order_relaxed);
    }

    /**
     * @brief Bumped on every successful swap; the reader's change detector.
     *
     * Read relaxed on the hot path: it is the only thing the submitting thread
     * looks at per request, and a swap seen one submission late is a request
     * sent with a credential that is still valid (the lead exists for exactly
     * that slack).
     */
    [[nodiscard]] uint64_t generation () const {
        return generation_.load (std::memory_order_acquire);
    }

    /// The value to send now. Locks - not for the per-request path.
    [[nodiscard]] std::string header_value () const;

    /**
     * @brief Publish a refreshed credential.
     *
     * @param value        The new header value.
     * @param at_seconds   Seconds into the run, for the report.
     * @param expires_at_ms Absolute expiry of the new token, 0 when it does not
     *                      expire (the watchdog then stops).
     */
    void publish (std::string value, double at_seconds, int64_t expires_at_ms);

    /// Record a refresh that did not happen. The run continues either way.
    void record_failure (const std::string& error);

    /**
     * @brief The report's `auth` section: when the run refreshed, and what went
     *        wrong if anything did.
     *
     * Written whenever the watchdog was armed, including the zero case - "we
     * were watching and never needed to" is an answer, and an absent section
     * already means "this run could not refresh at all".
     */
    [[nodiscard]] nlohmann::json summary () const;

    private:
    vayu::http::AuthRefreshPlan plan_;
    std::atomic<int64_t> expires_at_ms_{ 0 };
    std::atomic<uint64_t> generation_{ 0 };

    mutable std::mutex mutex_;
    std::string header_value_;
    std::vector<double> refreshed_at_seconds_;
    size_t failures_ = 0;
    std::string last_error_;
};

/**
 * @brief Copy the run's current credential onto @p request when it has moved.
 *
 * Called by the submitting thread immediately before each `EventLoop::submit`,
 * which copies the request wholesale into the transfer - so a value written
 * here reaches every subsequent transfer and none of the ones already queued.
 *
 * @param state           The run's refresh cell, or null for a run with none.
 * @param request         The submitting thread's own copy of the request.
 * @param seen_generation In/out: the generation this copy already carries.
 */
void sync_auth_header (const std::shared_ptr<AuthRefreshState>& state,
vayu::Request& request,
uint64_t& seen_generation);

/**
 * @brief How long to sleep before refreshing a token that expires at
 *        @p expires_at_ms, refreshing @p lead_ms early.
 *
 * Floored at `constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS` rather than at
 * zero: a token whose whole lifetime is shorter than the lead is always inside
 * its refresh window, and an unfloored schedule would re-acquire in a tight
 * loop. Extracted from the watchdog so the schedule is testable without a clock.
 */
[[nodiscard]] int64_t
auth_refresh_delay_ms (int64_t expires_at_ms, int64_t now_ms, int64_t lead_ms);

} // namespace vayu::core
