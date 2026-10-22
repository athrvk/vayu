/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/file_body_test.cpp
 * @brief Binary file bodies and the file trust rule (`http/file_ref.hpp`).
 *
 * Three layers, asserted where each one can be seen:
 *
 * 1. **The rule** - `FileAccessPolicy` containment and grants, and
 *    `FilePlan`'s refusals, on real files in a scratch directory: no file
 *    selected, an unresolved variable, a directory or device, a missing file,
 *    and the trust half (a path is sent only from under an allowed folder or
 *    as a picked file, whatever the body says, a symlink escaping a root or
 *    re-pointed after a pick included).
 * 2. **The wire** - both drivers against the in-process echo server: the bytes
 *    arrive identical, the Content-Type follows its four tiers, a small file is
 *    shared from the plan and a large one streams, and a streamed body is
 *    rewound for a redirect (the seek callback).
 * 3. **The callers** - a design send through `execute_exchange`, a load run
 *    through its strategy, every send path reading the stored roots and grants,
 *    the derived `unresolved` the read routes answer, and the `/file-roots`
 *    route cores.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "echo_server.hpp"
#include "optional_assert.hpp"
#include "task_queue.hpp"
#include "temp_database.hpp"
#include "vayu/core/load_strategy.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/scenario_plan.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/cookie_jar.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/event_loop/curl_utils.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/runtime/script_engine.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/sha256.hpp"
#include "wait_until.hpp"

namespace vayu::http::routes {
// Defined in requests.cpp and runs.cpp; each is the testable core of one route.
std::pair<int, nlohmann::json>
create_request_response (vayu::db::Database& db, const nlohmann::json& json);
std::pair<int, nlohmann::json>
get_request_response (vayu::db::Database& db, const std::string& id);
std::string list_requests_body (vayu::db::Database& db, const std::string& collection_id);
std::pair<int, nlohmann::json>
get_run_response (vayu::db::Database& db, const std::string& run_id);
// Defined in file_roots.cpp; each is the testable core of one route.
std::pair<int, nlohmann::json> create_file_root_response (vayu::db::Database& db,
const nlohmann::json& json,
const std::string& home);
nlohmann::json list_file_roots_response (vayu::db::Database& db);
std::pair<int, nlohmann::json>
delete_file_root_response (vayu::db::Database& db, const std::string& id);
} // namespace vayu::http::routes

namespace vayu::http {
namespace {

namespace fs = std::filesystem;
using nlohmann::json;
using vayu::tests::EchoServer;

/// A directory of its own per test, removed with everything in it.
class ScratchDir {
    public:
    // Under the working directory, which `main` has already made private to
    // this process (`enter_process_scratch_dir`): ctest runs each test in its
    // own process at once, and a name under the shared temp directory - the
    // gtest seed is 0 in every one of them - let two tests delete each other's
    // files mid-run.
    ScratchDir () {
        static std::atomic<int> counter{ 0 };
        path_ = fs::current_path () /
        ("vayu-file-body-" + std::to_string (counter.fetch_add (1)));
        fs::remove_all (path_);
        fs::create_directories (path_);
        path_ = fs::canonical (path_);
    }
    ~ScratchDir () {
        std::error_code ignored;
        fs::remove_all (path_, ignored);
    }
    ScratchDir (const ScratchDir&)            = delete;
    ScratchDir& operator= (const ScratchDir&) = delete;
    ScratchDir (ScratchDir&&)                 = delete;
    ScratchDir& operator= (ScratchDir&&)      = delete;

    [[nodiscard]] fs::path path () const {
        return path_;
    }

    /// Write @p contents to @p name (sub-folders created) and answer its path.
    [[nodiscard]] std::string write (const std::string& name, const std::string& contents) const {
        const fs::path file = path_ / name;
        fs::create_directories (file.parent_path ());
        std::ofstream out (file, std::ios::binary);
        out.write (contents.data (), static_cast<std::streamsize> (contents.size ()));
        return file.string ();
    }

    [[nodiscard]] std::string dir (const std::string& name) const {
        const fs::path sub = path_ / name;
        fs::create_directories (sub);
        return sub.string ();
    }

