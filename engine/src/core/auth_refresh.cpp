/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/auth_refresh.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <chrono>
#include <thread>
#include <unordered_map>
#include <utility>
#include <variant>

namespace vayu::core {

namespace {

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/// Monotonic companion to `now_ms()`, for the one thing here that is a length
/// rather than a point in time: how far into the run a refresh landed. Wall
/// time can step mid-run and would report an offset that never happened.
/// Pairs with `RunContext::load_start_steady_ms`.
int64_t steady_now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now ().time_since_epoch ())
    .count ();
}

/// Sleep in slices of `poll_ms` so a stop is honoured promptly: the worker
/// joins this thread on the way out, and a watchdog asleep until the next
/// expiry would hold a finished run open for the rest of the token's life.
///
/// @return false if the run ended while waiting.
bool wait_while_running (const std::shared_ptr<RunContext>& context, int64_t delay_ms, int64_t poll_ms) {
    int64_t waited = 0;
    while (waited < delay_ms) {
        if (!context->is_running.load () || context->should_stop.load ()) {
            return false;
        }
        const int64_t slice = std::min (poll_ms, delay_ms - waited);
        std::this_thread::sleep_for (std::chrono::milliseconds (slice));
        waited += slice;
    }
    return context->is_running.load () && !context->should_stop.load ();
}

} // namespace

AuthRefreshState::AuthRefreshState (vayu::http::AuthRefreshPlan plan)
: plan_ (std::move (plan)), header_value_ (plan_.header_value) {
    expires_at_ms_.store (plan_.expires_at_ms, std::memory_order_relaxed);
}

std::string AuthRefreshState::header_value () const {
    const std::lock_guard<std::mutex> lock (mutex_);
    return header_value_;
}

void AuthRefreshState::publish (std::string value, double at_seconds, int64_t expires_at_ms) {
    {
        const std::lock_guard<std::mutex> lock (mutex_);
        header_value_ = std::move (value);
        tally_.refreshed_at_seconds.push_back (at_seconds);
    }
    expires_at_ms_.store (expires_at_ms, std::memory_order_relaxed);
    // Release: the reader acquires this counter and then takes the mutex, so
    // the value written above is what it finds there.
    generation_.fetch_add (1, std::memory_order_release);
}

void AuthRefreshState::record_failure (const std::string& error, double at_seconds) {
    const std::lock_guard<std::mutex> lock (mutex_);
    ++tally_.failures;
    tally_.last_error              = error;
    tally_.last_failure_at_seconds = at_seconds;
}

AuthRefreshState::Tally AuthRefreshState::tally () const {
    const std::lock_guard<std::mutex> lock (mutex_);
    return tally_;
}

nlohmann::json AuthRefreshState::section (const Tally& tally) {
    nlohmann::json refreshes = nlohmann::json::array ();
    for (const double at : tally.refreshed_at_seconds) {
        refreshes.push_back ({ { "atSeconds", at } });
    }
    nlohmann::json out;
    out["refreshes"]       = refreshes;
    out["refreshFailures"] = tally.failures;
    if (!tally.last_error.empty ()) {
        out["lastError"] = tally.last_error;
    }
    return out;
}

nlohmann::json AuthRefreshState::summary () const {
    return section (tally ());
}

std::optional<nlohmann::json> AuthRefreshState::summarize (
const std::vector<std::shared_ptr<AuthRefreshState>>& states) {
    if (states.empty ()) {
        return std::nullopt;
    }
    Tally merged;
    for (const auto& state : states) {
        const Tally one = state->tally ();
        merged.refreshed_at_seconds.insert (merged.refreshed_at_seconds.end (),
        one.refreshed_at_seconds.begin (), one.refreshed_at_seconds.end ());
        merged.failures += one.failures;
        const bool later = merged.last_error.empty () ||
        one.last_failure_at_seconds > merged.last_failure_at_seconds;
        if (!one.last_error.empty () && later) {
            merged.last_error              = one.last_error;
            merged.last_failure_at_seconds = one.last_failure_at_seconds;
        }
    }
    std::ranges::sort (merged.refreshed_at_seconds);
    return std::optional<nlohmann::json> (std::in_place, section (merged));
}

AuthHeaderCache::AuthHeaderCache (std::shared_ptr<AuthRefreshState> state)
: state_ (std::move (state)), seen_generation_ (state_->generation ()),
  value_ (state_->header_value ()) {
}

void AuthHeaderCache::write_onto (vayu::Request& request) {
    const uint64_t current = state_->generation ();
    if (current != seen_generation_) {
        value_           = state_->header_value ();
        seen_generation_ = current;
    }
    request.headers[state_->header_name ()] = value_;
}

namespace {

/// A step's own refresh plan, before it is grouped by key: nothing for a step
/// that did not have the engine place an OAuth 2.0 token on its header.
std::optional<vayu::http::AuthRefreshPlan>
step_refresh_plan (const ScenarioStep& step, vayu::db::Database* db) {
    if (!step.oauth2_config.is_object () || step.request.auth_header != "Authorization") {
        return std::nullopt;
    }
    return vayu::http::plan_oauth2_refresh (step.oauth2_config, step.request.timeout_ms, db);
}

} // namespace

