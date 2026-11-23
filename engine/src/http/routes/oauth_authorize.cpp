/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/oauth_authorize.cpp
 * @brief Interactive OAuth 2.0 authorization-code manager (engine-hosted
 *        loopback + PKCE) plus the URL builder. Lives with the routes because
 *        the loopback listener needs httplib (linked into the engine + tests).
 */

#include "vayu/http/oauth_authorize.hpp"

#include "vayu/http/managed_listener.hpp"
#include "vayu/http/oauth_client.hpp"
#include "vayu/http/oauth_discovery.hpp"
#include "vayu/http/oauth_registration.hpp"
#include "vayu/http/pkce.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/utils/stop_signal.hpp"

#include <httplib.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <expected>
#include <map>
#include <memory>
#include <optional>
#include <ranges>
#include <set>
#include <string_view>
#include <variant>
#include <vector>

namespace vayu::http {

namespace {

namespace limits = vayu::core::constants::oauth_authorize;

/// Where an attempt is. `Settling` is held by the one caller that won the
/// claim, until it publishes; every reader reports it as pending.
enum class AttemptState : std::uint8_t {
    Pending,
    Settling,
    Completed,
    Failed,
};

bool is_settled (AttemptState state) {
    return state == AttemptState::Completed || state == AttemptState::Failed;
}

constexpr const char* TIMED_OUT = "Authorization timed out";

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

std::string field (const nlohmann::json& obj, const char* key) {
    if (auto it = obj.find (key); it != obj.end () && it->is_string ()) {
        return it->get<std::string> ();
    }
    return {};
}

using vayu::utils::url_decode;

// Parse a query string ("a=1&b=2") into decoded key/value pairs.
std::map<std::string, std::string> parse_query (const std::string& query) {
    std::map<std::string, std::string> out;
    size_t pos = 0;
    while (pos < query.size ()) {
        const auto amp = query.find ('&', pos);
        const auto pair =
        query.substr (pos, amp == std::string::npos ? std::string::npos : amp - pos);
        if (const auto eq = pair.find ('='); eq != std::string::npos) {
            out[url_decode (pair.substr (0, eq))] = url_decode (pair.substr (eq + 1));
        }
        if (amp == std::string::npos)
            break;
        pos = amp + 1;
    }
    return out;
}

/**
 * The IdP's refusal an authorization redirect carries (RFC 6749 4.1.2.1), as
 * `<error>: <error_description>` or `<error>` alone, or nothing when the
 * redirect carries no `error`. Read by both the loopback callback and
 * `complete()`, so the two report one refusal in the same words (#3201).
 */
std::optional<std::string> redirect_refusal (
const std::map<std::string, std::string>& params) {
    const auto error = params.find ("error");
    if (error == params.end ()) {
        return std::nullopt;
    }
    std::string refusal = error->second;
    if (const auto description = params.find ("error_description");
    description != params.end ()) {
        refusal += ": " + description->second;
    }
    return refusal;
}

std::string generate_attempt_id () {
    return vayu::utils::generate_id ("oauth_");
}

/// Reports a failure from a frame nothing may escape (the destructor, the
/// reaper's thread entry); building the message allocates, so it is caught.
void log_unrecoverable (std::string_view what, std::string_view detail) noexcept {
    try {
        vayu::utils::log_error ("oauth", std::string (what) + ": " + std::string (detail));
    } catch (...) {
        // @deliberate the logger failed while reporting a failure in a frame
        // that terminates if anything escapes it; there is nowhere left to
        // report to.
    }
}

void refuse_start (RegistryRefusal refusal, AuthorizeStart& out) {
    if (refusal == RegistryRefusal::ShutDown) {
        refuse_shut_down (out);
        return;
    }
    out.ok            = false;
    out.http_status   = 429;
    out.error_code    = "oauth2_authorize_limit_reached";
    out.error_message = "At most " + std::to_string (limits::MAX_ATTEMPTS) +
    " sign-ins may be in progress at once - finish or cancel one first";
}

/// A start refused before its attempt is committed.
struct StartRefusal {
    int http_status = 400;
    std::string code;
    std::string message;
};

void fail_start (const StartRefusal& refusal, AuthorizeStart& out) {
    out.ok            = false;
    out.http_status   = refusal.http_status;
    out.error_code    = refusal.code;
    out.error_message = refusal.message;
}

/// A discovery's or a registration's failure as the start's answer: no usable
/// server URL is the caller's (400), running out of time a 504, and anything
/// the far side answered or failed to answer a 502.
StartRefusal upstream_refusal (std::string code, std::string message) {
    int status = 502;
    if (code == oauth_discovery::INVALID_SERVER_URL) {
        status = 400;
    } else if (code == oauth_discovery::TIMEOUT || code == oauth_registration::TIMEOUT) {
        status = 504;
    }
    return StartRefusal{ status, std::move (code), std::move (message) };
}

/// The config an attempt runs on, and what its discovery recorded.
struct AttemptPlan {
    nlohmann::json config;
    /// The `discoverUrl` the attempt was discovered from; empty when it was not.
    std::string server_url;
    /// The discovered authorization server; empty when the attempt was not
    /// discovered.
    std::string issuer;
    /// Where the attempt registers its client: set only when the config names
    /// no `clientId` and the discovered authorization server offers
    /// registration.
    std::optional<std::string> registration_endpoint;
};

/// Writes @p discovered into @p member when the config leaves it blank: a
/// value the config sets wins. Blank is what `url_field` reads as empty.
void fill_blank (nlohmann::json& config, const char* member, const std::string& discovered) {
    if (!discovered.empty () && oauth::url_field (config, member).empty ()) {
        config[member] = discovered;
    }
}

/// The MCP spec's scope selection: the 401 challenge's `scope`, else every
/// `scopes_supported` entry of the protected resource metadata, else none.
std::string discovered_scope (const OAuthDiscovery& found) {
    if (found.challenge_scope && !found.challenge_scope->empty ()) {
        return *found.challenge_scope;
    }
    std::string joined;
    for (const std::string& scope : found.resource_scopes_supported) {
        joined += (joined.empty () ? "" : " ") + scope;
    }
    return joined;
}

std::expected<AttemptPlan, StartRefusal> plan_discovered (const nlohmann::json& config,
std::string server_url,
const OAuthDiscovery& found) {
    const AuthorizationServerMetadata& server = found.authorization_server;
    AttemptPlan plan{ config, std::move (server_url), server.issuer, std::nullopt };
    fill_blank (plan.config, "authorizationUrl", server.authorization_endpoint);
    fill_blank (plan.config, "accessTokenUrl", server.token_endpoint);
    fill_blank (plan.config, "resource", found.resource);
    fill_blank (plan.config, "scope", discovered_scope (found));
    if (!field (config, "clientId").empty ()) {
        return plan;
    }
    if (!server.registration_endpoint) {
        return std::unexpected (StartRefusal{ 400, "oauth2_client_id_required",
        "The authorization server " + server.issuer +
        " offers no dynamic client registration (its metadata has no "
        "registration_endpoint) - enter the client id registered with it in "
        "clientId" });
    }
    plan.registration_endpoint = *server.registration_endpoint;
    // The registered client is public: a secret typed for another client must
    // not authenticate it.
    plan.config.erase ("clientSecret");
    return plan;
}

/// @p config as it starts: unchanged, or completed from the discovery of its
/// `discoverUrl`.
std::expected<AttemptPlan, StartRefusal> plan_attempt (vayu::db::Database& db,
const nlohmann::json& config,
AuthorizationServerMetadataCache& cache,
const std::atomic<bool>* cancel) {
    std::string server_url = oauth::url_field (config, "discoverUrl");
    if (server_url.empty ()) {
        return AttemptPlan{ config, {}, {}, std::nullopt };
    }
    auto found = discover_oauth_server (db, server_url,
    routes::resolve_request_timeout_ms (nlohmann::json::object (), db), cancel, cache);
    if (!found) {
        return std::unexpected (upstream_refusal (
        std::move (found.error ().code), std::move (found.error ().message)));
    }
    return plan_discovered (config, std::move (server_url), *found);
}

std::expected<void, StartRefusal> require_complete (const AttemptPlan& plan) {
    const bool has_client =
    !field (plan.config, "clientId").empty () || plan.registration_endpoint;
    if (!plan.config.is_object () ||
    oauth::url_field (plan.config, "authorizationUrl").empty () || !has_client) {
        return std::unexpected (StartRefusal{ 400, "oauth2_invalid_config",
        "authorizationUrl and clientId are required" });
    }
    return {};
}

/// Registers the plan's client for @p redirect_uri when it has none, writing
/// the issued id into its config.
std::expected<void, StartRefusal> register_client (vayu::db::Database& db,
AttemptPlan& plan,
const std::string& redirect_uri,
const std::atomic<bool>* cancel) {
    if (!plan.registration_endpoint) {
        return {};
    }
    auto client_id = register_oauth_client (db, *plan.registration_endpoint,
    redirect_uri, plan.server_url,
    routes::resolve_request_timeout_ms (nlohmann::json::object (), db), cancel);
    if (!client_id) {
        return std::unexpected (upstream_refusal (std::move (client_id.error ().code),
        std::move (client_id.error ().message)));
    }
    plan.config["clientId"] = std::move (*client_id);
    return {};
}

ResolvedAuthorization resolved_authorization (const nlohmann::json& config,
const std::string& issuer) {
    return ResolvedAuthorization{ oauth::url_field (config, "authorizationUrl"),
        oauth::url_field (config, "accessTokenUrl"), field (config, "clientId"),
        field (config, "resource"), field (config, "scope"), issuer };
}

} // namespace

std::string build_authorize_url (const nlohmann::json& config,
const std::string& state,
const std::string& code_challenge,
const std::string& redirect_uri,
bool pkce) {
    std::string url = oauth::url_field (config, "authorizationUrl");

    std::vector<std::pair<std::string, std::string>> params = {
        { "response_type", "code" },
        { "client_id", field (config, "clientId") },
        { "redirect_uri", redirect_uri },
        { "state", state },
    };
    if (const auto scope = field (config, "scope"); !scope.empty ()) {
        params.emplace_back ("scope", scope);
    }
    if (const auto audience = field (config, "audience"); !audience.empty ()) {
        params.emplace_back ("audience", audience);
    }
    if (const auto resource = field (config, "resource"); !resource.empty ()) {
        params.emplace_back ("resource", resource);
    }
    if (pkce) {
        params.emplace_back ("code_challenge", code_challenge);
        params.emplace_back ("code_challenge_method", "S256");
    }
    // A navigation has no body or headers, so every row rides the query
    // whatever its `sendAs`. One named like a parameter written above is
    // skipped: the engine's value wins and no name appears twice.
    const std::set<std::string, std::less<>> written (
    std::views::keys (params).begin (), std::views::keys (params).end ());
    for (oauth::ExtraParam& row : oauth::extra_params (config, oauth::AUTHORIZATION_PARAMS)) {
        if (!written.contains (row.key)) {
            params.emplace_back (std::move (row.key), std::move (row.value));
        }
    }

    url.push_back (url.find ('?') == std::string::npos ? '?' : '&');
    url += vayu::utils::form_encode (params);
    return url;
}

// ---------------------------------------------------------------------------
// Attempt + manager
// ---------------------------------------------------------------------------

/** What a callback resolved to, for the attempt to record. */
struct CallbackOutcome {
    AttemptState result_state = AttemptState::Failed; ///< Completed or Failed.
    std::string error;
    std::string cache_key;
    const char* heading = "Authorization failed";
};

/** The one-page reply the callback tab gets, whatever happened. */
std::string callback_page (const char* heading) {
    return std::string (
           "<html><body style='font-family:sans-serif;padding:2rem'><h3>") +
    heading + "</h3><p>You can close this tab.</p></body></html>";
}

/**
 * Whether the callback carries the attempt's own `state`. It is the only proof
 * the IdP sent the redirect, and the IdP echoes it on an error redirect too
 * (RFC 6749 4.1.2.1), so nothing else in a callback is read without it.
 */
bool callback_state_matches (const std::map<std::string, std::string>& params,
const std::string& expected_state) {
    const auto state = params.find ("state");
    return state != params.end () && state->second == expected_state;
}

/**
 * The outcome of a callback whose state matched: the IdP's own refusal, or the
 * token exchange this redirect exists to make, which @p cancel (when set) ends
 * early. Never throws: a claimed attempt that never publishes is never reaped.
 */
CallbackOutcome resolve_oauth_callback (vayu::db::Database& db,
const nlohmann::json& config,
const std::string& code_verifier,
const std::string& redirect_uri,
const std::map<std::string, std::string>& params,
const std::atomic<bool>* cancel) {
    CallbackOutcome outcome;
    if (auto refusal = redirect_refusal (params)) {
        outcome.error = std::move (*refusal);
        return outcome;
    }

    outcome.heading = "Token exchange failed";
    try {
        const std::string code = params.count ("code") ? params.at ("code") : "";
        oauth::InteractiveExchange exchange{ code, code_verifier, redirect_uri };
        // Bounded by the setting: an exchange has no payload to carry a timeout.
        auto result = oauth::acquire_token (db, config, false, exchange,
        routes::resolve_request_timeout_ms (nlohmann::json::object (), db),
        nullptr, cancel);
        if (!std::holds_alternative<vayu::db::OAuthToken> (result)) {
            outcome.error = std::get<oauth::TokenError> (result).message;
            return outcome;
        }
    } catch (const std::exception& e) {
        outcome.error = e.what ();
        return outcome;
    }
    outcome.cache_key    = oauth::cache_key (config);
    outcome.result_state = AttemptState::Completed;
    outcome.heading      = "Authorization received";
    return outcome;
}

struct OAuth2AuthorizeManager::Attempt {
    std::string state;
    std::string code_verifier;
    nlohmann::json config;
    std::string redirect_uri;
    bool pkce = true;
    Clock::time_point deadline;
    Clock::time_point erase_at;