    private:
    fs::path path_;
};

/// Bytes no text body would carry: a NUL, a high byte, a CR-LF.
std::string binary_payload (std::size_t size) {
    std::string out (size, '\0');
    for (std::size_t i = 0; i < size; ++i) {
        out[i] = static_cast<char> (((i * 131) + 7) % 256);
    }
    return out;
}

std::string sha256_hex (std::string_view bytes) {
    const auto digest = vayu::utils::sha256 (bytes);
    return vayu::utils::hex_encode (vayu::utils::byte_view (digest));
}

/// A binary request sending the file at @p src.
Request binary_request (const std::string& url,
const std::string& src,
HttpMethod method = HttpMethod::POST) {
    Request request;
    request.method        = method;
    request.url           = url;
    request.body.mode     = BodyMode::Binary;
    request.body.file.src = src;
    return request;
}

FileRef ref (std::string src) {
    FileRef file;
    file.src = std::move (src);
    return file;
}

/// Everything under @p scratch allowed, so the trust half of the rule stays
/// out of the way of a test about something else.
FileAccessPolicy allowing (const ScratchDir& scratch) {
    return FileAccessPolicy ({ scratch.path ().string () });
}

/// The refusal a path outside every root and every grant gets.
constexpr std::string_view UNTRUSTED =
"was not picked on this machine and is not under an allowed folder";

constexpr std::size_t LARGE = INLINE_FILE_LIMIT + 4096;

// ===========================================================================
// The policy
// ===========================================================================

TEST (FileAccessPolicy, ContainmentIsComponentWiseNotAStringPrefix) {
    EXPECT_TRUE (FileAccessPolicy::contains ("/data/fixtures", "/data/fixtures/a.bin"));
    EXPECT_TRUE (FileAccessPolicy::contains ("/data/fixtures/", "/data/fixtures/x/a.bin"));
    EXPECT_TRUE (FileAccessPolicy::contains ("/data/fixtures", "/data/fixtures"));
    EXPECT_FALSE (FileAccessPolicy::contains ("/data/fixtures", "/data/fixtures-old/a.bin"));
    EXPECT_FALSE (FileAccessPolicy::contains ("/data/fixtures", "/data"));
    EXPECT_TRUE (FileAccessPolicy::contains ("/", "/etc/hosts"));
}

TEST (FileAccessPolicy, AllowsAFileUnderARootAndNothingBesideIt) {
    ScratchDir scratch;
    const std::string inside  = scratch.write ("allowed/a.bin", "a");
    const std::string sibling = scratch.write ("allowed-not/b.bin", "b");
    const FileAccessPolicy policy ({ scratch.dir ("allowed") });

    EXPECT_TRUE (policy.allows (inside));
    EXPECT_FALSE (policy.allows (sibling));
    // `..` is folded before the comparison, not after.
    EXPECT_FALSE (policy.allows (scratch.dir ("allowed") + "/../allowed-not/b.bin"));
    EXPECT_FALSE (policy.allows (scratch.path ().string () + "/allowed/missing.bin"));
    EXPECT_FALSE (FileAccessPolicy{}.allows (inside))
    << "no root allows nothing";
}

// A grant is one file, matched on its canonical form: another spelling of the
// same file is allowed, a sibling or the folder holding it is not. Mutation
// check: drop the grant lookup from `FileAccessPolicy::allows` and the picked
// file is refused.
TEST (FileAccessPolicy, AGrantAllowsExactlyThePickedFile) {
    ScratchDir scratch;
    const std::string picked  = scratch.write ("picked/a.bin", "a");
    const std::string sibling = scratch.write ("picked/b.bin", "b");
    const FileAccessPolicy policy ({}, { fs::canonical (picked).string () });

    EXPECT_TRUE (policy.allows (picked));
    EXPECT_TRUE (policy.allows (scratch.dir ("picked") + "/../picked/a.bin"))
    << "another spelling of the picked file";
    EXPECT_FALSE (policy.allows (sibling));
    EXPECT_FALSE (policy.allows (scratch.dir ("picked")));
}

// The grant holds the target the link resolved to when it was picked, and a
// send resolves the link again: re-pointed, it names another file. Mutation
// check: compare the path as written (or re-resolve the stored grant) in
// `allows` and the re-pointed link is sent.
TEST (FileAccessPolicy, ALinkRepointedAfterThePickIsRefused) {
    ScratchDir scratch;
    const std::string first  = scratch.write ("first.bin", "first");
    const std::string secret = scratch.write ("secret/key.pem", "secret");
    const fs::path link      = scratch.path () / "upload.bin";
    std::error_code ec;
    fs::create_symlink (first, link, ec);
    if (ec) {
        GTEST_SKIP () << "this filesystem cannot create a symlink: " << ec.message ();
    }
    const auto granted = grantable_file_path (link.string ());
    ASSERT_HAS_VALUE (granted);
    EXPECT_EQ (*granted, fs::canonical (first).string ())
    << "the grant is the target";
    const FileAccessPolicy policy ({}, { *granted });
    EXPECT_TRUE (policy.allows (link.string ()));

    fs::remove (link);
    fs::create_symlink (secret, link, ec);
    ASSERT_FALSE (ec) << ec.message ();
    EXPECT_FALSE (policy.allows (link.string ()));
    const auto refusal = unsendable_file_ref (ref (link.string ()), "Body file", policy);
    ASSERT_HAS_VALUE (refusal);
    EXPECT_NE (refusal->find (UNTRUSTED), std::string::npos) << *refusal;
}

// What may be granted: an absolute path to a regular file, holding no `{{`.
// Mutation check: drop the `{{` test from `grantable_file_path` and the file
// literally named with braces is granted.
TEST (FileAccessPolicy, OnlyAConcreteRegularFileIsGrantable) {
    ScratchDir scratch;
    const std::string file = scratch.write ("a.bin", "a");
    EXPECT_EQ (grantable_file_path (file), fs::canonical (file).string ());
    EXPECT_FALSE (grantable_file_path (""));
    EXPECT_FALSE (grantable_file_path ("relative/a.bin"));
    EXPECT_FALSE (grantable_file_path (scratch.dir ("folder")));
    EXPECT_FALSE (grantable_file_path (scratch.path ().string () + "/missing.bin"));
    EXPECT_FALSE (grantable_file_path (scratch.write ("{{name}}.bin", "t")))
    << "a template names no file, even one spelled like it";
}

// A path still holding `{{` is refused as an unresolved variable before any
// grant is consulted, so even a grant for a file literally named that way
// sends nothing.
TEST (FileAccessPolicy, ATemplatedPathIsNeverSentOnAGrant) {
    ScratchDir scratch;
    const std::string braces = scratch.write ("{{name}}.bin", "t");
    const FileAccessPolicy policy ({}, { fs::canonical (braces).string () });
    const auto refusal = unsendable_file_ref (ref (braces), "Body file", policy);
    ASSERT_HAS_VALUE (refusal);
    EXPECT_NE (refusal->find ("unresolved variable"), std::string::npos) << *refusal;
}

// Mutation check: canonicalise with `weakly_canonical` on a lexical path (or
// compare `lexically_normal` spellings) in `allows` and the link reads as
// inside its root.
TEST (FileAccessPolicy, ASymlinkThatEscapesARootIsOutsideIt) {
    ScratchDir scratch;
    const std::string outside = scratch.write ("secret/key.pem", "secret");
    const std::string root    = scratch.dir ("allowed");
    std::error_code ec;
    fs::create_symlink (outside, fs::path (root) / "link.pem", ec);
    if (ec) {
        GTEST_SKIP () << "this filesystem cannot create a symlink: " << ec.message ();
    }
    const FileAccessPolicy policy ({ root });
    EXPECT_FALSE (policy.allows ((fs::path (root) / "link.pem").string ()));
}

TEST (MediaTypes, TheExtensionNamesTheTypeWithoutCase) {
    EXPECT_EQ (media_type_for_extension ("/a/photo.png"), "image/png");
    EXPECT_EQ (media_type_for_extension ("C:\\a\\PHOTO.JPG"), "image/jpeg");
    EXPECT_EQ (media_type_for_extension ("report.pdf"), "application/pdf");
    EXPECT_EQ (media_type_for_extension ("/a/archive.tar.gz"), "application/gzip");
    EXPECT_EQ (media_type_for_extension ("/a/blob.unknownext"), "");
    EXPECT_EQ (media_type_for_extension ("/a/Makefile"), "");
    EXPECT_EQ (media_type_for_extension ("/a.dir/noext"), "")
    << "a dot in a folder is no extension";
}

// ===========================================================================
// The rule
// ===========================================================================

TEST (FileRule, NoFileSelectedAndALeftoverTokenAreRefusedByName) {
    const auto empty = unsendable_file_ref (ref (""), "Body file", {});
    ASSERT_HAS_VALUE (empty);
    EXPECT_NE (empty->find ("Body file has no file selected"), std::string::npos) << *empty;

    const auto token = unsendable_file_ref (ref ("{{fixtures}}/a.bin"), "Body file", {});
    ASSERT_HAS_VALUE (token);
    EXPECT_NE (token->find ("unresolved variable"), std::string::npos) << *token;
    EXPECT_NE (token->find ("{{fixtures}}/a.bin"), std::string::npos) << *token;
}

TEST (FileRule, AMissingFileIsRefusedNamingThePath) {
    ScratchDir scratch;
    const std::string missing = scratch.path ().string () + "/nope.bin";
    const auto refusal = unsendable_file_ref (ref (missing), "Body file", {});
    ASSERT_HAS_VALUE (refusal);
    EXPECT_NE (refusal->find (missing), std::string::npos) << *refusal;
    EXPECT_NE (refusal->find ("cannot read file"), std::string::npos) << *refusal;
}

// Mutation check: drop the `is_regular_file` test from `FilePlan::approve`
// and the directory opens (on Linux) and `/dev/zero` is read until the inline
// limit and sent as a body.
TEST (FileRule, ADirectoryOrADeviceIsNotAFile) {
    ScratchDir scratch;
    const std::string folder = scratch.dir ("folder");
    const auto refusal =
    unsendable_file_ref (ref (folder), "Body file", allowing (scratch));
    ASSERT_HAS_VALUE (refusal);
    EXPECT_NE (refusal->find ("not a regular file"), std::string::npos) << *refusal;

    if (!fs::exists ("/dev/zero")) {
        GTEST_SKIP ()
        << "no /dev/zero on this platform; the directory case stands";
    }
    Request request = binary_request ("http://127.0.0.1:1/", "/dev/zero");
    FilePlan plan (FileAccessPolicy ({ "/dev" }));
    const auto device = plan.prepare (request);
    ASSERT_HAS_VALUE (device);
    EXPECT_NE (device->find ("not a regular file"), std::string::npos) << *device;
}

// The trust half. Mutation check: make `FilePlan::approve` skip the
// `policy_.approved_path` refusal and the outside path is sent.
TEST (FileRule, APathIsSentFromUnderAnAllowedFolderOrAsAPickedFile) {
    ScratchDir scratch;
    const std::string inside  = scratch.write ("allowed/a.bin", "a");
    const std::string outside = scratch.write ("elsewhere/b.bin", "b");
    const FileAccessPolicy policy ({ scratch.dir ("allowed") });

    EXPECT_FALSE (unsendable_file_ref (ref (inside), "Body file", policy));
    const auto refused = unsendable_file_ref (ref (outside), "Body file", policy);
    ASSERT_HAS_VALUE (refused);
    EXPECT_NE (refused->find (UNTRUSTED), std::string::npos) << *refused;
    EXPECT_NE (refused->find ("Settings > Files"), std::string::npos) << *refused;
    EXPECT_NE (refused->find (outside), std::string::npos) << *refused;

    const FileAccessPolicy picked (
    { scratch.dir ("allowed") }, { fs::canonical (outside).string () });
    EXPECT_FALSE (unsendable_file_ref (ref (outside), "Body file", picked))
    << "a picked file is sent from anywhere";
}

// Nothing a payload says about trust is read (#2356): `unresolved: false`, the
// value that used to mean "a person chose this", is refused outside every root
// and grant exactly like an absent key, a `null` or a string, before the file
// is opened, for a binary body and a form-data part alike. Mutation check:
// read `"unresolved": false` back as trusted in `parse_file_ref` /
// `parse_form_field` and skip the policy for it, and the first payload is read.
TEST (FileRule, WhatAPayloadSaysAboutTrustIsIgnored) {
    ScratchDir scratch;
    const std::string outside = scratch.write ("elsewhere/a.bin", "secret");
    const json bare           = { { "src", outside } };

    for (const json& stated :
    { json (false), json (nullptr), json ("false"), json (true) }) {
        json file          = bare;
        file["unresolved"] = stated;
        const json binary = { { "method", "POST" }, { "url", "http://127.0.0.1:1/" },
            { "body", { { "mode", "binary" }, { "file", file } } } };
        json part    = file;
        part["key"]  = "f";
        part["type"] = "file";
        const json form = { { "method", "POST" }, { "url", "http://127.0.0.1:1/" },
            { "body", { { "mode", "form-data" }, { "fields", json::array ({ part }) } } } };
        for (const json& payload : { binary, form }) {
            auto parsed = vayu::json::deserialize_request (payload);
            ASSERT_TRUE (parsed.is_ok ()) << payload.dump ();
            Request request = std::move (parsed).value ();

            FilePlan plan (FileAccessPolicy ({ scratch.dir ("allowed") }));
            const auto opens   = body_file_opens ();
            const auto refusal = plan.prepare (request);
            ASSERT_HAS_VALUE (refusal) << payload.dump ();
            EXPECT_NE (refusal->find (UNTRUSTED), std::string::npos) << *refusal;
            EXPECT_EQ (body_file_opens (), opens) << "the file was opened";
            EXPECT_EQ (request.body.file.inline_bytes, nullptr);
        }
    }
}

TEST (FileRule, AnUnresolvedSymlinkEscapingARootIsRefused) {
    ScratchDir scratch;
    const std::string outside = scratch.write ("secret/key.pem", "secret");
    const std::string root    = scratch.dir ("allowed");
    const fs::path link       = fs::path (root) / "innocent.bin";
    std::error_code ec;
    fs::create_symlink (outside, link, ec);
    if (ec) {
        GTEST_SKIP () << "this filesystem cannot create a symlink: " << ec.message ();
    }
    const auto refusal = unsendable_file_ref (
    ref (link.string ()), "Body file", FileAccessPolicy ({ root }));
    ASSERT_HAS_VALUE (refusal);
    EXPECT_NE (refusal->find ("not under an allowed folder"), std::string::npos) << *refusal;
}

TEST (FileRule, AFormPartIsNamedByItsKey) {
    ScratchDir scratch;
    const std::string outside = scratch.write ("b.png", "b");
    Request request;
    request.body.mode = BodyMode::FormData;
    FormField part;
    part.key  = "avatar";
    part.type = FormFieldType::File;
    part.src  = outside;
    request.body.fields.push_back (part);

    FilePlan plan;
    const auto refusal = plan.prepare (request);
    ASSERT_HAS_VALUE (refusal);
    EXPECT_EQ (
    refusal->rfind ("Form field 'avatar' '" + outside + "' was not picked", 0), 0u)
    << *refusal;
}

// A small file is read once by the plan and every later copy shares the bytes;
// `fill` never touches the disk. Mutation check: drop the cache-hit return
// from `FilePlan::check_locked` and the open count rises.
TEST (FileRule, ThePlanReadsAFileOnceAndFillsEveryCopy) {
    ScratchDir scratch;
    const std::string payload = binary_payload (1000);
    const std::string src     = scratch.write ("a.bin", payload);

    FilePlan plan (allowing (scratch));
    Request first     = binary_request ("http://127.0.0.1:1/", src);
    const auto before = body_file_opens ();
    ASSERT_FALSE (plan.prepare (first));
    Request second = binary_request ("http://127.0.0.1:1/", src);
    ASSERT_FALSE (plan.fill (second));
    ASSERT_FALSE (plan.prepare (second));
    EXPECT_EQ (body_file_opens () - before, 1u);

    ASSERT_NE (first.body.file.inline_bytes, nullptr);
    EXPECT_EQ (*first.body.file.inline_bytes, payload);
    EXPECT_EQ (first.body.file.inline_bytes, second.body.file.inline_bytes)
    << "shared, not copied";
    EXPECT_EQ (first.body.file.size, payload.size ());
    EXPECT_EQ (first.body.file.sha256, sha256_hex (payload));
    EXPECT_EQ (first.body.file.approved, nullptr)
    << "read inline, the file is not held";

    Request unseen =
    binary_request ("http://127.0.0.1:1/", scratch.write ("b.bin", "b"));
    const auto miss = plan.fill (unseen);
    ASSERT_HAS_VALUE (miss);
    EXPECT_NE (miss->find ("was not checked when the run started"), std::string::npos)
    << *miss;
}

TEST (FileRule, ALargeFileIsHashedNotHeld) {
    ScratchDir scratch;
    const std::string payload = binary_payload (LARGE);
    Request request =
    binary_request ("http://127.0.0.1:1/", scratch.write ("big.bin", payload));
    FilePlan plan (allowing (scratch));
    ASSERT_FALSE (plan.prepare (request));
    EXPECT_EQ (request.body.file.inline_bytes, nullptr);
    EXPECT_EQ (request.body.file.size, payload.size ());
    EXPECT_EQ (request.body.file.sha256, sha256_hex (payload));
    ASSERT_NE (request.body.file.approved, nullptr)
    << "the file it streams from";
    EXPECT_EQ (request.body.file.approved->size (), payload.size ());
}

// ===========================================================================
// The wire
// ===========================================================================

class BinaryBodyWireTest : public ::testing::Test {
    protected:
    void SetUp () override {
        global_init ();
        server_ = std::make_unique<EchoServer> ();
    }
    void TearDown () override {
        server_.reset ();
        global_cleanup ();
    }

