/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/file_grants_route_test.cpp
 * @brief `/file-grants`, and the grant secret that gates it and the
 *        `/file-roots` writes (#2356).
 *
 * Driven through a real `Server` on a free port, because the gate is wiring:
 * a route core never sees a header, and what has to hold is that the handler
 * refuses before it parses the body. The secret's own rules (length, constant
 * comparison, the environment it is taken from) are asserted directly below.
 */

#include <gtest/gtest.h>
#include <httplib.h>

#include <atomic>
#include <filesystem>
#include <fstream>
#include <memory>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "optional_assert.hpp"
#include "scoped_env.hpp"
#include "temp_database.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/http/grant_secret.hpp"
#include "vayu/http/server.hpp"
#include "vayu/types.hpp"

namespace vayu::http {
namespace {

namespace fs = std::filesystem;
using nlohmann::json;

/// 64 characters, the shape the app sends: 32 random bytes as hex.
constexpr const char* SECRET =
"9f2c4e6a8b0d1f3e5c7a9b1d3f5e7c9a0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d0f";

/// A port nothing is listening on: `Server` takes its port up front.
int free_port () {
    httplib::Server probe;
    const int port = probe.bind_to_any_port ("127.0.0.1");
    std::thread runner ([&probe] () { probe.listen_after_bind (); });
    probe.wait_until_ready ();
    probe.stop ();
    runner.join ();
    return port;
}

/// The `code` of the engine's one error shape, or "" when the body is not it.
std::string error_code_of (const std::string& body) {
    const auto parsed = json::parse (body, nullptr, false);
    if (!parsed.is_object () || !parsed.contains ("error") || !parsed["error"].is_object ()) {
        return {};
    }
    return parsed["error"].value ("code", std::string ());
}

class FileGrantsRouteTest : public ::testing::Test {
    protected:
    static constexpr const char* DB_PATH = "test_file_grants_route.db";

