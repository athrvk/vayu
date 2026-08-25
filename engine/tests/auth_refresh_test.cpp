/**
 * @file auth_refresh_test.cpp
 * @brief Mid-run OAuth 2.0 refresh (#478): a load run that outlives its token
 *        keeps sending a valid one, and says so in its summary.
 *
 * The engine used to resolve auth exactly once per run, so a run longer than
 * its token turned into a 401 storm nothing explained. Three layers are covered
 * here: which runs are eligible at all (plan_auth_refresh), the swap the
 * submitting thread performs (sync_auth_header), and a whole run against a mock
 * IdP that expires tokens in seconds.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <chrono>
#include <memory>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "temp_database.hpp"
#include "vayu/core/auth_refresh.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/mock_issuer.hpp"
#include "vayu/http/oauth_client.hpp"

using nlohmann::json;
using vayu::core::auth_refresh_delay_ms;
using vayu::core::AuthRefreshState;
using vayu::core::sync_auth_header;

namespace {

using Clock = std::chrono::steady_clock;

int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

/**
 * The target of the run: `/api` records every distinct `Authorization` value it
 * is sent, in the order they first appeared. That ordering is the assertion -
 * the run must move from the first token to the second while it is still going,
 * not merely end up on the second.
 *
 * The identity provider it used to carry alongside is now `MockIssuerManager`
 * (#479), the engine's own mock issuer, so there is one mock IdP in the tree
 * rather than a copy here that never receives its fixes.
 */
class MockTarget {
    public:
    MockTarget () {
        svr_.new_task_queue = [] { return new httplib::ThreadPool (16); };

        svr_.Get ("/api", [this] (const httplib::Request& req, httplib::Response& res) {
            const std::string auth = req.get_header_value ("Authorization");
            {
                const std::lock_guard<std::mutex> lock (mutex_);
                if (seen_.empty () || seen_.back () != auth) {
                    seen_.push_back (auth);
                }
            }
            res.set_content ("{}", "application/json");
        });

        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }

    ~MockTarget () {
        svr_.stop ();
        if (thread_.joinable ())
            thread_.join ();
    }

    MockTarget (const MockTarget&)            = delete;
    MockTarget& operator= (const MockTarget&) = delete;

    std::string api_url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/api";
    }

    /// Every Authorization value the target saw, de-duplicated consecutively.
    std::vector<std::string> credentials_seen () const {
        const std::lock_guard<std::mutex> lock (mutex_);
        return seen_;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    mutable std::mutex mutex_;
    std::vector<std::string> seen_;
};

json oauth2_config (const std::string& token_url) {
    return json{ { "grantType", "client_credentials" }, { "accessTokenUrl", token_url },
        { "clientId", "cid" }, { "clientSecret", "secret" } };
}

vayu::http::AuthRefreshPlan plan_for (std::string value, int64_t expires_at_ms) {
    vayu::http::AuthRefreshPlan plan;
    plan.config        = json::object ();
    plan.header_name   = "Authorization";
    plan.header_value  = std::move (value);
    plan.expires_at_ms = expires_at_ms;
    return plan;
}

} // namespace

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