    /// Checked and sent through the single-request client, as a design send is.
    Response send (Request request) {
        FilePlan plan (allowing (scratch_));
        const auto refusal = plan.prepare (request);
        EXPECT_FALSE (refusal) << refusal.value_or ("");
        Client client;
        auto result = client.send (request);
        EXPECT_TRUE (result.is_ok ());
        return result.value ();
    }

    /// The same, through the event loop every load run drives.
    Response submit (Request request) {
        FilePlan plan (allowing (scratch_));
        const auto refusal = plan.prepare (request);
        EXPECT_FALSE (refusal) << refusal.value_or ("");
        EventLoop loop;
        loop.start ();
        auto result = loop.submit_async (request).future.get ();
        loop.stop ();
        EXPECT_TRUE (result.is_ok ());
        return result.value ();
    }

    ScratchDir scratch_;
    std::unique_ptr<EchoServer> server_;
};

TEST_F (BinaryBodyWireTest, ASmallFileArrivesByteForByteWithoutTheTransferOpeningIt) {
    const std::string payload = binary_payload (3000);
    const std::string src     = scratch_.write ("a.bin", payload);
    Request request           = binary_request (server_->url (), src);

    FilePlan plan (allowing (scratch_));
    ASSERT_FALSE (plan.prepare (request));
    const auto before = body_file_opens ();
    Client client;
    const auto response = client.send (request).value ();
    EXPECT_EQ (body_file_opens (), before)
    << "the plan's bytes go out; the file is not reopened";
    EXPECT_EQ (response.status_code, 200) << response.error_message;
    EXPECT_EQ (server_->body (), payload);
    EXPECT_EQ (server_->header ("Content-Length"), std::to_string (payload.size ()));

    // The raw view names the file and never carries it.
    EXPECT_NE (response.raw_request.find ("<file a.bin, 3000 bytes>"), std::string::npos)
    << response.raw_request;
    EXPECT_EQ (response.raw_request.find (payload.substr (0, 64)), std::string::npos);
}

TEST_F (BinaryBodyWireTest, AnEmptyFileIsAnEmptyBodyNotNoBody) {
    Request request = binary_request (server_->url (), scratch_.write ("empty.bin", ""));
    const auto response = send (request);
    EXPECT_EQ (response.status_code, 200) << response.error_message;
    EXPECT_EQ (server_->body (), "");
    EXPECT_EQ (server_->header ("Content-Length"), "0");
}

// Four tiers, an empty string absent at each. Mutation check: drop the binary
// arm from `implied_content_type` and every tier below the header reads
// `application/x-www-form-urlencoded`, libcurl's POSTFIELDS default.
TEST_F (BinaryBodyWireTest, ContentTypeFollowsHeaderThenFileThenExtensionThenOctetStream) {
    const std::string png = scratch_.write ("photo.png", "png-bytes");
    const std::string raw = scratch_.write ("blob.unknownext", "raw");

    Request header                 = binary_request (server_->url (), png);
    header.headers["Content-Type"] = "application/vnd.custom";
    header.body.file.content_type  = "image/webp";
    (void)send (header);
    EXPECT_EQ (server_->content_type (), "application/vnd.custom");

    Request declared                 = binary_request (server_->url (), png);
    declared.headers["Content-Type"] = "";
    declared.body.file.content_type  = "image/webp";
    (void)send (declared);
    EXPECT_EQ (server_->content_type (), "image/webp")
    << "an empty header row is absent";

    (void)send (binary_request (server_->url (), png));
    EXPECT_EQ (server_->content_type (), "image/png");

    (void)send (binary_request (server_->url (), raw));
    EXPECT_EQ (server_->content_type (), "application/octet-stream");
}

// A file over the inline limit streams through the read callback, with its
// planned size as the Content-Length and its verb restored over UPLOAD's PUT.
TEST_F (BinaryBodyWireTest, ALargeFileStreamsAndKeepsItsMethod) {
    const std::string payload = binary_payload (LARGE);
    const std::string src     = scratch_.write ("big.bin", payload);

    const auto before = body_file_opens ();
    auto response = send (binary_request (server_->url (), src, HttpMethod::POST));
    EXPECT_EQ (body_file_opens () - before, 1u)
    << "one open: the check hashes the file and the transfer streams it";
    EXPECT_EQ (response.status_code, 200) << response.error_message;
    EXPECT_EQ (server_->method (), "POST")
    << "UPLOAD means PUT unless the verb is restored";
    EXPECT_EQ (server_->body ().size (), payload.size ());
    EXPECT_TRUE (server_->body () == payload);
    EXPECT_EQ (server_->header ("Content-Length"), std::to_string (payload.size ()));

    response = submit (binary_request (server_->url (), src, HttpMethod::PATCH));
    EXPECT_EQ (response.status_code, 200) << response.error_message;
    EXPECT_EQ (server_->method (), "PATCH");
    EXPECT_TRUE (server_->body () == payload);
}

TEST_F (BinaryBodyWireTest, TheLoadDriverSendsTheSameSmallBody) {
    const std::string payload = binary_payload (2048);
    const auto response       = submit (binary_request (
    server_->url (), scratch_.write ("a.bin", payload), HttpMethod::PUT));
    EXPECT_EQ (response.status_code, 200) << response.error_message;
    EXPECT_EQ (server_->method (), "PUT");
    EXPECT_EQ (server_->body (), payload);
}

// A binary body that skipped the plan never reached the file rule, so the send
// gate refuses it rather than reading the file on its behalf. Mutation check:
// drop the `is_prepared` refusal from `validate_transferable` and the client
// sends an empty body.
TEST_F (BinaryBodyWireTest, AnUncheckedBinaryBodyIsRefusedAtTheGate) {
    const Request request =
    binary_request (server_->url (), scratch_.write ("a.bin", "abc"));
    const auto refused = detail::validate_transferable (request);
    ASSERT_HAS_VALUE (refused);
    EXPECT_NE (refused->message.find ("was not checked before the send"), std::string::npos)
    << refused->message;

    Client client;
    const auto response = client.send (request).value ();
    EXPECT_EQ (response.status_code, 0);
    EXPECT_EQ (server_->body (), "");
}

/// A listener that answers its first path with a 307 to its second, which
/// keeps the method and the body - so libcurl has to rewind the upload.
class RedirectingServer {
    public:
    RedirectingServer () {
        svr_.Post ("/start", [] (const httplib::Request&, httplib::Response& res) {
            res.status = 307;
            res.set_header ("Location", "/landed");
        });
        // What landed: the body, or a multipart body's file part `f`.
        svr_.Post ("/landed", [this] (const httplib::Request& req, httplib::Response& res) {
            const std::lock_guard<std::mutex> lock (mutex_);
            landed_ =
            req.form.has_file ("f") ? req.form.get_file ("f").content : req.body;
            res.set_content ("{}", "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }
    ~RedirectingServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    RedirectingServer (const RedirectingServer&)            = delete;
    RedirectingServer& operator= (const RedirectingServer&) = delete;
    RedirectingServer (RedirectingServer&&)                 = delete;
    RedirectingServer& operator= (RedirectingServer&&)      = delete;

    [[nodiscard]] std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/start";
    }
    [[nodiscard]] std::string landed () const {
        const std::lock_guard<std::mutex> lock (mutex_);
        return landed_;
    }

    private:
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    mutable std::mutex mutex_;
    std::string landed_;
};

// The second leg of a 307 - like Digest's or NTLM's second leg - resends the
// body, which a streamed upload can only do by seeking back to its start.
// Mutation check: drop `CURLOPT_SEEKFUNCTION` from `apply_method_and_body` and
// the follow fails with libcurl's rewind error.
TEST_F (BinaryBodyWireTest, AStreamedBodyIsRewoundForARedirect) {
    RedirectingServer redirecting;
    const std::string payload = binary_payload (LARGE);
    Request request =
    binary_request (redirecting.url (), scratch_.write ("big.bin", payload));
    request.follow_redirects = true;

    const auto response = send (request);
    EXPECT_EQ (response.status_code, 200) << response.error_message;
    EXPECT_EQ (redirecting.landed ().size (), payload.size ());
    EXPECT_TRUE (redirecting.landed () == payload);
}

// ===========================================================================
// A design send, through `execute_exchange`
// ===========================================================================

class BinaryBodyExchangeTest : public BinaryBodyWireTest {
    protected:
    routes::ExchangeOutcome exchange (Request request, FilePlan* files) {
        vayu::runtime::ScriptEngine engine;
        CookieJar jar;
        routes::ScriptVariableScopes scopes;
        routes::ExchangeInputs inputs;
        inputs.request = std::move (request);
        inputs.files   = files;
        return routes::execute_exchange (engine, jar, "", scopes, std::move (inputs));
    }
};

// Mutation check: drop the `check_files` branch from `execute_exchange` and
// the outside file reaches the server (an unprepared body is then refused by
// the gate instead, with the wrong message).
TEST_F (BinaryBodyExchangeTest, AnImportedPathOutsideTheAllowedFoldersIsRefusedBeforeTheSend) {
    const std::string outside = scratch_.write ("elsewhere/a.bin", "secret");
    Request request           = binary_request (server_->url (), outside);

    FilePlan files (FileAccessPolicy ({ scratch_.dir ("allowed") }));
    const auto outcome = exchange (request, &files);
    EXPECT_EQ (outcome.response.status_code, 0);
    EXPECT_NE (outcome.response.error_message.find (
               "Body file '" + outside + "' was not picked on this machine"),
    std::string::npos)
    << outcome.response.error_message;
    EXPECT_EQ (server_->body (), "");

    // No plan at all allows no folder: the same refusal, never a send.
    const auto unplanned = exchange (request, nullptr);
    EXPECT_NE (
    unplanned.response.error_message.find ("not under an allowed folder"), std::string::npos);
}

TEST_F (BinaryBodyExchangeTest, AnImportedPathUnderAnAllowedFolderIsSentAndRecorded) {
    const std::string payload = binary_payload (500);
    const std::string inside = scratch_.write ("allowed/sub/data.bin", payload);
    Request request          = binary_request (server_->url (), inside);
    request.body.file.file_name = "upload.bin";

    FilePlan files (FileAccessPolicy ({ scratch_.dir ("allowed") }));
    const auto outcome = exchange (request, &files);
    ASSERT_EQ (outcome.response.status_code, 200) << outcome.response.error_message;
    EXPECT_EQ (server_->body (), payload);

    // What the record says about the file: name, size, digest - never the
    // bytes, never the path. Mutation check: drop `body_file_node` from
    // `build_result_trace` and `bodyFile` is gone.
    const json trace = routes::build_result_trace (outcome.request, outcome.response);
    ASSERT_TRUE (trace["request"].contains ("bodyFile")) << trace.dump ();
    EXPECT_EQ (trace["request"]["bodyFile"],
    (json{ { "fileName", "upload.bin" }, { "size", 500 }, { "sha256", sha256_hex (payload) } }));
    EXPECT_FALSE (trace["request"].contains ("body"));
    EXPECT_EQ (trace.dump ().find (inside), std::string::npos)
    << "the path stays on this machine";
}

// ===========================================================================
// A load run reads a small file once
// ===========================================================================

/// Counts the uploads that arrived intact; calls @p on_first_hit before
/// answering the first.
class CountingServer {
    public:
    explicit CountingServer (std::string expected, std::function<void ()> on_first_hit = {})
    : expected_ (std::move (expected)), on_first_hit_ (std::move (on_first_hit)) {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (16);
        svr_.Post ("/up", [this] (const httplib::Request& req, httplib::Response& res) {
            if (hits_.fetch_add (1) == 0 && on_first_hit_) {
                on_first_hit_ ();
            }
            if (req.body == expected_) {
                intact_.fetch_add (1);
            }
            res.set_content ("{}", "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }
    ~CountingServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    CountingServer (const CountingServer&)            = delete;
    CountingServer& operator= (const CountingServer&) = delete;
    CountingServer (CountingServer&&)                 = delete;
    CountingServer& operator= (CountingServer&&)      = delete;

    [[nodiscard]] std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/up";
    }
    [[nodiscard]] int hits () const {
        return hits_.load ();
    }
    [[nodiscard]] int intact () const {
        return intact_.load ();
    }

    private:
    std::string expected_;
    std::function<void ()> on_first_hit_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    std::atomic<int> hits_{ 0 };
    std::atomic<int> intact_{ 0 };
};

constexpr const char* LOAD_DB_PATH = "test_file_body_load.db";

// The plan reads the file; the run's transfers share its bytes. Mutation
// check: open the file per transfer in `attach_binary` (as a streamed body did
// before #2678) and the open count becomes 1 + iterations.
TEST (BinaryBodyLoadRun, ASmallFileIsOpenedOnceForTheWholeRun) {
    global_init ();
    vayu::tests::remove_database_files (LOAD_DB_PATH);
    {
        vayu::db::Database db (LOAD_DB_PATH);
        db.init ();
        ScratchDir scratch;
        const std::string payload = binary_payload (4000);
        const std::string src     = scratch.write ("a.bin", payload);
        CountingServer server (payload);

        constexpr int ITERATIONS = 20;
        const json config{ { "method", "POST" }, { "url", server.url () },
            { "mode", "iterations" }, { "iterations", ITERATIONS }, { "concurrency", 2 },
            { "body", { { "mode", "binary" }, { "file", { { "src", src } } } } } };

        auto built = build_request (config, &db, 5000, AuthResolution::Apply);
        ASSERT_TRUE (built.ok) << built.error_message;

        const auto before = body_file_opens ();
        auto files        = std::make_shared<FilePlan> (allowing (scratch));
        ASSERT_FALSE (vayu::core::plan_load_files (*files, built.request, nullptr));

        auto context =
        std::make_shared<vayu::core::RunContext> ("test-file-body-load", config);
        context->file_plan = files;
        context->load_template = vayu::core::tokenize_bindable_fields (built.request);
        EventLoopConfig loop_config;
        loop_config.max_concurrent = 10;
        loop_config.max_per_host   = 10;
        context->event_loop        = std::make_unique<EventLoop> (loop_config);
        context->event_loop->start ();
        auto strategy = vayu::core::LoadStrategy::create (config);
        strategy->execute (context, db, built.request);
        context->event_loop->stop (true, std::chrono::milliseconds (10000));

        EXPECT_EQ (server.hits (), ITERATIONS);
        EXPECT_EQ (server.intact (), ITERATIONS);
        EXPECT_EQ (body_file_opens () - before, 1u);
    }
    vayu::tests::remove_database_files (LOAD_DB_PATH);
    global_cleanup ();
}

// A path a data row binds is held to the same rule as any other, and the plan
// checks each distinct bound path once, naming the row at fault. Mutation
// check: drop the `src` visit in `visit_file_strings` (scenario_data.cpp) and
// row 0 is refused as an unresolved variable.
TEST (BinaryBodyPlan, EachPathADataRowBindsIsCheckedNamingTheRow) {
    ScratchDir scratch;
    const std::string inside  = scratch.write ("allowed/a.bin", "a");
    const std::string outside = scratch.write ("elsewhere/b.bin", "b");

    vayu::core::LoadDataSet data;
    data.rows          = { json{ { "f", inside } }, json{ { "f", outside } } };
    data.bound_columns = vayu::core::bound_columns_of (data.rows);

    Request templated = binary_request ("http://127.0.0.1:1/", "{{data.f}}");
    FilePlan files (FileAccessPolicy ({ scratch.dir ("allowed") }));
    const auto refusal = vayu::core::plan_load_files (files, templated, &data);
    ASSERT_HAS_VALUE (refusal);
    EXPECT_EQ (refusal->rfind ("data row 1: Body file '" + outside + "'", 0), 0u)
    << *refusal;
    EXPECT_NE (refusal->find ("not under an allowed folder"), std::string::npos) << *refusal;

    // Row 0 alone passes, and a submission's bound copy fills from the plan.
    data.rows.pop_back ();
    FilePlan only_inside (FileAccessPolicy ({ scratch.dir ("allowed") }));
    ASSERT_FALSE (vayu::core::plan_load_files (only_inside, templated, &data));
    Request bound = templated;
    const vayu::core::IterationBinding binding{ &data.rows.at (0), 0,
        vayu::core::IterationIdentity{ 1, 0 } };
    ASSERT_TRUE (vayu::core::apply_iteration_template (bound,
    vayu::core::tokenize_bindable_fields (templated, data.bound_columns), binding)
    .ok);
    EXPECT_TRUE (vayu::core::fill_bound_files (&only_inside, /*tmpl=*/templated, /*request=*/bound)
    .ok);
    EXPECT_EQ (bound.body.file.size, 1u);
}

// ===========================================================================
// A form-data file part reads the file the check approved (#2416)
// ===========================================================================

/// A form-data request uploading @p src as the part `f`.
Request form_part_request (const std::string& url, const std::string& src) {
    Request request;
    request.method    = HttpMethod::POST;
    request.url       = url;
    request.body.mode = BodyMode::FormData;
    FormField part;
    part.key  = "f";
    part.type = FormFieldType::File;
    part.src  = src;
    request.body.fields.push_back (std::move (part));
    return request;
}

/// @p link re-pointed at @p target; false when this filesystem cannot make a
/// symlink.
bool point_link (const fs::path& link, const std::string& target) {
    std::error_code ec;
    fs::remove (link, ec);
    fs::create_symlink (target, link, ec);
    return !ec;
}

/// The content of the part `f` the echo server last received, or empty.
std::string part_f (const EchoServer& server) {
    const auto parts = server.parts ();
    const auto part  = parts.find ("f");
    return part == parts.end () ? std::string{} : part->second.content;
}

using FormPartWireTest = BinaryBodyWireTest;

// The rule approves a file, then the link at its path is re-pointed before
// the transfer. Both drivers send the approved file, under
// the name the request gave it. Mutation check: read the part from
// `field.src` again in `attach_multipart` (`curl_mime_filedata`) and the other
// file's bytes arrive.
TEST_F (FormPartWireTest, ALinkRepointedAfterTheCheckSendsTheApprovedFile) {
    const std::string approved = scratch_.write ("approved.bin", "approved bytes");
    const std::string other = scratch_.write ("other/key.pem", "other bytes");
    const fs::path link     = scratch_.path () / "upload.bin";
    if (!point_link (link, approved)) {
        GTEST_SKIP () << "this filesystem cannot create a symlink";
    }
    Request request = form_part_request (server_->url (), link.string ());
    FilePlan plan (FileAccessPolicy ({}, { fs::canonical (approved).string () }));
    ASSERT_FALSE (plan.prepare (request));
    ASSERT_TRUE (point_link (link, other));

    Client client;
    const auto sent = client.send (request).value ();
    EXPECT_EQ (sent.status_code, 200) << sent.error_message;
    EXPECT_EQ (part_f (*server_), "approved bytes");
    EXPECT_EQ (server_->parts ()["f"].filename, "upload.bin");

    EventLoop loop;
    loop.start ();
    const auto result = loop.submit_async (request).future.get ();
    loop.stop ();
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_EQ (part_f (*server_), "approved bytes");
}

// The same without a link, so it runs where none can be made: the checked
// path replaced by another file. Mutation check: as above.
TEST_F (FormPartWireTest, AFileReplacedAfterTheCheckSendsTheApprovedOne) {
    const std::string src = scratch_.write ("data.bin", "approved bytes");
    Request request       = form_part_request (server_->url (), src);
    FilePlan plan (allowing (scratch_));
    ASSERT_FALSE (plan.prepare (request));
    // Renamed over the held file rather than removed and rewritten, so a
    // platform that refuses either refuses the one step and skips.
    const std::string replacement = scratch_.write ("data.new", "replacement");
    std::error_code ec;
    fs::rename (replacement, src, ec);
    if (ec) {
        GTEST_SKIP ()
        << "this platform cannot replace a file held open: " << ec.message ();
    }

    Client client;
    const auto sent = client.send (request).value ();
    EXPECT_EQ (sent.status_code, 200) << sent.error_message;
    EXPECT_EQ (part_f (*server_), "approved bytes");
}

// The part's length is the one the open saw; a file truncated below it under
// the handle cannot keep that promise, and the transfer fails rather than send
// a short or padded part. Mutation check: pad the short read with zeros in
// `read_approved` and the transfer succeeds with bytes the file never held.
TEST_F (FormPartWireTest, AFileTruncatedUnderTheHandleFailsTheTransfer) {
    const std::string src = scratch_.write ("data.bin", binary_payload (100000));
    Request request    = form_part_request (server_->url (), src);
    request.timeout_ms = 10000;
    FilePlan plan (allowing (scratch_));
    ASSERT_FALSE (plan.prepare (request));
    std::error_code ec;
    fs::resize_file (src, 10, ec);
    if (ec) {
        GTEST_SKIP ()
        << "this platform cannot truncate a file held open: " << ec.message ();
    }

    Client client;
    const auto sent = client.send (request).value ();
    EXPECT_EQ (sent.status_code, 0);
    EXPECT_FALSE (sent.error_message.empty ());
    EXPECT_TRUE (server_->parts ().empty ());
}

// A data file of many rows names many files. Each is approved at plan time
// and none is kept open by the plan, so a run cannot run out of descriptors;
// `fill` opens a row's file for that request alone, and every request sends
// its own row's bytes. A path the run's own request names is kept, once per
// file however it is spelled. Mutation check: keep every part's open file in
// `FilePlan::prepare_part` whatever `OpenFiles` says and the plan holds one
// per row.
TEST_F (FormPartWireTest, ADataBoundPathIsApprovedButNotKeptOpenByThePlan) {
    constexpr std::size_t ROWS = 60;
    vayu::core::LoadDataSet data;
    for (std::size_t row = 0; row < ROWS; ++row) {
        const std::string name = "rows/" + std::to_string (row) + ".bin";
        data.rows.push_back (
        json{ { "f", scratch_.write (name, "row " + std::to_string (row)) } });
    }
    data.bound_columns = vayu::core::bound_columns_of (data.rows);

    const Request templated = form_part_request (server_->url (), "{{data.f}}");
    FilePlan files (allowing (scratch_));
    Request planned = templated;
    ASSERT_FALSE (vayu::core::plan_load_files (files, planned, &data));
    EXPECT_EQ (files.kept_files (), 0u);

    Client client;
    const auto fields = vayu::core::tokenize_bindable_fields (templated, data.bound_columns);
    for (std::size_t row = 0; row < ROWS; ++row) {
        Request bound = templated;
        const vayu::core::IterationBinding binding{ &data.rows.at (row), row,
            vayu::core::IterationIdentity{ 1, 0 } };
        ASSERT_TRUE (
        vayu::core::apply_iteration_template (bound, fields, binding).ok);
        const auto filled = vayu::core::fill_bound_files (&files, templated, bound);
        ASSERT_TRUE (filled.ok) << filled.error;
        EXPECT_EQ (client.send (bound).value ().status_code, 200);
        EXPECT_EQ (part_f (*server_), "row " + std::to_string (row));
    }
    EXPECT_EQ (files.kept_files (), 0u);

    const std::string fixed = scratch_.write ("fixed.bin", "fixed");
    for (const std::string& spelling : { fixed, scratch_.dir ("rows") + "/../fixed.bin" }) {
        Request request = form_part_request (server_->url (), spelling);
        ASSERT_FALSE (files.prepare (request, OpenFiles::KeptByPlan));
    }
    EXPECT_EQ (files.kept_files (), 1u)
    << "two spellings of one file, one open file";
}

// A part no plan filled never went through the rule, so the gate refuses it
// rather than read its path. Mutation check: drop the file-part arm from
// `unplanned_file_ref` and the transfer reaches a part with no open file.
TEST_F (FormPartWireTest, AnUncheckedFilePartIsRefusedAtTheGate) {
    const Request request =
    form_part_request (server_->url (), scratch_.write ("a.bin", "abc"));
    const auto refused = detail::validate_transferable (request);
    ASSERT_HAS_VALUE (refused);
    EXPECT_EQ (refused->message.rfind ("Form field 'f' '", 0), 0u) << refused->message;
    EXPECT_NE (refused->message.find ("was not checked before the send"), std::string::npos)
    << refused->message;

    Client client;
    const auto response = client.send (request).value ();
    EXPECT_EQ (response.status_code, 0);
    EXPECT_TRUE (server_->parts ().empty ());
}

// A 307 resends the body, which a part read from an open file can only do by
// seeking back to its start. Mutation check: pass no seek callback in
// `attach_multipart` and the follow fails with libcurl's rewind error.
TEST_F (FormPartWireTest, AFilePartIsRewoundForARedirect) {
    RedirectingServer redirecting;
    const std::string payload = binary_payload (100000);
    Request request =
    form_part_request (redirecting.url (), scratch_.write ("big.bin", payload));
    request.follow_redirects = true;

    const auto response = send (request);
    EXPECT_EQ (response.status_code, 200) << response.error_message;
    EXPECT_TRUE (redirecting.landed () == payload);
}

// The plan's open file is the run's, and nothing a part carries reaches a
// stored request: serialising a filled part writes what an unfilled one does.
// Mutation check: write `approved` into the part's JSON in `serialize` and the
// two differ.
TEST (FormPartPlan, TheApprovedFileIsNeverSerialised) {
    ScratchDir scratch;
    const Request unfilled =
    form_part_request ("http://127.0.0.1:1/", scratch.write ("a.png", "a"));
    Request filled = unfilled;
    FilePlan plan (allowing (scratch));
    ASSERT_FALSE (plan.prepare (filled));
    ASSERT_NE (filled.body.fields.at (0).approved, nullptr);
    EXPECT_EQ (vayu::json::serialize (filled), vayu::json::serialize (unfilled));
}

/// Counts the uploads whose part `f` arrived as @p expected; calls
/// @p on_first_hit before answering the first.
class FormPartServer {
    public:
    FormPartServer (std::string expected, std::function<void ()> on_first_hit = {})
    : expected_ (std::move (expected)), on_first_hit_ (std::move (on_first_hit)) {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (16);
        svr_.Post ("/up", [this] (const httplib::Request& req, httplib::Response& res) {
            if (hits_.fetch_add (1) == 0 && on_first_hit_) {
                on_first_hit_ ();
            }
            if (req.form.has_file ("f") && req.form.get_file ("f").content == expected_) {
                intact_.fetch_add (1);
            }
            res.set_content ("{}", "application/json");
        });
        port_   = svr_.bind_to_any_port ("127.0.0.1");
        thread_ = std::thread ([this] () { svr_.listen_after_bind (); });
        svr_.wait_until_ready ();
    }
    ~FormPartServer () {
        svr_.stop ();
        if (thread_.joinable ()) {
            thread_.join ();
        }
    }
    FormPartServer (const FormPartServer&)            = delete;
    FormPartServer& operator= (const FormPartServer&) = delete;
    FormPartServer (FormPartServer&&)                 = delete;
    FormPartServer& operator= (FormPartServer&&)      = delete;

    [[nodiscard]] std::string url () const {
        return "http://127.0.0.1:" + std::to_string (port_) + "/up";
    }
    [[nodiscard]] int hits () const {
        return hits_.load ();
    }
    [[nodiscard]] int intact () const {
        return intact_.load ();
    }

    private:
    std::string expected_;
    std::function<void ()> on_first_hit_;
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    std::atomic<int> hits_{ 0 };
    std::atomic<int> intact_{ 0 };
};

constexpr const char* BODY_LOAD_DB_PATH = "test_file_body_body_load.db";

/// A single-request load run of @p iterations sending @p body to @p url,
/// @p concurrency at a time, planned over @p policy as `POST /runs` plans it.
/// Answers how many times a body file was opened.
std::uint64_t run_body_load (const std::string& url,
const json& body,
FileAccessPolicy policy,
int iterations,
int concurrency) {
    global_init ();
    vayu::tests::remove_database_files (BODY_LOAD_DB_PATH);
    std::uint64_t opens = 0;
    {
        vayu::db::Database db (BODY_LOAD_DB_PATH);
        db.init ();
        const json config{ { "method", "POST" }, { "url", url },
            { "mode", "iterations" }, { "iterations", iterations },
            { "concurrency", concurrency }, { "body", body } };
        auto built = build_request (config, &db, 5000, AuthResolution::Apply);
        EXPECT_TRUE (built.ok) << built.error_message;

        const auto before = body_file_opens ();
        auto files        = std::make_shared<FilePlan> (std::move (policy));
        const auto refusal = vayu::core::plan_load_files (*files, built.request, nullptr);
        EXPECT_FALSE (refusal) << refusal.value_or ("");

        auto context =
        std::make_shared<vayu::core::RunContext> ("test-body-file-load", config);
        context->file_plan = files;
        context->load_template = vayu::core::tokenize_bindable_fields (built.request);
        EventLoopConfig loop_config;
        loop_config.max_concurrent = 10;
        loop_config.max_per_host   = 10;
        context->event_loop        = std::make_unique<EventLoop> (loop_config);
        context->event_loop->start ();
        auto strategy = vayu::core::LoadStrategy::create (config);
        strategy->execute (context, db, built.request);
        context->event_loop->stop (true, std::chrono::milliseconds (10000));
        opens = body_file_opens () - before;
    }
    vayu::tests::remove_database_files (BODY_LOAD_DB_PATH);
    global_cleanup ();
    return opens;
}

/// `run_body_load` uploading @p src as the form-data part `f`.
std::uint64_t run_form_part_load (const std::string& url,
const std::string& src,
FileAccessPolicy policy,
int iterations,
int concurrency) {
    const json body{ { "mode", "form-data" },
        { "fields",
        json::array ({ { { "key", "f" }, { "type", "file" }, { "src", src } } }) } };
    return run_body_load (url, body, std::move (policy), iterations, concurrency);
}

// The swap between iterations: the server re-points the link while answering
// the first upload, so every later iteration is submitted after it. Each one
// still sends the approved file, and the run opens it once. Mutation check:
// read the part from `field.src` in `attach_multipart` and every iteration
// after the first sends the other file.
TEST (FormPartLoadRun, ALinkRepointedMidRunSendsTheApprovedFileEveryIteration) {
    ScratchDir scratch;
    const std::string approved = scratch.write ("approved.bin", "approved bytes");
    const std::string other = scratch.write ("other/key.pem", "other bytes");
    const fs::path link     = scratch.path () / "upload.bin";
    if (!point_link (link, approved)) {
        GTEST_SKIP () << "this filesystem cannot create a symlink";
    }
    std::atomic<bool> swapped{ false };
    FormPartServer server (
    "approved bytes", [&] () { swapped.store (point_link (link, other)); });

    constexpr int ITERATIONS = 8;
    const auto opens = run_form_part_load (server.url (), link.string (),
    FileAccessPolicy ({}, { fs::canonical (approved).string () }), ITERATIONS, 2);
    ASSERT_TRUE (swapped.load ()) << "the link was not re-pointed mid-run";
    EXPECT_EQ (server.hits (), ITERATIONS);
    EXPECT_EQ (server.intact (), ITERATIONS);
    EXPECT_EQ (opens, 1u) << "one open for the whole run, none per transfer";
}

// Concurrent transfers read one open file at their own offsets: a part large
// enough to take many reads, many at once, arrives whole every time. Mutation
// check: make `platform::read_file_at` read from the descriptor's shared
// position (`read`, ignoring the offset) and the uploads interleave.
TEST (FormPartLoadRun, ConcurrentIterationsEachReadTheWholeFile) {
    ScratchDir scratch;
    const std::string payload = binary_payload (300000);
    const std::string src     = scratch.write ("big.bin", payload);
    FormPartServer server (payload);

    constexpr int ITERATIONS = 24;
    (void)run_form_part_load (server.url (), src, allowing (scratch), ITERATIONS, 8);
    EXPECT_EQ (server.hits (), ITERATIONS);
    EXPECT_EQ (server.intact (), ITERATIONS);
}

// ===========================================================================
// A binary body reads the file the check approved (#2678)
// ===========================================================================

/// @p link replaced by a link to @p target in one rename, so it names one file
/// or the other at every instant; false when this filesystem cannot do that.
bool swap_link (const fs::path& link, const std::string& target) {
    const fs::path staged = link.string () + ".next";
    std::error_code ec;
    fs::remove (staged, ec);
    fs::create_symlink (target, staged, ec);
    if (ec) {
        return false;
    }
    fs::rename (staged, link, ec);
    return !ec;
}

/// A large payload whose first bytes are @p tag, so two are told apart.
std::string tagged_large (const std::string& tag) {
    std::string out = binary_payload (LARGE);
    out.replace (0, tag.size (), tag);
    return out;
}

// The rule approves a streamed body's file, then the link at its path is
// re-pointed at another before the transfer. Both drivers stream the approved
// file. Mutation check: stream from `file.src` again in `attach_binary` and
// the other file's bytes arrive.
TEST_F (BinaryBodyWireTest, ALinkRepointedAfterTheCheckStreamsTheApprovedFile) {
    const std::string payload  = tagged_large ("approved");
    const std::string approved = scratch_.write ("approved.bin", payload);
    const std::string other = scratch_.write ("other/key.bin", tagged_large ("other"));
    const fs::path link = scratch_.path () / "upload.bin";
    if (!point_link (link, approved)) {
        GTEST_SKIP () << "this filesystem cannot create a symlink";
    }
    Request request = binary_request (server_->url (), link.string ());
    FilePlan plan (FileAccessPolicy ({}, { fs::canonical (approved).string () }));
    ASSERT_FALSE (plan.prepare (request));
    ASSERT_TRUE (point_link (link, other));

    Client client;
    const auto sent = client.send (request).value ();
    EXPECT_EQ (sent.status_code, 200) << sent.error_message;
    EXPECT_TRUE (server_->body () == payload) << "the other file was streamed";

    EventLoop loop;
    loop.start ();
    const auto result = loop.submit_async (request).future.get ();
    loop.stop ();
    ASSERT_TRUE (result.is_ok ()) << result.error ().message;
    EXPECT_TRUE (server_->body () == payload) << "the other file was streamed";
}

// The check and the inline read are one open: a link flipped while a small
// body is checked is either refused (it named the other file when the rule
// resolved it) or read from the file the rule approved, never approved as one
// file and read from the other. The flips race the plan, so the test runs
// until it has seen both outcomes many times. Mutation check: resolve `src`
// again for the read in `FilePlan::read_body_file` (open
// `fs::canonical (file.src)` rather than read the approved open) and some
// approved reads carry the other file's bytes.
TEST (BinaryBodyPlan, ALinkFlippedDuringTheCheckIsNeverReadAsTheOtherFile) {
    ScratchDir scratch;
    const std::string approved = scratch.write ("approved.bin", "approved bytes");
    const std::string other = scratch.write ("other/key.pem", "other bytes");
    const fs::path link     = scratch.path () / "upload.bin";
    if (!swap_link (link, approved)) {
        GTEST_SKIP ()
        << "this filesystem cannot replace a symlink in one rename";
    }
    const FileAccessPolicy policy ({}, { fs::canonical (approved).string () });

    std::atomic<bool> stop{ false };
    std::thread flipper ([&] () {
        for (bool to_other = true; !stop.load (); to_other = !to_other) {
            (void)swap_link (link, to_other ? other : approved);
            std::this_thread::yield ();
        }
    });
    constexpr int EACH_OUTCOME = 50;
    int accepted               = 0;
    int refused                = 0;
    int misread                = 0;
    const bool both_seen       = vayu::tests::wait_until ([&] () {
        for (int attempt = 0; attempt < 50; ++attempt) {
            FilePlan plan (policy); // a fresh plan per attempt: nothing cached
            Request request = binary_request ("http://127.0.0.1:1/", link.string ());
            if (plan.prepare (request)) {
                ++refused;
                continue;
            }
            ++accepted;
            const auto& bytes = request.body.file.inline_bytes;
            if (bytes == nullptr || *bytes != "approved bytes") {
                ++misread;
            }
        }
        return accepted >= EACH_OUTCOME && refused >= EACH_OUTCOME;
    });
    stop.store (true);
    flipper.join ();
    EXPECT_TRUE (both_seen) << accepted << " accepted, " << refused << " refused";
    EXPECT_EQ (misread, 0) << "approved as one file and read from the other";
}

// The swap between iterations, for a streamed body: the server re-points the
// link while answering the first upload, so every later iteration is submitted
// after it. Each one streams the approved file, and the run opens it once.
// Mutation check: stream from `file.src` in `attach_binary` and every
// iteration after the first sends the other file.
TEST (BinaryBodyLoadRun, ALinkRepointedMidRunStreamsTheApprovedFileEveryIteration) {
    ScratchDir scratch;
    const std::string payload  = tagged_large ("approved");
    const std::string approved = scratch.write ("approved.bin", payload);
    const std::string other = scratch.write ("other/key.bin", tagged_large ("other"));
    const fs::path link = scratch.path () / "upload.bin";
    if (!point_link (link, approved)) {
        GTEST_SKIP () << "this filesystem cannot create a symlink";
    }
    std::atomic<bool> swapped{ false };
    CountingServer server (
    payload, [&] () { swapped.store (point_link (link, other)); });

    constexpr int ITERATIONS = 6;
    const json body{ { "mode", "binary" }, { "file", { { "src", link.string () } } } };
    const auto opens = run_body_load (server.url (), body,
    FileAccessPolicy ({}, { fs::canonical (approved).string () }), ITERATIONS, 2);
    ASSERT_TRUE (swapped.load ()) << "the link was not re-pointed mid-run";
    EXPECT_EQ (server.hits (), ITERATIONS);
    EXPECT_EQ (server.intact (), ITERATIONS);
    EXPECT_EQ (opens, 1u) << "one open for the whole run, none per transfer";
}

// Rows of a data file name large files. Each is approved at plan time and none
// is kept open by the plan; `fill` opens a row's file for that request alone,
// and every request streams its own row's bytes. A path the run's own request
// names is kept, once per file however it is spelled. Mutation check: keep a
// streamed body's open file in `FilePlan::prepare_body_file` whatever
// `OpenFiles` says and the plan holds one per row.
TEST_F (BinaryBodyWireTest, ADataBoundLargeFileIsApprovedButNotKeptOpenByThePlan) {
    constexpr std::size_t ROWS = 3;
    vayu::core::LoadDataSet data;
    std::vector<std::string> payloads;
    for (std::size_t row = 0; row < ROWS; ++row) {
        payloads.push_back (tagged_large ("row " + std::to_string (row)));
        const std::string name = "rows/" + std::to_string (row) + ".bin";
        data.rows.push_back (json{ { "f", scratch_.write (name, payloads.back ()) } });
    }
    data.bound_columns = vayu::core::bound_columns_of (data.rows);

    const Request templated = binary_request (server_->url (), "{{data.f}}");
    FilePlan files (allowing (scratch_));
    Request planned = templated;
    ASSERT_FALSE (vayu::core::plan_load_files (files, planned, &data));
    EXPECT_EQ (files.kept_files (), 0u);

    Client client;
    const auto fields = vayu::core::tokenize_bindable_fields (templated, data.bound_columns);
    for (std::size_t row = 0; row < ROWS; ++row) {
        Request bound = templated;
        const vayu::core::IterationBinding binding{ &data.rows.at (row), row,
            vayu::core::IterationIdentity{ 1, 0 } };
        ASSERT_TRUE (
        vayu::core::apply_iteration_template (bound, fields, binding).ok);
        const auto filled = vayu::core::fill_bound_files (&files, templated, bound);
        ASSERT_TRUE (filled.ok) << filled.error;
        ASSERT_NE (bound.body.file.approved, nullptr);
        EXPECT_EQ (client.send (bound).value ().status_code, 200);
        EXPECT_TRUE (server_->body () == payloads.at (row)) << "row " << row;
    }
    EXPECT_EQ (files.kept_files (), 0u);

    const std::string fixed = scratch_.write ("fixed.bin", tagged_large ("fixed"));
    for (const std::string& spelling : { fixed, scratch_.dir ("rows") + "/../fixed.bin" }) {
        Request request = binary_request (server_->url (), spelling);
        ASSERT_FALSE (files.prepare (request, OpenFiles::KeptByPlan));
    }
    EXPECT_EQ (files.kept_files (), 1u)
    << "two spellings of one file, one open file";
}

// A streamed body's length is the one the open saw; a file truncated below it
// under the handle cannot keep that promise, and the transfer fails rather
// than send a short body. Mutation check: pad the short read with zeros in
// `read_approved` and the transfer succeeds with bytes the file never held.
TEST_F (BinaryBodyWireTest, AStreamedFileTruncatedUnderTheHandleFailsTheTransfer) {
    const std::string src = scratch_.write ("big.bin", binary_payload (LARGE));
    Request request       = binary_request (server_->url (), src);
    request.timeout_ms    = 10000;
    FilePlan plan (allowing (scratch_));
    ASSERT_FALSE (plan.prepare (request));
    std::error_code ec;
    fs::resize_file (src, 10, ec);
    if (ec) {
        GTEST_SKIP ()
        << "this platform cannot truncate a file held open: " << ec.message ();
    }

    Client client;
    const auto sent = client.send (request).value ();
    EXPECT_EQ (sent.status_code, 0);
    EXPECT_FALSE (sent.error_message.empty ());
    EXPECT_EQ (server_->body (), "");
}

// ===========================================================================
// The stored roots and grants, on every send path
// ===========================================================================

constexpr const char* TRUST_DB_PATH = "test_file_trust.db";

/// A design send, a load run's plan and a collection run, each reading the
/// stored `file_roots` and `file_grants` as its route does
/// (`FileAccessPolicy::from_database`).
class StoredTrustTest : public BinaryBodyExchangeTest {
    protected:
    void SetUp () override {
        BinaryBodyExchangeTest::SetUp ();
        vayu::tests::remove_database_files (TRUST_DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (TRUST_DB_PATH);
        db_->init ();
        vayu::db::Collection collection;
        collection.id   = "col";
        collection.name = "C";
        db_->create_collection (collection);
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (TRUST_DB_PATH);
        BinaryBodyExchangeTest::TearDown ();
    }

    /// Records @p path as picked, the way the grant route stores it.
    void grant (const std::string& path) {
        const auto canonical = grantable_file_path (path);
        ASSERT_HAS_VALUE (canonical) << path;
        FileGrant row;
        row.id         = "fgrant_" + std::to_string (++grants_);
        row.path       = *canonical;
        row.created_at = 1;
        db_->save_file_grant (row);
    }

    void allow_folder (const std::string& folder) {
        FileRoot row;
        row.id         = "froot_1";
        row.path       = folder;
        row.created_at = 1;
        db_->save_file_root (row);
    }

    /// The `POST /execute` payload sending @p body to the echo server.
    json payload (const json& body) const {
        return { { "method", "POST" }, { "url", server_->url () }, { "body", body } };
    }

    /// `execution.cpp`'s buffered design send: parse, plan over the stored
    /// roots and grants, send.
    routes::ExchangeOutcome design_send (const json& body) {
        auto parsed = vayu::json::deserialize_request (payload (body));
        EXPECT_TRUE (parsed.is_ok ()) << body.dump ();
        FilePlan files (FileAccessPolicy::from_database (*db_));
        return exchange (std::move (parsed).value (), &files);
    }

    /// A single-request load run's plan (`plan_load_files`).
    std::optional<std::string> load_plan (const json& body) {
        auto parsed = vayu::json::deserialize_request (payload (body));
        EXPECT_TRUE (parsed.is_ok ()) << body.dump ();
        Request request = std::move (parsed).value ();
        FilePlan files (FileAccessPolicy::from_database (*db_));
        return vayu::core::plan_load_files (files, request, nullptr);
    }

    /// A collection run over one stored request carrying @p body.
    vayu::core::ScenarioResolution collection_run (const json& body) {
        vayu::db::Request row;
        row.id            = "req";
        row.collection_id = "col";
        row.name          = "Upload";
        row.method        = HttpMethod::POST;
        row.url           = server_->url ();
        row.body          = body.dump ();
        db_->save_request (row);
        vayu::core::ScenarioResolveOptions options;
        options.timeout_ms            = 30000;
        options.limits.max_steps      = 10;
        options.limits.max_data_rows  = 10;
        options.limits.max_data_bytes = 1024;
        return vayu::core::resolve_scenario (*db_,
        json{ { "source", "collection" }, { "collectionId", "col" } }, options);
    }

    /// Both shapes that name a file, each saying a person chose it - the
    /// claim the engine no longer takes from a body.
    static std::vector<json> bodies_claiming_trust (const std::string& src) {
        return { { { "mode", "binary" },
                 { "file", { { "src", src }, { "unresolved", false } } } },
            { { "mode", "form-data" },
            { "fields",
            json::array ({ { { "key", "f" }, { "type", "file" }, { "src", src },
            { "unresolved", false } } }) } } };
    }

    /// True when the last design send delivered @p contents, as a binary body
    /// or as the form part `f`.
    bool delivered (const std::string& contents) const {
        const auto parts = server_->parts ();
        const auto part  = parts.find ("f");
        return server_->body () == contents ||
        (part != parts.end () && part->second.content == contents);
    }

    std::unique_ptr<vayu::db::Database> db_;
    int grants_ = 0;
};

// The finding #2356 names: a body saying `unresolved: false` used to skip the
// folder rule. Outside every root and every grant it is refused on all three
// send paths, for a binary body and a form-data part. Mutation check: restore
// the body-read trust (parse the key and let `false` skip
// `policy_.approved_path` in `FilePlan::approve`) and every refusal here
// turns into a send.
TEST_F (StoredTrustTest, AFalseBodyOutsideEveryRootAndGrantIsRefusedOnEverySendPath) {
    const std::string outside = scratch_.write ("elsewhere/a.bin", "secret");
    for (const json& body : bodies_claiming_trust (outside)) {
        const auto sent = design_send (body);
        EXPECT_EQ (sent.response.status_code, 0) << body.dump ();
        EXPECT_NE (sent.response.error_message.find (UNTRUSTED), std::string::npos)
        << sent.response.error_message;
        EXPECT_FALSE (delivered ("secret")) << "the file reached the server";

        const auto run = collection_run (body);
        EXPECT_FALSE (run.ok) << body.dump ();
        EXPECT_NE (run.error.find (UNTRUSTED), std::string::npos) << run.error;

        const auto planned = load_plan (body);
        ASSERT_HAS_VALUE (planned) << body.dump ();
        EXPECT_NE (planned->find (UNTRUSTED), std::string::npos) << *planned;
    }
}

// Mutation check: make `FileAccessPolicy::from_database` skip
// `get_file_grants` (or `allows` ignore the grant set) and every path here is
// refused.
TEST_F (StoredTrustTest, TheSamePathGrantedIsSentOnEverySendPath) {
    const std::string picked = scratch_.write ("elsewhere/a.bin", "picked bytes");
    grant (picked);
    for (const json& body : bodies_claiming_trust (picked)) {
        const auto sent = design_send (body);
        EXPECT_EQ (sent.response.status_code, 200) << sent.response.error_message;
        EXPECT_TRUE (delivered ("picked bytes")) << body.dump ();
        EXPECT_FALSE (load_plan (body));
        const auto run = collection_run (body);
        EXPECT_TRUE (run.ok) << run.error;
    }
}

TEST_F (StoredTrustTest, APathUnderAnAllowedFolderIsSentOnEverySendPath) {
    const std::string inside = scratch_.write ("allowed/a.bin", "allowed bytes");
    allow_folder (scratch_.dir ("allowed"));
    for (const json& body : bodies_claiming_trust (inside)) {
        const auto sent = design_send (body);
        EXPECT_EQ (sent.response.status_code, 200) << sent.response.error_message;
        EXPECT_TRUE (delivered ("allowed bytes")) << body.dump ();
        EXPECT_FALSE (load_plan (body));
        const auto run = collection_run (body);
        EXPECT_TRUE (run.ok) << run.error;
    }
}

// The stored grant is the target the link named when it was picked; read
// back through the database it is never resolved again. Mutation check:
// canonicalise each grant in `from_database` or the constructor and the
// re-pointed link is sent.
TEST_F (StoredTrustTest, AGrantedLinkRepointedAfterThePickIsRefused) {
    const std::string first  = scratch_.write ("first.bin", "first");
    const std::string secret = scratch_.write ("secret/key.pem", "secret");
    const fs::path link      = scratch_.path () / "upload.bin";
    std::error_code ec;
    fs::create_symlink (first, link, ec);
    if (ec) {
        GTEST_SKIP () << "this filesystem cannot create a symlink: " << ec.message ();
    }
    grant (link.string ());
    const json body = bodies_claiming_trust (link.string ()).front ();
    EXPECT_EQ (design_send (body).response.status_code, 200);

    fs::remove (link);
    fs::create_symlink (secret, link, ec);
    ASSERT_FALSE (ec) << ec.message ();
    const auto sent = design_send (body);
    EXPECT_EQ (sent.response.status_code, 0);
    EXPECT_NE (sent.response.error_message.find (UNTRUSTED), std::string::npos)
    << sent.response.error_message;
    EXPECT_NE (server_->body (), "secret");
}

// ===========================================================================
// The derived `unresolved` the read routes answer
// ===========================================================================

/// The `unresolved` of a request's binary `file`, or of its first part.
json trust_of (const json& request) {
    const json& body = request.at ("body");
    return body.contains ("file") ? body.at ("file").at ("unresolved") :
                                    body.at ("fields").at (0).at ("unresolved");
}

// A write keeps no trust (the key an older client sends is dropped), and every
// read answers what the roots and grants say now. Mutation checks: drop the
// `erase_file_trust` call in `apply_request_fields` and the stored body keeps
// `false`; drop `derive_file_trust` from either request serializer and its
// read answers no key.
TEST_F (StoredTrustTest, ARequestStoresNoTrustAndEveryReadDerivesIt) {
    const std::string outside = scratch_.write ("elsewhere/a.bin", "a");
    for (const json& body : bodies_claiming_trust (outside)) {
        const json write = { { "collectionId", "col" }, { "name", "r" },
            { "method", "POST" }, { "url", "https://example.test" }, { "body", body } };
        const auto [status, created] = routes::create_request_response (*db_, write);
        ASSERT_EQ (status, 200) << created.dump ();
        const std::string id = created.at ("id").get<std::string> ();
        const auto stored    = db_->get_request (id);
        ASSERT_HAS_VALUE (stored);
        EXPECT_EQ (stored->body.find ("unresolved"), std::string::npos)
        << stored->body;

        EXPECT_EQ (trust_of (created), true) << created.dump ();
        EXPECT_EQ (trust_of (routes::get_request_response (*db_, id).second), true);
        const json listed = json::parse (routes::list_requests_body (*db_, "col"));
        EXPECT_EQ (trust_of (listed.back ()), true) << listed.dump ();
    }

    grant (outside);
    const json listed = json::parse (routes::list_requests_body (*db_, "col"));
    ASSERT_EQ (listed.size (), 2u);
    for (const json& request : listed) {
        EXPECT_EQ (trust_of (request), false) << request.dump ();
        EXPECT_EQ (trust_of (routes::get_request_response (
                   *db_, request.at ("id").get<std::string> ())
                   .second),
        false);
    }
}

// Nothing to doubt yet: a path a variable still has to fill, which composition
// decides and the editor marks with its own line, and no path at all, which
// carries no key - the shape an import has always written for one.
TEST_F (StoredTrustTest, AnEmptyOrTemplatedPathIsNotDerivedUnresolved) {
    const auto created_body = [this] (const std::string& src) {
        const json write = { { "collectionId", "col" }, { "name", "r" },
            { "method", "POST" }, { "url", "https://example.test" },
            { "body", bodies_claiming_trust (src).front () } };
        const auto [status, created] = routes::create_request_response (*db_, write);
        EXPECT_EQ (status, 200) << created.dump ();
        return created.at ("body").at ("file");
    };
    EXPECT_EQ (created_body ("{{fixtures}}/a.bin").at ("unresolved"), false);
    EXPECT_FALSE (created_body ("").contains ("unresolved"));
}

// A run's snapshot is the payload a history entry is re-opened from: stored
// without the key, read back derived. Mutation checks: drop the
// `erase_file_trust` call in `sanitize_config_snapshot` and the stored text
// keeps `false`; drop the derivation in `get_run_response` and the snapshot
// still says `false`.
TEST_F (StoredTrustTest, ARunSnapshotStoresNoTrustAndAnswersTheDerivedOne) {
    const std::string outside = scratch_.write ("elsewhere/a.bin", "a");
    const json sent = payload (bodies_claiming_trust (outside).front ());
    vayu::db::Run run;
    run.id         = "run_trust";
    run.type       = RunType::Design;
    run.status     = RunStatus::Completed;
    run.start_time = 1;
    run.config_snapshot = vayu::json::sanitize_config_snapshot (sent.dump (), 4096, {});
    EXPECT_EQ (run.config_snapshot.find ("unresolved"), std::string::npos)
    << run.config_snapshot;
    db_->create_run (run);

    const auto [status, answered] = routes::get_run_response (*db_, "run_trust");
    ASSERT_EQ (status, 200) << answered.dump ();
    EXPECT_EQ (trust_of (answered.at ("configSnapshot")), true) << answered.dump ();

    grant (outside);
    EXPECT_EQ (trust_of (routes::get_run_response (*db_, "run_trust").second.at ("configSnapshot")),
    false);
    EXPECT_EQ (routes::get_run_response (*db_, "run_missing").first, 404);
}

// ===========================================================================
// The /file-roots route cores
// ===========================================================================

constexpr const char* ROOTS_DB_PATH = "test_file_roots.db";

class FileRootsRouteTest : public ::testing::Test {
    protected:
    void SetUp () override {
        vayu::tests::remove_database_files (ROOTS_DB_PATH);
        db_ = std::make_unique<vayu::db::Database> (ROOTS_DB_PATH);
        db_->init ();
    }
    void TearDown () override {
        db_.reset ();
        vayu::tests::remove_database_files (ROOTS_DB_PATH);
    }
    /// POST /file-roots with the scratch directory's `home` as the home folder.
    std::pair<int, nlohmann::json> create (const json& body) {
        return routes::create_file_root_response (*db_, body, home_);
    }

    ScratchDir scratch_;
    std::string home_ = scratch_.dir ("home");
    std::unique_ptr<vayu::db::Database> db_;
};

TEST_F (FileRootsRouteTest, CreateListDelete) {
    const std::string b = scratch_.dir ("b");
    const std::string a = scratch_.dir ("a");

    auto [status_b, row_b] = create (json{ { "path", b + "/" } });
    ASSERT_EQ (status_b, 201) << row_b.dump ();
    EXPECT_EQ (row_b["path"], b) << "stored canonical, no trailing separator";
    EXPECT_TRUE (row_b["id"].is_string ());
    EXPECT_TRUE (row_b["createdAt"].is_number_integer ());
    auto [status_a, row_a] = create (json{ { "path", a } });
    ASSERT_EQ (status_a, 201) << row_a.dump ();

    const json listed = routes::list_file_roots_response (*db_);
    ASSERT_TRUE (listed.is_array ());
    ASSERT_EQ (listed.size (), 2u);
    EXPECT_EQ (listed[0]["path"], a) << "ordered by path";
    EXPECT_EQ (listed[1]["path"], b);

    // What the send reads is what the route stored.
    EXPECT_TRUE (
    FileAccessPolicy::from_database (*db_).allows (scratch_.write ("a/x.bin", "x")));

    EXPECT_EQ (
    routes::delete_file_root_response (*db_, row_a["id"].get<std::string> ()).first, 200);
    EXPECT_EQ (routes::list_file_roots_response (*db_).size (), 1u);
    EXPECT_EQ (
    routes::delete_file_root_response (*db_, row_a["id"].get<std::string> ()).first, 404);
}

TEST_F (FileRootsRouteTest, ABadPathIsA400) {
    const std::string file = scratch_.write ("f.txt", "x");
    for (const json& body : { json::object (), json{ { "path", 7 } },
         json{ { "path", "" } }, json{ { "path", "relative/dir" } },
         json{ { "path", file } }, json{ { "path", scratch_.path ().string () + "/missing" } },
         json{ { "id", "x" }, { "path", scratch_.dir ("d") } } }) {
        EXPECT_EQ (create (body).first, 400) << body.dump ();
    }
    EXPECT_TRUE (routes::list_file_roots_response (*db_).empty ());
}

// Mutation check: drop the duplicate scan in `create_file_root_response` and
// the second spelling answers 201, silently replacing the first row.
TEST_F (FileRootsRouteTest, ASecondSpellingOfAnAllowedFolderIsA409) {
    const std::string dir = scratch_.dir ("fixtures");
    ASSERT_EQ (create (json{ { "path", dir } }).first, 201);
    const auto [status, body] = create (json{ { "path", dir + "/../fixtures/" } });
    EXPECT_EQ (status, 409) << body.dump ();
    EXPECT_EQ (routes::list_file_roots_response (*db_).size (), 1u);
}

// A root or the home folder itself would allow almost every file a request
// could name. Pure over both separators, so the Windows spellings run on every
// host. Mutation check: drop the drive-designator clause in
// `refused_root_reason` and `C:\` is allowed.
TEST (FileRootRule, AFilesystemOrDriveRootIsRefused) {
    for (const char* root : { "/", "//", "\\", "C:\\", "D:\\", "c:/", "Z:" }) {
        const auto reason = refused_root_reason (root, "");
        ASSERT_HAS_VALUE (reason) << root;
        EXPECT_NE (reason->find ("is a filesystem root"), std::string::npos) << *reason;
    }
    for (const char* folder : { "/data", "C:\\data", "D:/fixtures", "/C:" }) {
        EXPECT_FALSE (refused_root_reason (folder, "")) << folder;
    }
}

// Mutation check: drop the home comparison in `refused_root_reason` and both
// spellings of the home folder are allowed.
TEST (FileRootRule, TheHomeFolderIsRefusedAndAFolderInsideItIsNot) {
    const auto posix = refused_root_reason ("/home/ada", "/home/ada/");
    ASSERT_HAS_VALUE (posix);
    EXPECT_NE (posix->find ("is your home folder"), std::string::npos) << *posix;
    EXPECT_FALSE (refused_root_reason ("/home/ada/fixtures", "/home/ada"));
    EXPECT_FALSE (refused_root_reason ("/home/ADA", "/home/ada"))
    << "a POSIX path compares exactly";

    // A drive-letter path is on a filesystem that folds case.
    EXPECT_TRUE (refused_root_reason ("C:\\Users\\Ada", "c:\\users\\ada\\"));
    EXPECT_FALSE (refused_root_reason ("C:\\Users\\Ada\\fixtures", "C:\\Users\\Ada"));
}

// A folder that contains home allows every file the user owns, the same as
// home itself. Mutation check: make `is_home_or_above` demand equal lengths
// (home itself only) and every parent below is allowed.
TEST (FileRootRule, AFolderContainingTheHomeFolderIsRefused) {
    for (const auto& [folder, home] :
    std::vector<std::pair<const char*, const char*>>{ { "/home", "/home/ada" },
    { "/home/", "/home/ada/" }, { "/Users", "/Users/ada" },
    { "/var/lib", "/var/lib/svc/home" }, { "C:\\Users", "C:\\Users\\Ada" },
    { "c:\\users", "C:\\Users\\Ada" }, { "C:/Users", "C:\\Users\\Ada" } }) {
        const auto reason = refused_root_reason (folder, home);
        ASSERT_HAS_VALUE (reason) << folder << " above " << home;
        EXPECT_NE (reason->find ("contains it"), std::string::npos) << *reason;
    }
    // Containment is by component, never by a shared prefix of characters.
    for (const auto& [folder, home] :
    std::vector<std::pair<const char*, const char*>>{ { "/home/ad", "/home/ada" },
    { "/hom", "/home/ada" }, { "/Home", "/home/ada" }, { "/home/adamant", "/home/ada" },
    { "C:\\Users\\Ad", "C:\\Users\\Ada" }, { "D:\\Users", "C:\\Users\\Ada" } }) {
        EXPECT_FALSE (refused_root_reason (folder, home)) << folder << " beside " << home;
    }
}

// The route applies both rules to the canonical path, with the home folder it
// is handed. The root here is whichever the host's scratch directory is on.
TEST_F (FileRootsRouteTest, ARootOrTheHomeFolderIsA400AndAFolderInsideHomeIsNot) {
    const std::string root = scratch_.path ().root_path ().string ();
    const auto [root_status, root_body] = create (json{ { "path", root } });
    EXPECT_EQ (root_status, 400) << root_body.dump ();
    EXPECT_NE (root_body.dump ().find ("is a filesystem root"), std::string::npos)
    << root_body.dump ();

    const auto [home_status, home_body] = create (json{ { "path", home_ + "/." } });
    EXPECT_EQ (home_status, 400) << home_body.dump ();
    EXPECT_NE (home_body.dump ().find ("is your home folder"), std::string::npos)
    << home_body.dump ();
    EXPECT_TRUE (routes::list_file_roots_response (*db_).empty ());

    const std::string inside = scratch_.dir ("home/fixtures");
    const auto [inside_status, inside_row] = create (json{ { "path", inside } });
    EXPECT_EQ (inside_status, 201) << inside_row.dump ();
}

// `/home` to a home at `/home/ada`: the scratch directory holds `home`, so it
// is that parent here, spelled with a trailing separator and a `..` the
// canonical form folds away.
TEST_F (FileRootsRouteTest, AFolderContainingTheHomeFolderIsA400) {
    for (const std::string& parent :
    { scratch_.path ().string (), scratch_.path ().string () + "/", home_ + "/.." }) {
        const auto [status, body] = create (json{ { "path", parent } });
        EXPECT_EQ (status, 400) << parent << " " << body.dump ();
        EXPECT_NE (body.dump ().find ("contains it"), std::string::npos) << body.dump ();
    }
    EXPECT_TRUE (routes::list_file_roots_response (*db_).empty ());
}

} // namespace
} // namespace vayu::http