    void SetUp () override {
        vayu::tests::remove_database_files (DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (DB_PATH);
        db_->init ();
        // Under the working directory, which `main` has made private to this
        // process, so concurrent suites cannot remove each other's files.
        static std::atomic<int> counter{ 0 };
        scratch_ = fs::current_path () /
        ("vayu-file-grants-" + std::to_string (counter.fetch_add (1)));
        fs::remove_all (scratch_);
        fs::create_directories (scratch_);
        scratch_ = fs::canonical (scratch_);
    }

    void TearDown () override {
        server_.reset ();
        db_.reset ();
        vayu::tests::remove_database_files (DB_PATH);
        std::error_code ignored;
        fs::remove_all (scratch_, ignored);
    }

    /// Start the engine's own server holding @p secret.
    void start (const GrantSecret& secret) {
        port_   = free_port ();
        server_ = std::make_unique<Server> (*db_, run_manager_, port_, secret);
        ASSERT_TRUE (server_->start ()) << server_->bind_error ();
    }

    [[nodiscard]] httplib::Client client () const {
        return httplib::Client ("127.0.0.1", port_);
    }

    /// The headers a write carries: the secret header with @p value, or no
    /// header at all when @p value is null.
    static httplib::Headers secret_header (const char* value) {
        if (value == nullptr) {
            return {};
        }
        return { { std::string (GRANT_SECRET_HEADER), value } };
    }

    /// POST @p path with body `{path: target}`, every body kept for the
    /// never-echoed check.
    httplib::Result
    post (const std::string& path, const std::string& target, const char* secret) {
        auto result = client ().Post (path, secret_header (secret),
        json{ { "path", target } }.dump (), "application/json");
        keep (result);
        return result;
    }

    httplib::Result del (const std::string& path, const char* secret) {
        auto result = client ().Delete (path, secret_header (secret));
        keep (result);
        return result;
    }

    httplib::Result get (const std::string& path) {
        auto result = client ().Get (path, secret_header (SECRET));
        keep (result);
        return result;
    }

    void keep (const httplib::Result& result) {
        if (result) {
            bodies_.push_back (result->body);
        }
    }

    /// Write @p contents to @p name under the scratch directory.
    [[nodiscard]] std::string write (const std::string& name, const std::string& contents) const {
        const fs::path file = scratch_ / name;
        fs::create_directories (file.parent_path ());
        std::ofstream out (file, std::ios::binary);
        out << contents;
        return file.string ();
    }

    [[nodiscard]] std::string dir (const std::string& name) const {
        const fs::path sub = scratch_ / name;
        fs::create_directories (sub);
        return sub.string ();
    }

    std::unique_ptr<vayu::db::Database> db_;
    vayu::core::RunManager run_manager_;
    std::unique_ptr<Server> server_;
    int port_ = 0;
    fs::path scratch_;
    std::vector<std::string> bodies_;
};

// Mutation check: drop `admit_file_trust_write` from the POST /file-grants
// handler and the first two writes answer 201.
TEST_F (FileGrantsRouteTest, AGrantIsWrittenAndRemovedOnlyWithTheSecret) {
    start (GrantSecret (SECRET));
    const std::string file = write ("picked/a.bin", "a");

    for (const char* wrong : { static_cast<const char*> (nullptr), "", "not-the-secret",
         "9f2c4e6a8b0d1f3e5c7a9b1d3f5e7c9a0b2d4f6e8a1c3e5b7d9f0a2c4e6b8d0e" }) {
        auto refused = post ("/file-grants", file, wrong);
        ASSERT_TRUE (refused);
        EXPECT_EQ (refused->status, 403) << refused->body;
        EXPECT_EQ (error_code_of (refused->body), "grant_secret_required")
        << refused->body;
    }
    EXPECT_TRUE (db_->get_file_grants ().empty ()) << "a refused write wrote";

    auto granted = post ("/file-grants", file, SECRET);
    ASSERT_TRUE (granted);
    ASSERT_EQ (granted->status, 201) << granted->body;
    const json row = json::parse (granted->body);
    EXPECT_EQ (row["path"], fs::canonical (file).string ());
    EXPECT_TRUE (row["createdAt"].is_number_integer ());
    const std::string id = row["id"].get<std::string> ();

    // Mutation check: drop the gate from DELETE /file-grants and these remove
    // the row.
    for (const char* wrong : { static_cast<const char*> (nullptr), "not-the-secret" }) {
        auto refused = del ("/file-grants/" + id, wrong);
        ASSERT_TRUE (refused);
        EXPECT_EQ (refused->status, 403) << refused->body;
    }
    EXPECT_EQ (db_->get_file_grants ().size (), 1u);

    auto removed = del ("/file-grants/" + id, SECRET);
    ASSERT_TRUE (removed);
    EXPECT_EQ (removed->status, 200) << removed->body;
    EXPECT_TRUE (db_->get_file_grants ().empty ());
    auto again = del ("/file-grants/" + id, SECRET);
    ASSERT_TRUE (again);
    EXPECT_EQ (again->status, 404) << again->body;
}

// Without this gate the grant table means nothing: a caller that cannot grant
// a file could allow the folder holding it. Mutation check: drop
// `admit_file_trust_write` from POST /file-roots and the refused write is 201.
TEST_F (FileGrantsRouteTest, AnAllowedFolderIsWrittenAndRemovedOnlyWithTheSecret) {
    start (GrantSecret (SECRET));
    const std::string folder = dir ("fixtures");

    for (const char* wrong : { static_cast<const char*> (nullptr), "not-the-secret" }) {
        auto refused = post ("/file-roots", folder, wrong);
        ASSERT_TRUE (refused);
        EXPECT_EQ (refused->status, 403) << refused->body;
    }
    EXPECT_TRUE (db_->get_file_roots ().empty ());

    auto allowed = post ("/file-roots", folder, SECRET);
    ASSERT_TRUE (allowed);
    ASSERT_EQ (allowed->status, 201) << allowed->body;
    const std::string id = json::parse (allowed->body)["id"].get<std::string> ();

    auto refused = del ("/file-roots/" + id, "not-the-secret");
    ASSERT_TRUE (refused);
    EXPECT_EQ (refused->status, 403) << refused->body;
    EXPECT_EQ (db_->get_file_roots ().size (), 1u);

    auto removed = del ("/file-roots/" + id, SECRET);
    ASSERT_TRUE (removed);
    EXPECT_EQ (removed->status, 200) << removed->body;
    EXPECT_TRUE (db_->get_file_roots ().empty ());
}

// A standalone engine, or one handed a value too short to be a secret: no
// header opens the writes, the value the engine was handed included.
TEST_F (FileGrantsRouteTest, WithNoSecretEveryWriteIsRefused) {
    constexpr const char* too_short = "short-but-not-empty";
    start (GrantSecret (too_short));
    const std::string file   = write ("a.bin", "a");
    const std::string folder = dir ("fixtures");
    db_->save_file_grant (
    vayu::FileGrant{ "fgrant_seed", fs::canonical (file).string (), 1 });
    db_->save_file_root (
    vayu::FileRoot{ "froot_seed", fs::canonical (folder).string (), 1 });

    for (const char* presented : { static_cast<const char*> (nullptr), too_short, SECRET }) {
        std::vector<httplib::Result> results;
        results.push_back (post ("/file-grants", file, presented));
        results.push_back (post ("/file-roots", folder, presented));
        results.push_back (del ("/file-grants/fgrant_seed", presented));
        results.push_back (del ("/file-roots/froot_seed", presented));
        for (const auto& result : results) {
            ASSERT_TRUE (result);
            EXPECT_EQ (result->status, 403) << result->body;
            EXPECT_NE (result->body.find ("started without a grant secret"), std::string::npos)
            << result->body;
        }
    }
    EXPECT_EQ (db_->get_file_grants ().size (), 1u);
    EXPECT_EQ (db_->get_file_roots ().size (), 1u);

    // Reading needs nothing: a GET changes nothing.
    auto listed = client ().Get ("/file-grants");
    ASSERT_TRUE (listed);
    ASSERT_EQ (listed->status, 200) << listed->body;
    const json rows = json::parse (listed->body);
    ASSERT_TRUE (rows.is_array ());
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (rows[0]["id"], "fgrant_seed");
}

TEST_F (FileGrantsRouteTest, APathThatNamesNoPickableFileIsA400) {
    start (GrantSecret (SECRET));
    const std::string file = write ("real.bin", "x");
    const std::vector<std::pair<std::string, std::string>> cases = {
        { "relative/real.bin", "is not an absolute path" },
        { (scratch_ / "missing.bin").string (), "is not an existing regular file" },
        { dir ("folder"), "is not an existing regular file" },
        { (scratch_ / "{{name}}.bin").string (), "holds a {{variable}}" },
        { "", "Missing 'path'" },
    };
    for (const auto& [path, says] : cases) {
        auto refused = post ("/file-grants", path, SECRET);
        ASSERT_TRUE (refused);
        EXPECT_EQ (refused->status, 400) << path << " " << refused->body;
        EXPECT_NE (refused->body.find (says), std::string::npos) << refused->body;
    }
    auto with_id = client ().Post ("/file-grants", secret_header (SECRET),
    json{ { "id", "mine" }, { "path", file } }.dump (), "application/json");
    ASSERT_TRUE (with_id);
    EXPECT_EQ (with_id->status, 400) << with_id->body;
    EXPECT_TRUE (db_->get_file_grants ().empty ());
}

// Mutation check: drop the duplicate scan in `create_file_grant_response` and
// the second spelling answers 201, replacing the first row under a new id.
TEST_F (FileGrantsRouteTest, ASecondSpellingOfAGrantedFileIsA409) {
    start (GrantSecret (SECRET));
    const std::string file = write ("picked/a.bin", "a");
    auto first             = post ("/file-grants", file, SECRET);
    ASSERT_TRUE (first);
    ASSERT_EQ (first->status, 201) << first->body;
    const std::string id = json::parse (first->body)["id"].get<std::string> ();

    auto second = post ("/file-grants",
    (scratch_ / "picked" / ".." / "picked" / "a.bin").string (), SECRET);
    ASSERT_TRUE (second);
    EXPECT_EQ (second->status, 409) << second->body;
    EXPECT_NE (second->body.find (id), std::string::npos) << second->body;
    const auto rows = db_->get_file_grants ();
    ASSERT_EQ (rows.size (), 1u);
    EXPECT_EQ (rows[0].id, id);
}

// What the route records is what a send reads. Mutation check: make
// `FileAccessPolicy::allows` ignore its grants and the granted file is still
// refused.
TEST_F (FileGrantsRouteTest, AFileGrantedThroughTheRouteIsSendable) {
    start (GrantSecret (SECRET));
    const std::string file = write ("elsewhere/body.bin", "payload");
    Request request;
    request.method        = HttpMethod::POST;
    request.url           = "http://127.0.0.1:1/";
    request.body.mode     = BodyMode::Binary;
    request.body.file.src = file;

    {
        Request before = request;
        FilePlan plan (FileAccessPolicy::from_database (*db_));
        const auto refusal = plan.prepare (before);
        ASSERT_HAS_VALUE (refusal) << "sent before any grant";
        EXPECT_NE (refusal->find ("was not picked on this machine"), std::string::npos)
        << *refusal;
    }

    auto granted = post ("/file-grants", file, SECRET);
    ASSERT_TRUE (granted);
    ASSERT_EQ (granted->status, 201) << granted->body;

    FilePlan plan (FileAccessPolicy::from_database (*db_));
    const auto refusal = plan.prepare (request);
    EXPECT_FALSE (refusal) << refusal.value_or ("");
    ASSERT_NE (request.body.file.inline_bytes, nullptr);
    EXPECT_EQ (*request.body.file.inline_bytes, "payload");
}

// The secret is the one thing the app holds that a caller of the API does
// not; no answer may hand it over, a refusal included.
TEST_F (FileGrantsRouteTest, NoResponseBodyCarriesTheSecret) {
    start (GrantSecret (SECRET));
    const std::string file   = write ("a.bin", "a");
    const std::string folder = dir ("fixtures");
    post ("/file-grants", file, nullptr);
    post ("/file-grants", file, "not-the-secret");
    post ("/file-grants", file, SECRET);
    post ("/file-grants", file, SECRET);
    post ("/file-grants", "relative", SECRET);
    post ("/file-roots", folder, SECRET);
    post ("/file-roots", folder, SECRET);
    del ("/file-grants/nope", SECRET);
    del ("/file-roots/nope", nullptr);
    get ("/file-grants");
    get ("/file-roots");
    get ("/health");
    get ("/config");

    ASSERT_EQ (bodies_.size (), 13u) << "an exchange failed";
    for (const auto& body : bodies_) {
        EXPECT_FALSE (body.empty ());
        EXPECT_EQ (body.find (SECRET), std::string::npos) << body;
    }
}

// ===========================================================================
// The secret itself
// ===========================================================================

TEST (GrantSecret, AdmitsExactlyTheSecretAndNothingWhenUnset) {
    const GrantSecret secret (SECRET);
    ASSERT_TRUE (secret.configured ());
    EXPECT_TRUE (secret.admits (SECRET));
    const std::string longer = std::string (SECRET) + "0";
    for (const std::string& other : { std::string (),
         std::string (SECRET).substr (1), longer, std::string (64, '0') }) {
        EXPECT_FALSE (secret.admits (other)) << other;
    }

    const GrantSecret none;
    EXPECT_FALSE (none.configured ());
    EXPECT_FALSE (none.admits (""));
    EXPECT_FALSE (none.admits (SECRET));
}

// Mutation check: lower `GRANT_SECRET_MIN_LENGTH` to 0 and the short value
// is taken as a secret.
TEST (GrantSecret, AValueShorterThanTheMinimumIsNoSecret) {
    const std::string at_minimum (GRANT_SECRET_MIN_LENGTH, 'a');
    EXPECT_TRUE (GrantSecret (at_minimum).configured ());
    const std::string below = at_minimum.substr (1);
    const GrantSecret short_one (below);
    EXPECT_FALSE (short_one.configured ());
    EXPECT_FALSE (short_one.admits (below));
}

// Mutation check: drop `remove_from_environment` and the variable is still
// readable after the take.
TEST (GrantSecret, IsTakenFromTheEnvironmentAndRemovedFromIt) {
    const vayu::tests::ScopedEnv pinned (GRANT_SECRET_ENV, SECRET);
    const GrantSecret secret = take_grant_secret_from_environment ();
    EXPECT_TRUE (secret.configured ());
    EXPECT_TRUE (secret.admits (SECRET));
    EXPECT_FALSE (vayu::tests::ScopedEnv::read (GRANT_SECRET_ENV))
    << "still in the environment";
}

TEST (GrantSecret, AShortOrMissingVariableIsNoSecretAndIsRemovedToo) {
    {
        const vayu::tests::ScopedEnv pinned (GRANT_SECRET_ENV, "too-short");
        EXPECT_FALSE (take_grant_secret_from_environment ().configured ());
        EXPECT_FALSE (vayu::tests::ScopedEnv::read (GRANT_SECRET_ENV));
    }
    ASSERT_FALSE (vayu::tests::ScopedEnv::read (GRANT_SECRET_ENV));
    EXPECT_FALSE (take_grant_secret_from_environment ().configured ());
}

} // namespace
} // namespace vayu::http