TEST (AuthRefreshDelay, RefreshesTheConfiguredLeadBeforeExpiry) {
    vayu::core::AuthRefreshTuning tuning;
    tuning.lead_ms = 60'000;
    // 1000s of life left, refreshing 60s early -> sleep 940s.
    EXPECT_EQ (auth_refresh_delay_ms (1'000'000, 0, tuning), 940'000);
}

// A token whose whole lifetime is shorter than the lead is *always* inside its
// refresh window. Without the floor the watchdog would re-acquire in a tight
// loop and hammer the token endpoint on the run's behalf.
TEST (AuthRefreshDelay, FloorsTheWaitForATokenShorterThanTheLead) {
    vayu::core::AuthRefreshTuning tuning;
    tuning.lead_ms         = 60'000;
    tuning.min_interval_ms = 1'500;

    EXPECT_EQ (auth_refresh_delay_ms (2'000, 0, tuning), 1'500);
    // Already expired: same floor, not a negative sleep.
    EXPECT_EQ (auth_refresh_delay_ms (1'000, 5'000, tuning), 1'500);
}

// The floor is the user's setting, not a constant baked into the schedule -
// mutation check for reading `min_interval_ms` rather than the default.
TEST (AuthRefreshDelay, TheFloorFollowsTheConfiguredMinimumInterval) {
    vayu::core::AuthRefreshTuning tuning;
    tuning.lead_ms         = 60'000;
    tuning.min_interval_ms = 250;

    EXPECT_EQ (auth_refresh_delay_ms (2'000, 0, tuning), 250);
}

// ---------------------------------------------------------------------------
// The swap the submitting thread performs
// ---------------------------------------------------------------------------

TEST (SyncAuthHeader, LeavesARunWithoutRefreshUntouched) {
    vayu::Request request;
    request.headers["Authorization"] = "Bearer ORIGINAL";
    uint64_t seen                    = 0;

    sync_auth_header (nullptr, request, seen);

    EXPECT_EQ (request.headers["Authorization"], "Bearer ORIGINAL");
    EXPECT_EQ (seen, 0u);
}

TEST (SyncAuthHeader, CopiesAPublishedCredentialOnceAndThenStopsWorking) {
    auto state = std::make_shared<AuthRefreshState> (plan_for ("Bearer AT1", 1000));
    vayu::Request request;
    request.headers["Authorization"] = "Bearer AT1";
    uint64_t seen                    = 0;

    // Nothing published yet: the request already carries the first credential.
    sync_auth_header (state, request, seen);
    EXPECT_EQ (request.headers["Authorization"], "Bearer AT1");

    state->publish ("Bearer AT2", 12.5, 2000);
    sync_auth_header (state, request, seen);
    EXPECT_EQ (request.headers["Authorization"], "Bearer AT2");
    EXPECT_EQ (seen, state->generation ());

    // A second call with no new publish must not re-read the cell - the header
    // is already current, and this is the per-request hot path.
    request.headers["Authorization"] = "Bearer SENTINEL";
    sync_auth_header (state, request, seen);
    EXPECT_EQ (request.headers["Authorization"], "Bearer SENTINEL");
}

TEST (AuthRefreshState, SummaryCarriesEveryRefreshAndTheLastFailure) {
    auto state = std::make_shared<AuthRefreshState> (plan_for ("Bearer AT1", 1000));

    EXPECT_EQ (state->summary ()["refreshes"].size (), 0u);
    EXPECT_EQ (state->summary ()["refreshFailures"], 0u);
    EXPECT_FALSE (state->summary ().contains ("lastError"));

    state->publish ("Bearer AT2", 60.5, 2000);
    state->record_failure ("oauth2_provider_error: nope");

    const auto summary = state->summary ();
    ASSERT_EQ (summary["refreshes"].size (), 1u);
    EXPECT_DOUBLE_EQ (summary["refreshes"][0]["atSeconds"].get<double> (), 60.5);
    EXPECT_EQ (summary["refreshFailures"], 1u);
    EXPECT_EQ (summary["lastError"], "oauth2_provider_error: nope");
    EXPECT_EQ (state->expires_at_ms (), 2000);
}

// ---------------------------------------------------------------------------
// The settings behind the schedule
// ---------------------------------------------------------------------------

class AuthRefreshTuningTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_auth_refresh_tuning.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    std::unique_ptr<vayu::db::Database> db;
};

// Every knob the watchdog reads is a seeded setting, so the Settings UI - which
// renders engine entries dynamically from GET /config - offers all five rather
// than leaving them hardcoded.
TEST_F (AuthRefreshTuningTest, EveryKnobIsSeededAsAUserSetting) {
    for (const char* key : { "oauth2RefreshLeadMs", "oauth2RefreshMinIntervalMs",
         "oauth2RefreshRetryMs", "oauth2RefreshRetryMaxMs", "oauth2RefreshPollIntervalMs" }) {
        const auto entry = db->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key << " is not offered in Settings";
        EXPECT_EQ (entry->type, "integer") << key;
        EXPECT_FALSE (entry->label.empty ()) << key;
        EXPECT_FALSE (entry->description.empty ()) << key;
        // A range is what stops a hand-typed 0 from turning the retry loop into
        // a hot loop against the token endpoint.
        EXPECT_TRUE (entry->min_value.has_value ()) << key;
        EXPECT_TRUE (entry->max_value.has_value ()) << key;
    }

    // Seeded defaults are the constants, not a second set of numbers.
    const auto tuning = vayu::core::read_auth_refresh_tuning (*db);
    EXPECT_EQ (tuning.lead_ms, vayu::core::constants::server::OAUTH2_REFRESH_LEAD_MS);
    EXPECT_EQ (tuning.min_interval_ms,
    vayu::core::constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS);
    EXPECT_EQ (tuning.retry_ms, vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MS);
    EXPECT_EQ (tuning.retry_max_ms, vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MAX_MS);
    EXPECT_EQ (tuning.poll_interval_ms,
    vayu::core::constants::server::OAUTH2_REFRESH_POLL_INTERVAL_MS);
}

// Mutation check for the reader: revert any one key to its constant and the
// value the user stored stops reaching the run.
TEST_F (AuthRefreshTuningTest, TheStoredValuesAreWhatARunReads) {
    const std::pair<const char*, int> edits[] = { { "oauth2RefreshLeadMs", 12'345 },
        { "oauth2RefreshMinIntervalMs", 321 }, { "oauth2RefreshRetryMs", 777 },
        { "oauth2RefreshRetryMaxMs", 99'000 }, { "oauth2RefreshPollIntervalMs", 42 } };
    for (const auto& [key, value] : edits) {
        auto entry = db->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        entry->value = std::to_string (value);
        db->save_config_entry (*entry);
    }

    const auto tuning = vayu::core::read_auth_refresh_tuning (*db);
    EXPECT_EQ (tuning.lead_ms, 12'345);
    EXPECT_EQ (tuning.min_interval_ms, 321);
    EXPECT_EQ (tuning.retry_ms, 777);
    EXPECT_EQ (tuning.retry_max_ms, 99'000);
    EXPECT_EQ (tuning.poll_interval_ms, 42);
}

// A hand-edited row is the only way a non-positive value reaches the reader
// (POST /config rejects one against the seeded minimum), and a zero floor would
// make the schedule a tight loop against the token endpoint.
TEST_F (AuthRefreshTuningTest, ANonPositiveStoredValueFallsBackToTheDefault) {
    for (const char* key : { "oauth2RefreshLeadMs", "oauth2RefreshMinIntervalMs",
         "oauth2RefreshRetryMs", "oauth2RefreshRetryMaxMs", "oauth2RefreshPollIntervalMs" }) {
        auto entry = db->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key;
        entry->value = "0";
        db->save_config_entry (*entry);
    }

    const auto tuning = vayu::core::read_auth_refresh_tuning (*db);
    EXPECT_EQ (tuning.lead_ms, vayu::core::constants::server::OAUTH2_REFRESH_LEAD_MS);
    EXPECT_EQ (tuning.min_interval_ms,
    vayu::core::constants::server::OAUTH2_REFRESH_MIN_INTERVAL_MS);
    EXPECT_EQ (tuning.retry_ms, vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MS);
    EXPECT_EQ (tuning.retry_max_ms, vayu::core::constants::server::OAUTH2_REFRESH_RETRY_MAX_MS);
    EXPECT_EQ (tuning.poll_interval_ms,
    vayu::core::constants::server::OAUTH2_REFRESH_POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Which runs are eligible at all
// ---------------------------------------------------------------------------

class PlanAuthRefreshTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_auth_refresh_plan.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
    }

    /// Seed the token cache exactly as a resolved run would have left it.
    void cache_token (const json& config,
    const std::string& access_token,
    int64_t expires_in,
    const std::string& refresh_token = "RT1") {
        vayu::db::OAuthToken token;
        token.cache_key     = vayu::http::oauth::cache_key (config);
        token.access_token  = access_token;
        token.token_type    = "Bearer";
        token.refresh_token = refresh_token;
        token.expires_in    = expires_in;
        token.created_at    = now_ms ();
        db->save_oauth_token (token);
    }

    static vayu::Request request_with (const std::string& authorization) {
        vayu::Request request;
        request.url = "https://example.test/api";
        if (!authorization.empty ()) {
            request.headers["Authorization"] = authorization;
        }
        return request;
    }

    std::unique_ptr<vayu::db::Database> db;
};

TEST_F (PlanAuthRefreshTest, PlansForAHeaderPlacedExpiringToken) {
    const json config = oauth2_config ("https://idp.test/token");
    cache_token (config, "AT1", 3600);
    const json auth = { { "mode", "oauth2" }, { "config", config } };

    const auto plan =
    vayu::http::plan_auth_refresh (request_with ("Bearer AT1"), auth, db.get ());

    ASSERT_HAS_VALUE (plan);
    EXPECT_EQ (plan->header_name, "Authorization");
    EXPECT_EQ (plan->header_value, "Bearer AT1");
    EXPECT_GT (plan->expires_at_ms, now_ms ());
    EXPECT_EQ (plan->config["clientId"], "cid");
}

TEST_F (PlanAuthRefreshTest, HonoursACustomHeaderPrefix) {
    json config            = oauth2_config ("https://idp.test/token");
    config["headerPrefix"] = "Token";
    cache_token (config, "AT1", 3600);
    const json auth = { { "mode", "oauth2" }, { "config", config } };

    const auto plan =
    vayu::http::plan_auth_refresh (request_with ("Token AT1"), auth, db.get ());

    ASSERT_HAS_VALUE (plan);
    EXPECT_EQ (plan->header_value, "Token AT1");
}

// Everything below is a run that keeps exactly the behaviour it had before
// mid-run refresh existed: no plan, so no thread, no swap, no report section.
TEST_F (PlanAuthRefreshTest, InertForEveryUnrefreshableShape) {
    const json base = oauth2_config ("https://idp.test/token");

    {
        // Not oauth2 at all.
        const json auth = { { "mode", "bearer" }, { "token", "static" } };
        EXPECT_FALSE (vayu::http::plan_auth_refresh (
        request_with ("Bearer static"), auth, db.get ())
        .has_value ());
    }
    {
        // A token with no expiry cannot outlive anything.
        json config        = base;
        config["clientId"] = "no-expiry";
        cache_token (config, "AT1", 0);
        const json auth = { { "mode", "oauth2" }, { "config", config } };
        EXPECT_FALSE (
        vayu::http::plan_auth_refresh (request_with ("Bearer AT1"), auth, db.get ())
        .has_value ());
    }
    {
        // Nothing cached: this run never resolved a token to keep current.
        json config        = base;
        config["clientId"] = "uncached";
        const json auth    = { { "mode", "oauth2" }, { "config", config } };
        EXPECT_FALSE (
        vayu::http::plan_auth_refresh (request_with ("Bearer AT1"), auth, db.get ())
        .has_value ());
    }
    {
        // The user's explicit opt-out.
        json config                = base;
        config["clientId"]         = "no-auto-refresh";
        config["autoRefreshToken"] = false;
        cache_token (config, "AT1", 3600);
        const json auth = { { "mode", "oauth2" }, { "config", config } };
        EXPECT_FALSE (
        vayu::http::plan_auth_refresh (request_with ("Bearer AT1"), auth, db.get ())
        .has_value ());
    }
    {
        // Query placement: the credential is in the URL every transfer copies,
        // which no header swap can reach.
        json config              = base;
        config["clientId"]       = "query-placed";
        config["tokenPlacement"] = "query";
        cache_token (config, "AT1", 3600);
        const json auth = { { "mode", "oauth2" }, { "config", config } };
        EXPECT_FALSE (
        vayu::http::plan_auth_refresh (request_with (""), auth, db.get ()).has_value ());
    }
    {
        // authorization_code with no refresh token needs a browser, and a run
        // must never pop interactive auth mid-flight.
        json config         = base;
        config["clientId"]  = "interactive";
        config["grantType"] = "authorization_code";
        cache_token (config, "AT1", 3600, /*refresh_token=*/"");
        const json auth = { { "mode", "oauth2" }, { "config", config } };
        EXPECT_FALSE (
        vayu::http::plan_auth_refresh (request_with ("Bearer AT1"), auth, db.get ())
        .has_value ());
    }
    {
        // A user-supplied Authorization header won over the token, so the run
        // is not sending the token at all.
        json config        = base;
        config["clientId"] = "user-header";
        cache_token (config, "AT1", 3600);
        const json auth = { { "mode", "oauth2" }, { "config", config } };
        EXPECT_FALSE (
        vayu::http::plan_auth_refresh (request_with ("Bearer MINE"), auth, db.get ())
        .has_value ());
    }
}

// ---------------------------------------------------------------------------
// A whole run against a mock IdP
// ---------------------------------------------------------------------------

class MidRunRefreshTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_auth_refresh_run.db";
    /// Refresh 1s before expiry, against 3s tokens: the first refresh lands
    /// ~2s in, well inside a run this test can afford to wait out.
    static constexpr int LEAD_MS = 1000;

    void SetUp () override {
        vayu::http::global_init ();
        vayu::tests::remove_database_files (DB_PATH);
        db = std::make_unique<vayu::db::Database> (DB_PATH);
        db->init ();
        set_config ("oauth2RefreshLeadMs", std::to_string (LEAD_MS));
    }
    void TearDown () override {
        db.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        vayu::http::global_cleanup ();
    }

    /// Change a *seeded* setting the way POST /config does: read the row, edit
    /// the value, write it back - so the test drives the same key the Settings
    /// UI offers rather than inventing a row beside it.
    void set_config (const std::string& key, const std::string& value) {
        auto entry = db->get_config_entry (key);
        ASSERT_HAS_VALUE (entry) << key << " is not seeded";
        entry->value = value;
        db->save_config_entry (*entry);
    }

    void create_run_row (const std::string& run_id) {
        vayu::db::Run row;
        row.id              = run_id;
        row.type            = vayu::RunType::Load;
        row.status          = vayu::RunStatus::Pending;
        row.config_snapshot = "{}";
        row.start_time      = now_ms ();
        row.end_time        = 0;
        db->create_run (row);
    }

    /// A 5s run at a gentle rate - long enough to outlive a 3s token, short
    /// enough to stay well inside the suite's per-test budget.
    json run_config (const std::string& url, const json& oauth2) const {
        return json{ { "mode", "constant_rps" }, { "duration", "5s" },
            { "targetRps", 10.0 }, { "url", url }, { "method", "GET" },
            { "timeout", 5000 }, { "workers", 1 },
            { "auth", { { "mode", "oauth2" }, { "config", oauth2 } } } };
    }

    /// Let a run finish on its own. `shutdown` would *stop* it, which is a
    /// different behaviour: the point here is a run that reaches its natural
    /// end having outlived its token.
    void await_completion (const std::string& run_id) {
        const auto deadline = Clock::now () + std::chrono::seconds (30);
        while (Clock::now () < deadline) {
            const auto stored = db->get_run (run_id);
            if (stored && stored->status != vayu::RunStatus::Running &&
            stored->status != vayu::RunStatus::Pending) {
                return;
            }
            std::this_thread::sleep_for (std::chrono::milliseconds (50));
        }
        ADD_FAILURE () << "run " << run_id << " never reached a terminal status";
    }

    /// Run to completion and return the stored summary.
    json execute (const std::string& run_id, const json& config) {
        create_run_row (run_id);
        vayu::core::RunManager manager;
        EXPECT_TRUE (manager.start_run (run_id, config, *db, false));
        await_completion (run_id);
        manager.shutdown (std::chrono::milliseconds (15000));

        const auto stored = db->get_run (run_id);
        EXPECT_TRUE (stored.has_value ());
        if (!stored || stored->summary.empty ()) {
            return json::object ();
        }
        return json::parse (stored->summary, nullptr, false);
    }

    std::unique_ptr<vayu::db::Database> db;
};

// The acceptance criterion: the run keeps sending a valid credential, and the
// report says when it changed. Mutation check - drop the sync_auth_header call
// from the submission path and `credentials_seen` stays at one entry.
TEST_F (MidRunRefreshTest, ARunOutlivingItsTokenSendsARefreshedOne) {
    MockTarget target;
    vayu::http::MockIssuerManager issuers;
    const auto issuer = issuers.start (json{ { "expiresInSeconds", 3 } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const json oauth2 = oauth2_config (issuer.token_url);

    const json summary =
    execute ("run-auth-refresh", run_config (target.api_url (), oauth2));

    const auto seen = target.credentials_seen ();
    ASSERT_GE (seen.size (), 2u)
    << "the run sent one credential for its whole life: " << seen.size ();
    // Each mint carries its own `jti`, so a second distinct value is a second
    // token rather than the same one re-sent.
    EXPECT_EQ (seen[0].rfind ("Bearer ", 0), 0u) << seen[0];
    EXPECT_EQ (seen[1].rfind ("Bearer ", 0), 0u) << seen[1];
    EXPECT_NE (seen[0], seen[1]) << "the run re-sent its first token";

    ASSERT_TRUE (summary.contains ("auth")) << summary.dump ();
    const auto& auth = summary["auth"];
    ASSERT_TRUE (auth["refreshes"].is_array ());
    EXPECT_GE (auth["refreshes"].size (), 1u);
    EXPECT_GT (auth["refreshes"][0]["atSeconds"].get<double> (), 0.0);
    EXPECT_EQ (auth["refreshFailures"], 0u);
    EXPECT_FALSE (auth.contains ("lastError"));
}

// A token endpoint that stops answering must not fail the run: the target's own
// status codes plus this section are the honest report.
TEST_F (MidRunRefreshTest, AFailedRefreshIsRecordedAndTheRunStillCompletes) {
    MockTarget target;
    vayu::http::MockIssuerManager issuers;
    const auto issuer = issuers.start (json{ { "expiresInSeconds", 3 } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    const json oauth2 = oauth2_config (issuer.token_url);

    create_run_row ("run-auth-refresh-fails");
    vayu::core::RunManager manager;
    ASSERT_TRUE (manager.start_run ("run-auth-refresh-fails",
    run_config (target.api_url (), oauth2), *db, false));

    // Only once the run is on the wire has it resolved its first token - auth
    // is resolved on the worker, after start_run has returned. Breaking the
    // endpoint before that would fail the run's *initial* resolution, which is
    // a different behaviour from the one under test.
    const auto context = manager.get_run ("run-auth-refresh-fails");
    ASSERT_NE (context, nullptr);
    const auto deadline = Clock::now () + std::chrono::seconds (10);
    while (context->requests_sent.load () == 0 && Clock::now () < deadline) {
        std::this_thread::sleep_for (std::chrono::milliseconds (10));
    }
    ASSERT_GT (context->requests_sent.load (), 0u)
    << "the run never started sending";
    const auto broken =
    issuers.update (issuer.issuer_id, json{ { "failureMode", "server_error" } });
    ASSERT_TRUE (broken.found && broken.ok) << broken.error;
    await_completion ("run-auth-refresh-fails");
    manager.shutdown (std::chrono::milliseconds (15000));

    const auto stored = db->get_run ("run-auth-refresh-fails");
    ASSERT_HAS_VALUE (stored);
    EXPECT_EQ (stored->status, vayu::RunStatus::Completed)
    << "a refusal to refresh must not fail the run";

    const auto summary = json::parse (stored->summary, nullptr, false);
    ASSERT_TRUE (summary.is_object () && summary.contains ("auth")) << stored->summary;
    EXPECT_EQ (summary["auth"]["refreshes"].size (), 0u);
    EXPECT_GE (summary["auth"]["refreshFailures"].get<size_t> (), 1u);
    EXPECT_NE (summary["auth"]["lastError"].get<std::string> (), "");
}

// A run that cannot refresh spawns no watchdog and reports no section - the
// absent section is what says "this run was never watching".
//
// The inert shape driven here is the user's explicit opt-out, and the token
// still expires mid-run: the opt-out has to hold even when a refresh would
// otherwise have been due. The other inert shapes - an unknown expiry, a
// query-placed token, an uncached one - are pinned directly on
// plan_auth_refresh by InertForEveryUnrefreshableShape, which is where the
// expiry-less one now lives: the engine's mock issuer always states an expiry,
// so no run against it can be missing one.
TEST_F (MidRunRefreshTest, ANonRefreshableRunReportsNoAuthSection) {
    MockTarget target;
    vayu::http::MockIssuerManager issuers;
    const auto issuer = issuers.start (json{ { "expiresInSeconds", 3 } });
    ASSERT_TRUE (issuer.ok) << issuer.error_message;
    json oauth2                = oauth2_config (issuer.token_url);
    oauth2["autoRefreshToken"] = false;

    const json summary =
    execute ("run-auth-inert", run_config (target.api_url (), oauth2));

    EXPECT_FALSE (summary.contains ("auth")) << summary.dump ();
    const auto seen = target.credentials_seen ();
    ASSERT_EQ (seen.size (), 1u);
    EXPECT_EQ (seen[0].rfind ("Bearer ", 0), 0u) << seen[0];
}