    std::atomic<AttemptState> result_state{ AttemptState::Pending };
    // Written once, by the claim winner (the callback handler, the reaper or
    // complete()), and read only once result_state is settled.
    std::string error;
    std::string cache_key;

    /// What an embedded completion's exchange watches. That exchange runs
    /// outside the registry's lock, and a cancel or a shutdown can destroy this
    /// record under it, so the flag is shared and raised by the destructor.
    std::shared_ptr<std::atomic<bool>> completion_cancel =
    std::make_shared<std::atomic<bool>> (false);

    Attempt () = default;
    ~Attempt () {
        completion_cancel->store (true, std::memory_order_release);
    }
    Attempt (const Attempt&)            = delete;
    Attempt& operator= (const Attempt&) = delete;
    Attempt (Attempt&&)                 = delete;
    Attempt& operator= (Attempt&&)      = delete;

    [[nodiscard]] bool expired (Clock::time_point now) const {
        return now >= deadline;
    }

    /// Take the one right to settle a pending attempt (#2369). The callback
    /// handler writes `error` and `cache_key` without the registry's lock,
    /// which it cannot take: a teardown under the lock joins the handler's
    /// thread. The claim is what keeps a late callback from rewriting a
    /// settled attempt's fields. Only the reaper claims past the deadline.
    bool claim () {
        AttemptState expected = AttemptState::Pending;
        return result_state.compare_exchange_strong (expected, AttemptState::Settling);
    }

