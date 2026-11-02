#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/constants.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/types.hpp"

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace vayu::core {

/**
 * @brief One live OAuth 2.0 credential of a load run, refreshed while the run
 *        is going.
 *
 * A load run resolves auth once, before it sends, so without this a run
 * outliving its token turns into a 401 storm the report never explains. The
 * credential's refresh watchdog re-acquires the token before it expires and
 * publishes the new header value here, and the *submitting* thread copies it
 * onto each request it hands to the event loop. A single-request run has at
 * most one; a scenario load run has one per distinct token-cache key its steps
 * send (`plan_scenario_auth_refresh`, #3199).
 *
 * Only header-placed tokens are covered - see `http::plan_oauth2_refresh` for
 * every case that stays inert.
 *
 * Threading: exactly one publisher (its watchdog) and one reader (the run's
 * submitting thread, the event loop's sole producer). The reader's hot path is
 * a relaxed load of `generation`; it takes the mutex only on the submission
 * after a refresh actually happened, which is once per token lifetime.
 */
class AuthRefreshState {
    public:
    explicit AuthRefreshState (vayu::http::AuthRefreshPlan plan);

    /// The oauth2 config the watchdog re-acquires with.
    [[nodiscard]] const nlohmann::json& config () const {
        return plan_.config;
    }
    /// The bound on each refresh's token request: the run's request timeout.
    [[nodiscard]] int timeout_ms () const {
        return plan_.timeout_ms;
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

    /// Record a refresh that did not happen, @p at_seconds into the run. The
    /// run continues either way.
    void record_failure (const std::string& error, double at_seconds);

    /**
     * @brief The report's `auth` section: when the run refreshed, and what went
     *        wrong if anything did.
     *
     * Written whenever the watchdog was armed, including the zero case - "we
     * were watching and never needed to" is an answer, and an absent section
     * already means "this run could not refresh at all".
     */
    [[nodiscard]] nlohmann::json summary () const;

    /**
     * @brief The `auth` section for every credential a run kept current, in
     *        the one shape `summary` writes for a single one.
     *
     * `refreshes` is every credential's, ordered by `atSeconds`;
     * `refreshFailures` is their sum; `lastError` is the most recent failure
     * of any of them. Nothing for an empty @p states, which is the run that
     * was never watching.
     */
    [[nodiscard]] static std::optional<nlohmann::json> summarize (
    const std::vector<std::shared_ptr<AuthRefreshState>>& states);

    private:
    /// What the report reads, copied out under the mutex.
    struct Tally {
        std::vector<double> refreshed_at_seconds;
        size_t failures = 0;
        std::string last_error;
        double last_failure_at_seconds = 0.0;
    };
    [[nodiscard]] Tally tally () const;
    [[nodiscard]] static nlohmann::json section (const Tally& tally);

    vayu::http::AuthRefreshPlan plan_;
    std::atomic<int64_t> expires_at_ms_{ 0 };
    std::atomic<uint64_t> generation_{ 0 };

    mutable std::mutex mutex_;
    std::string header_value_;
    Tally tally_;
};

/**
 * @brief The submitting thread's copy of one credential, for a request it
 *        rebuilds per submission.
 *
 * `sync_auth_header` serves a request the submitting thread keeps and resends,
 * so it writes only when the credential moved. A scenario step is copied fresh
 * from the plan on every submission, still carrying the token it was planned
 * with, so the current value has to be written every time; this keeps that
 * value and re-reads the state (under its mutex) only when the generation
 * moves. Built from the state's current value, so every step sharing a
 * credential sends the newest token from the first submission on. Owned and
 * used by the submitting thread only.
 */
class AuthHeaderCache {
    public:
    explicit AuthHeaderCache (std::shared_ptr<AuthRefreshState> state);

    /// Put the credential's current value on @p request.
    void write_onto (vayu::Request& request);

    private:
    std::shared_ptr<AuthRefreshState> state_;
    uint64_t seen_generation_ = 0;
    std::string value_;
};

/**
 * @brief Which steps of a scenario load run can keep their OAuth 2.0 token
 *        current, and with how many watchdogs (#3199).
 */
struct ScenarioAuthRefreshPlan {
    /// One per distinct token-cache key (`oauth::cache_key`), in the order the
    /// plan first sends it. Never two for one key: each watchdog force-refreshes
    /// the cache row, and two on one row would spend a rotating refresh token
    /// twice.
    std::vector<vayu::http::AuthRefreshPlan> credentials;
    /// One entry per plan step: the index into `credentials` that step's
    /// `Authorization` follows, or nothing for a step that sends what it was
    /// planned with.
    std::vector<std::optional<size_t>> step_credential;
};

/**
 * @brief Plan mid-run refresh over a scenario's steps.
 *
 * A step follows a credential when its plan resolved an OAuth 2.0 token into
 * it (`ScenarioStep::oauth2_config`), the engine placed that token on
 * `Authorization` itself (`Request::auth_header`; a user-set `Authorization`
 * wins and leaves it empty), and `http::plan_oauth2_refresh` accepts the
 * config. The token a step carries is not compared with the cache: a token
 * shorter-lived than the cache's expiry skew is re-acquired for every step
 * that plans it, so the earlier steps of a key already carry an older token
 * than the cache holds, and the newest is what they should send.
 *
 * Steps that share a key share one credential. Its refresh is bounded by the
 * shortest timeout among them, so no step waits on a token request longer
 * than it would wait on its own. A step whose config writes the token under a
 * different `headerPrefix` than the key's first step stays unarmed: one
 * credential publishes one header value.
 *
 * @param db Token-cache handle; null arms nothing.
 */
[[nodiscard]] ScenarioAuthRefreshPlan
plan_scenario_auth_refresh (const ScenarioPlan& plan, vayu::db::Database* db);

/**
 * @brief The knobs a run's refresh watchdog reads, resolved once when it arms.
 *
 * Every field is a user setting (`oauth2Refresh*`, seeded in
 * `seed_default_config`), read at arm time rather than per iteration so a run's
 * schedule cannot change under it half way through - a change applies to the
 * next run started.
 */
struct AuthRefreshTuning {
    /// How far ahead of expiry to renew.
    int64_t lead_ms = constants::server::OAUTH2_REFRESH_LEAD_MS;
    /// Floor on the wait between two renewals - see auth_refresh_delay_ms.
    int64_t min_interval_ms = constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS;
    /// First wait after a refused renewal, doubled per consecutive failure.
    int64_t retry_ms = constants::server::OAUTH2_REFRESH_RETRY_MS;
    /// Ceiling on that backoff.
    int64_t retry_max_ms = constants::server::OAUTH2_REFRESH_RETRY_MAX_MS;
    /// How often the watchdog wakes while waiting, to notice the run has ended
    /// - what bounds how long a finished run waits to join it.
    int64_t poll_interval_ms = constants::server::OAUTH2_REFRESH_POLL_INTERVAL_MS;
};

/**
 * @brief Read the `oauth2Refresh*` settings, falling back to their defaults.
 *
 * One reader for the four keys, so the run and any future caller cannot
 * disagree about which key names or defaults are in force.
 */
[[nodiscard]] AuthRefreshTuning read_auth_refresh_tuning (vayu::db::Database& db);

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
 *        @p expires_at_ms, refreshing `tuning.lead_ms` early.
 *
 * Floored at `tuning.min_interval_ms` rather than at zero: a token whose whole
 * lifetime is shorter than the lead is always inside its refresh window, and an
 * unfloored schedule would re-acquire in a tight loop. Extracted from the
 * watchdog so the schedule is testable without a clock.
 */
[[nodiscard]] int64_t auth_refresh_delay_ms (int64_t expires_at_ms,
int64_t now_ms,
const AuthRefreshTuning& tuning);

} // namespace vayu::core
