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
#include <utility>
#include <variant>

namespace vayu::core {

namespace {

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/// Sleep in slices so a stop is honoured promptly: the worker joins this thread
/// on the way out, and a watchdog asleep until the next expiry would hold a
/// finished run open for the rest of the token's life.
constexpr int64_t SLICE_MS = 100;

/// @return false if the run ended while waiting.
bool wait_while_running (const std::shared_ptr<RunContext>& context, int64_t delay_ms) {
    int64_t waited = 0;
    while (waited < delay_ms) {
        if (!context->is_running.load () || context->should_stop.load ()) {
            return false;
        }
        const int64_t slice = std::min (SLICE_MS, delay_ms - waited);
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
        refreshed_at_seconds_.push_back (at_seconds);
    }
    expires_at_ms_.store (expires_at_ms, std::memory_order_relaxed);
    // Release: the reader acquires this counter and then takes the mutex, so
    // the value written above is what it finds there.
    generation_.fetch_add (1, std::memory_order_release);
}

void AuthRefreshState::record_failure (const std::string& error) {
    const std::lock_guard<std::mutex> lock (mutex_);
    ++failures_;
    last_error_ = error;
}

nlohmann::json AuthRefreshState::summary () const {
    const std::lock_guard<std::mutex> lock (mutex_);
    nlohmann::json refreshes = nlohmann::json::array ();
    for (const double at : refreshed_at_seconds_) {
        refreshes.push_back ({ { "atSeconds", at } });
    }
    nlohmann::json out;
    out["refreshes"]       = refreshes;
    out["refreshFailures"] = failures_;
    if (!last_error_.empty ()) {
        out["lastError"] = last_error_;
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

int64_t auth_refresh_delay_ms (int64_t expires_at_ms, int64_t now_ms, int64_t lead_ms) {
    return std::max (constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS,
    expires_at_ms - lead_ms - now_ms);
}

void run_auth_refresh (std::shared_ptr<RunContext> context,
vayu::db::Database* db_ptr,
int64_t lead_ms) {
    const auto state = context->auth_refresh;
    if (!state || db_ptr == nullptr) {
        return;
    }
    auto& db = *db_ptr;

    int64_t retry_ms = constants::server::OAUTH2_REFRESH_RETRY_MS;

    while (context->is_running.load () && !context->should_stop.load ()) {
        const int64_t expires_at = state->expires_at_ms ();
        if (expires_at <= 0) {
            return; // The published token does not expire - nothing left to do.
        }
        if (!wait_while_running (
            context, auth_refresh_delay_ms (expires_at, now_ms (), lead_ms))) {
            return;
        }

        auto result = vayu::http::oauth::acquire_token (db, state->config (),
        /*force_refresh=*/true, std::nullopt);

        if (const auto* err = std::get_if<vayu::http::oauth::TokenError> (&result)) {
            // Reported, never fatal: the run keeps sending the credential it
            // has, and the report's auth section plus the target's own 401s
            // say what happened.
            const std::string message = err->code + ": " + err->message;
            state->record_failure (message);
            vayu::utils::log_warning ("OAuth2 mid-run refresh failed for run " +
            context->run_id + " - " + message);
            if (!wait_while_running (context, retry_ms)) {
                return;
            }
            retry_ms = std::min (retry_ms * 2, constants::server::OAUTH2_REFRESH_RETRY_MAX_MS);
            continue;
        }

        retry_ms                = constants::server::OAUTH2_REFRESH_RETRY_MS;
        const auto& token       = std::get<vayu::db::OAuthToken> (result);
        const double at_seconds = context->start_time_ms > 0 ?
        static_cast<double> (now_ms () - context->start_time_ms) / 1000.0 :
        0.0;
        state->publish (
        vayu::http::oauth2_header_value (state->config (), token.access_token), at_seconds,
        token.expires_in > 0 ? token.created_at + token.expires_in * 1000 : 0);
        vayu::utils::log_info ("OAuth2: refreshed the token for run " + context->run_id);
    }
}

} // namespace vayu::core