    /// The claim winner's write. The settled state is stored last, so a reader
    /// that sees it also sees the fields it describes.
    void publish (AttemptState settled_state, std::string error_text, std::string key) {
        error     = std::move (error_text);
        cache_key = std::move (key);
        result_state.store (settled_state);
    }

    /// What every reader reports, without changing anything: a pending
    /// attempt past its deadline is the timeout the reaper will record.
    [[nodiscard]] AuthorizeStatus observed (Clock::time_point now) const {
        switch (result_state.load ()) {
        case AttemptState::Completed: return { "completed", error, cache_key };
        case AttemptState::Failed: return { "failed", error, cache_key };
        case AttemptState::Settling: return { "pending", "", "" };
        case AttemptState::Pending: break;
        }
        if (expired (now)) {
            return { "failed", TIMED_OUT, "" };
        }
        return { "pending", "", "" };
    }

    /// The loopback listener's `/callback`: the IdP's redirect, or any local
    /// process that found the port.
    void answer_callback (vayu::db::Database& db,
    const std::string& attempt_id,
    const httplib::Request& req,
    httplib::Response& res) {
        const auto query  = req.target.find ('?');
        const auto params = parse_query (
        query == std::string::npos ? std::string{} : req.target.substr (query + 1));
        // Any local process can reach this port, so a callback without the
        // attempt's state leaves it pending and the listener waiting.
        if (!callback_state_matches (params, state)) {
            vayu::utils::log_warning ("oauth",
            "OAuth callback ignored, missing or wrong state: " + attempt_id);
            res.status = 400;
            res.set_content (callback_page ("State mismatch (possible CSRF)"), "text/html");
            return;
        }
        // Past the deadline the attempt is already the timeout every reader
        // reports, so a late redirect cannot turn it around.
        if (expired (Clock::now ())) {
            res.status = 410;
            res.set_content (callback_page (TIMED_OUT), "text/html");
            return;
        }
        if (!claim ()) {
            res.status = 409;
            res.set_content (callback_page ("Authorization already handled"), "text/html");
            return;
        }
        const CallbackOutcome outcome = resolve_oauth_callback (
        db, config, code_verifier, redirect_uri, params, &stop_signal.flag ());
        publish (outcome.result_state, outcome.error, outcome.cache_key);
        res.set_content (callback_page (outcome.heading), "text/html");
    }