ScenarioAuthRefreshPlan
plan_scenario_auth_refresh (const ScenarioPlan& plan, vayu::db::Database* db) {
    ScenarioAuthRefreshPlan out;
    out.step_credential.resize (plan.steps.size ());
    std::unordered_map<std::string, size_t> credential_of_key;
    for (size_t i = 0; i < plan.steps.size (); ++i) {
        auto candidate = step_refresh_plan (plan.steps[i], db);
        if (!candidate) {
            continue;
        }
        const auto [found, inserted] = credential_of_key.try_emplace (
        vayu::http::oauth::cache_key (candidate->config), out.credentials.size ());
        if (inserted) {
            out.credentials.push_back (std::move (*candidate));
            out.step_credential[i] = found->second;
            continue;
        }
        auto& shared = out.credentials.at (found->second);
        if (shared.header_value != candidate->header_value) {
            continue;
        }
        shared.timeout_ms = std::min (shared.timeout_ms, candidate->timeout_ms);
        out.step_credential[i] = found->second;
    }
    return out;
}

void sync_auth_header (const std::shared_ptr<AuthRefreshState>& state,
vayu::Request& request,
uint64_t& seen_generation) {
    if (!state) {
        return;
    }
    const uint64_t current = state->generation ();
    if (current == seen_generation) {
        return;
    }
    request.headers[state->header_name ()] = state->header_value ();
    seen_generation                        = current;
}

AuthRefreshTuning read_auth_refresh_tuning (vayu::db::Database& db) {
    const AuthRefreshTuning defaults;
    // A non-positive value is not a setting - POST /config rejects one against
    // each key's seeded minimum - so it can only reach here from a hand-edited
    // row, and a zero floor would turn the schedule into a tight loop against
    // the token endpoint. Fall back rather than trust it, as live_ring_size
    // does for the same reason.
    auto read = [&db] (const char* key, int64_t fallback) {
        const auto value =
        static_cast<int64_t> (db.get_config_int (key, static_cast<int> (fallback)));
        return value > 0 ? value : fallback;
    };
    AuthRefreshTuning tuning;
    tuning.lead_ms = read ("oauth2RefreshLeadMs", defaults.lead_ms);
    tuning.min_interval_ms = read ("oauth2RefreshMinIntervalMs", defaults.min_interval_ms);
    tuning.retry_ms = read ("oauth2RefreshRetryMs", defaults.retry_ms);
    tuning.retry_max_ms = read ("oauth2RefreshRetryMaxMs", defaults.retry_max_ms);
    tuning.poll_interval_ms =
    read ("oauth2RefreshPollIntervalMs", defaults.poll_interval_ms);
    return tuning;
}

int64_t auth_refresh_delay_ms (int64_t expires_at_ms, int64_t now_ms, const AuthRefreshTuning& tuning) {
    return std::max (tuning.min_interval_ms, expires_at_ms - tuning.lead_ms - now_ms);
}

void run_auth_refresh (const std::shared_ptr<RunContext>& context,
const std::shared_ptr<AuthRefreshState>& state,
vayu::db::Database* db_ptr,
const AuthRefreshTuning& tuning) {
    if (!state || db_ptr == nullptr) {
        return;
    }
    auto& db = *db_ptr;

    int64_t retry_ms = tuning.retry_ms;

    while (context->is_running.load () && !context->should_stop.load ()) {
        const int64_t expires_at = state->expires_at_ms ();
        if (expires_at <= 0) {
            return; // The published token does not expire - nothing left to do.
        }
        if (!wait_while_running (context,
            auth_refresh_delay_ms (expires_at, now_ms (), tuning), tuning.poll_interval_ms)) {
            return;
        }

        auto result = vayu::http::oauth::acquire_token (db, state->config (),
        /*force_refresh=*/true, std::nullopt, state->timeout_ms ());

        if (const auto* err = std::get_if<vayu::http::oauth::TokenError> (&result)) {
            // Reported, never fatal: the run keeps sending the credential it
            // has, and the report's auth section plus the target's own 401s
            // say what happened.
            const std::string message = err->code + ": " + err->message;
            state->record_failure (
            message, context->seconds_since_load_start (steady_now_ms ()));
            vayu::utils::log_warning ("oauth",
            "OAuth2 mid-run refresh failed for run " + context->run_id + " - " + message);
            if (!wait_while_running (context, retry_ms, tuning.poll_interval_ms)) {
                return;
            }
            retry_ms = std::min (retry_ms * 2, tuning.retry_max_ms);
            continue;
        }

        retry_ms          = tuning.retry_ms;
        const auto& token = std::get<vayu::db::OAuthToken> (result);
        const double at_seconds = context->seconds_since_load_start (steady_now_ms ());
        state->publish (
        vayu::http::oauth2_header_value (state->config (), token.access_token), at_seconds,
        token.expires_in > 0 ? token.created_at + (token.expires_in * 1000) : 0);
        vayu::utils::log_info (
        "oauth", "OAuth2: refreshed the token for run " + context->run_id);
    }
}

} // namespace vayu::core