    /// Where the IdP sends this attempt's browser: @p start_config's
    /// `callbackUrl` in embedded mode, else a one-shot 127.0.0.1 listener on
    /// an ephemeral port.
    std::expected<void, StartRefusal> bind_redirect (vayu::db::Database& db,
    const std::string& attempt_id,
    const std::string& mode,
    const nlohmann::json& start_config) {
        if (mode == "embedded") {
            redirect_uri = oauth::url_field (start_config, "callbackUrl");
            if (redirect_uri.empty ()) {
                return std::unexpected (StartRefusal{ 400, "oauth2_invalid_config",
                "callbackUrl is required for embedded mode" });
            }
            return {};
        }
        listener.server ().Get ("/callback",
        [this, &db, attempt_id] (const httplib::Request& req,
        httplib::Response& res) { answer_callback (db, attempt_id, req, res); });
        // Ephemeral only, so the port guard never refuses this one; the label
        // is what another listener asking for this port would be told.
        const int port =
        listener.start ("127.0.0.1", 0, "OAuth callback " + attempt_id).port;
        if (port <= 0) {
            return std::unexpected (StartRefusal{ 500, "oauth2_loopback_failed",
            "Couldn't bind a local callback port" });
        }
        redirect_uri = "http://127.0.0.1:" + std::to_string (port) + "/callback";
        return {};
    }

    /// Requested when the attempt's listener stops, before it is joined. The
    /// callback's token exchange is cancelled by it, and still publishes its
    /// failure, so the join waits one libcurl progress tick rather than the
    /// exchange's timeout.
    vayu::utils::StopSignal stop_signal;

    /// Loopback mode only - an embedded-mode attempt never starts it, and
    /// stopping an unstarted listener is a no-op. Declared last so it is
    /// destroyed first: the callback handler reads every field above it.
    ManagedListener listener;
};

OAuth2AuthorizeManager::OAuth2AuthorizeManager (AuthorizeTimings timings,
AuthorizationServerMetadataCache& discovery_cache)
: timings_ (timings), discovery_cache_ (discovery_cache),
  attempts_ (limits::MAX_ATTEMPTS) {
    reaper_ = std::thread ([this] { run_reaper (); });
}

OAuth2AuthorizeManager::~OAuth2AuthorizeManager () {
    try {
        shutdown ();
    } catch (const std::exception& e) {
        log_unrecoverable ("OAuth2 authorize manager shutdown failed", e.what ());
    } catch (...) {
        log_unrecoverable ("OAuth2 authorize manager shutdown failed", "unknown exception");
    }
}

void OAuth2AuthorizeManager::shutdown () {
    // The reaper first: it moves attempts out of the registry, and one it
    // holds while the registry drains would be retired by neither.
    reaper_stop_.request ();
    if (reaper_.joinable ()) {
        reaper_.join ();
    }
    attempts_.shutdown ();
    std::lock_guard<std::mutex> lock (settled_mutex_);
    settled_.clear ();
}

void OAuth2AuthorizeManager::run_reaper () {
    while (!reaper_stop_.wait_for (timings_.reap_interval)) {
        try {
            reap ();
        } catch (const std::exception& e) {
            log_unrecoverable ("OAuth2 authorize reaper tick failed", e.what ());
        } catch (...) {
            log_unrecoverable ("OAuth2 authorize reaper tick failed", "unknown exception");
        }
    }
}

// Fails each pending attempt past its deadline, moves every settled attempt's
// result aside and retires its listener outside the registry's lock, then drops
// results past their retention. A claimed attempt still exchanging is left for
// its claim winner to publish.
void OAuth2AuthorizeManager::reap () {
    const auto now = Clock::now ();
    std::vector<std::unique_ptr<Attempt>> retiring;
    attempts_.with_entries ([&] (Attempts::Entries& attempts) {
        for (auto it = attempts.begin (); it != attempts.end ();) {
            Attempt& attempt = *it->second;
            if (attempt.expired (now) && attempt.claim ()) {
                attempt.publish (AttemptState::Failed, TIMED_OUT, {});
                vayu::utils::log_info (
                "oauth", "OAuth2 authorize timed out: " + it->first);
            }
            if (!is_settled (attempt.result_state.load ())) {
                ++it;
                continue;
            }
            {
                // Recorded before the erase, under the registry's lock, so a
                // reader that misses the attempt there finds it here.
                std::lock_guard<std::mutex> lock (settled_mutex_);
                settled_.insert_or_assign (it->first,
                SettledRecord{ attempt.observed (now), attempt.erase_at });
            }
            retiring.push_back (std::move (it->second));
            it = attempts.erase (it);
        }
    });
    for (const auto& attempt : retiring) {
        retire_listener (*attempt);
    }

    std::lock_guard<std::mutex> lock (settled_mutex_);
    std::erase_if (settled_,
    [now] (const auto& entry) { return now >= entry.second.erase_at; });
}

AuthorizeStatus OAuth2AuthorizeManager::settled_status (const std::string& attempt_id) const {
    std::lock_guard<std::mutex> lock (settled_mutex_);
    const auto it = settled_.find (attempt_id);
    return it == settled_.end () ? AuthorizeStatus{ "not_found", "", "" } :
                                   it->second.status;
}

AuthorizeStart OAuth2AuthorizeManager::start (vayu::db::Database& db,
const nlohmann::json& config,
const std::string& mode,
const std::atomic<bool>* cancel) {
    AuthorizeStart out;

    auto plan = plan_attempt (db, config, discovery_cache_, cancel);
    if (!plan) {
        fail_start (plan.error (), out);
        return out;
    }
    if (auto complete = require_complete (*plan); !complete) {
        fail_start (complete.error (), out);
        return out;
    }

    auto slot = attempts_.reserve ();
    if (!slot) {
        refuse_start (slot.error (), out);
        return out;
    }

    auto attempt             = std::make_unique<Attempt> ();
    const auto now           = Clock::now ();
    attempt->deadline        = now + timings_.attempt_ttl;
    attempt->erase_at        = now + timings_.record_retention;
    const int64_t expires_at = now_ms () + timings_.attempt_ttl.count ();
    attempt->pkce            = [&] {
        auto it = plan->config.find ("pkce");
        return it == plan->config.end () || !it->is_boolean () || it->get<bool> ();
    }();
    attempt->state = pkce::random_token (16);
    attempt->code_verifier = attempt->pkce ? pkce::random_token (32) : std::string{};
    const std::string challenge =
    attempt->pkce ? pkce::code_challenge (attempt->code_verifier) : std::string{};

    const std::string attempt_id = generate_attempt_id ();

    if (auto bound = attempt->bind_redirect (db, attempt_id, mode, plan->config); !bound) {
        fail_start (bound.error (), out);
        return out;
    }
    // A registration needs the redirect it registers, so it runs once that is
    // bound. The config is written after the listener starts, which is safe
    // because its callback reads nothing but `state` until a request carries
    // that state, and no one has it until this returns.
    if (auto registered = register_client (db, *plan, attempt->redirect_uri, cancel);
    !registered) {
        fail_start (registered.error (), out);
        return out;
    }
    attempt->config = std::move (plan->config);

    out.attempt_id    = attempt_id;
    out.redirect_uri  = attempt->redirect_uri;
    out.expires_at    = expires_at;
    out.authorize_url = build_authorize_url (attempt->config, attempt->state,
    challenge, attempt->redirect_uri, attempt->pkce);
    if (!plan->issuer.empty ()) {
        out.resolved = resolved_authorization (attempt->config, plan->issuer);
    }

    if (!attempts_.commit (std::move (*slot), attempt_id, std::move (attempt))) {
        out = AuthorizeStart{};
        refuse_shut_down (out);
        return out;
    }
    vayu::utils::log_info ("oauth", "OAuth2 authorize started (" + mode + "): " + attempt_id);
    return out;
}

AuthorizeStatus OAuth2AuthorizeManager::complete (vayu::db::Database& db,
const std::string& attempt_id,
const std::string& callback_url) {
    // Snapshot what the exchange needs under the lock, then release it: the token
    // exchange is a network round-trip and must not stall status() polls for
    // other attempts (the manager is shared across all in-flight authorizations).
    std::string state, code_verifier, redirect_uri;
    nlohmann::json config;
    std::shared_ptr<const std::atomic<bool>> cancel;
    const auto now      = Clock::now ();
    const auto answered = attempts_.with_entry (
    attempt_id, [&] (Attempt& attempt) -> std::optional<AuthorizeStatus> {
        // Settled (a duplicate complete), held by a loopback callback, or past
        // its deadline: answered as any reader would see it.
        if (attempt.expired (now) || !attempt.claim ()) {
            return attempt.observed (now);
        }
        state         = attempt.state;
        code_verifier = attempt.code_verifier;
        redirect_uri  = attempt.redirect_uri;
        config        = attempt.config;
        cancel        = attempt.completion_cancel;
        return std::nullopt;
    });
    if (!answered) {
        return settled_status (attempt_id);
    }
    if (*answered) {
        return **answered;
    }

    const auto qpos = callback_url.find ('?');
    const auto params =
    parse_query (qpos == std::string::npos ? "" : callback_url.substr (qpos + 1));

    // An IdP refusal reads the same with or without its state; anything else
    // is read only with the attempt's own.
    CallbackOutcome outcome;
    if (redirect_refusal (params) || callback_state_matches (params, state)) {
        outcome = resolve_oauth_callback (
        db, config, code_verifier, redirect_uri, params, cancel.get ());
    } else {
        outcome.error = "State mismatch (possible CSRF)";
    }

    // Re-acquire the lock to store the outcome; the attempt may have been
    // cancelled while the exchange was in flight.
    return attempts_
    .with_entry (attempt_id,
    [&] (Attempt& attempt) {
        attempt.publish (outcome.result_state, outcome.error, outcome.cache_key);
        return attempt.observed (now);
    })
    .value_or (AuthorizeStatus{ "not_found", "", "" });
}

AuthorizeStatus OAuth2AuthorizeManager::status (const std::string& attempt_id) {
    const auto now = Clock::now ();
    if (auto live = attempts_.with_entry (attempt_id,
        [now] (const Attempt& attempt) { return attempt.observed (now); })) {
        return *live;
    }
    return settled_status (attempt_id);
}

void OAuth2AuthorizeManager::cancel (const std::string& attempt_id) {
    attempts_.remove (attempt_id);
    std::lock_guard<std::mutex> lock (settled_mutex_);
    settled_.erase (attempt_id);
}

} // namespace vayu::http
