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
 * 1. **The rule** - `FileAccessPolicy` containment and `FilePlan`'s refusals,
 *    on real files in a scratch directory: no file selected, an unresolved
 *    variable, a directory or device, a missing file, and the trust half (a
 *    path nobody chose in the editor is sent only from under an allowed
 *    folder, a symlink escaping one included).
 * 2. **The wire** - both drivers against the in-process echo server: the bytes
 *    arrive identical, the Content-Type follows its four tiers, a small file is
 *    shared from the plan and a large one streams, and a streamed body is
 *    rewound for a redirect (the seek callback).
 * 3. **The callers** - a design send through `execute_exchange`, a load run
 *    through its strategy, and the `/file-roots` route cores.
 */

#include <gtest/gtest.h>

#include <atomic>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>
#include <utility>

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

namespace vayu::http::routes {
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
        out[i] = static_cast<char> ((i * 131 + 7) % 256);
    }
    return out;
}

std::string sha256_hex (std::string_view bytes) {
    const auto digest = vayu::utils::sha256 (bytes);
    return vayu::utils::hex_encode (vayu::utils::byte_view (digest));
}

/// A binary request whose file a person chose in the editor, so the trust
/// half of the rule stays out of the way of a test about the wire.
Request binary_request (const std::string& url,
const std::string& src,
HttpMethod method = HttpMethod::POST) {
    Request request;
    request.method               = method;
    request.url                  = url;
    request.body.mode            = BodyMode::Binary;
    request.body.file.src        = src;
    request.body.file.unresolved = false;
    return request;
}

FileRef ref (std::string src, bool unresolved = false) {
    FileRef file;
    file.src        = std::move (src);
    file.unresolved = unresolved;
    return file;
}

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

// Mutation check: drop the `is_regular_file` test from `FilePlan::check_locked`
// and the directory opens (on Linux) and `/dev/zero` is read until the inline
// limit and sent as a body.
TEST (FileRule, ADirectoryOrADeviceIsNotAFile) {
    ScratchDir scratch;
    const std::string folder = scratch.dir ("folder");
    const auto refusal = unsendable_file_ref (ref (folder), "Body file", {});
    ASSERT_HAS_VALUE (refusal);
    EXPECT_NE (refusal->find ("not a regular file"), std::string::npos) << *refusal;

    if (!fs::exists ("/dev/zero")) {
        GTEST_SKIP ()
        << "no /dev/zero on this platform; the directory case stands";
    }
    Request request = binary_request ("http://127.0.0.1:1/", "/dev/zero");
    FilePlan plan;
    const auto device = plan.prepare (request);
    ASSERT_HAS_VALUE (device);
    EXPECT_NE (device->find ("not a regular file"), std::string::npos) << *device;
}

// The trust half. Mutation check: make `check_locked` skip the
// `file.unresolved && !under_root` refusal and the outside path is sent.
TEST (FileRule, APathNobodyChoseIsSentOnlyFromUnderAnAllowedFolder) {
    ScratchDir scratch;
    const std::string inside  = scratch.write ("allowed/a.bin", "a");
    const std::string outside = scratch.write ("elsewhere/b.bin", "b");
    const FileAccessPolicy policy ({ scratch.dir ("allowed") });

    EXPECT_FALSE (unsendable_file_ref (ref (inside, true), "Body file", policy));
    const auto refused = unsendable_file_ref (ref (outside, true), "Body file", policy);
    ASSERT_HAS_VALUE (refused);
    EXPECT_NE (refused->find ("was not chosen in the editor and is not under "
                              "an allowed folder"),
    std::string::npos)
    << *refused;
    EXPECT_NE (refused->find ("Settings > Files"), std::string::npos) << *refused;
    EXPECT_NE (refused->find (outside), std::string::npos) << *refused;

    // A path a person chose is sent from anywhere.
    EXPECT_FALSE (unsendable_file_ref (ref (outside, false), "Body file", policy));
}

// The trust flag fails closed: only `"unresolved": false` in so many words says
// a person chose the path. An absent key, `null` or a string is a path nobody
// chose, refused outside an allowed folder before the file is opened.
// Mutation check: make `reads_as_unresolved` answer `false` for an absent key
// and the first payload is read and planned.
TEST (FileRule, APayloadThatDoesNotSayAPersonChoseThePathIsUnresolved) {
    ScratchDir scratch;
    const std::string outside = scratch.write ("elsewhere/a.bin", "secret");
    const json bare           = { { "src", outside } };

    for (const json& file : { bare, json{ { "src", outside }, { "unresolved", nullptr } },
         json{ { "src", outside }, { "unresolved", "false" } } }) {
        const json payload = { { "method", "POST" }, { "url", "http://127.0.0.1:1/" },
            { "body", { { "mode", "binary" }, { "file", file } } } };
        auto parsed = vayu::json::deserialize_request (payload);
        ASSERT_TRUE (parsed.is_ok ()) << file.dump ();
        Request request = std::move (parsed).value ();
        EXPECT_TRUE (request.body.file.unresolved) << file.dump ();

        FilePlan plan (FileAccessPolicy ({ scratch.dir ("allowed") }));
        const auto opens   = body_file_opens ();
        const auto refusal = plan.prepare (request);
        ASSERT_HAS_VALUE (refusal) << file.dump ();
        EXPECT_NE (refusal->find ("was not chosen in the editor"), std::string::npos)
        << *refusal;
        EXPECT_EQ (body_file_opens (), opens) << "the file was opened";
        EXPECT_EQ (request.body.file.inline_bytes, nullptr);
    }

    const json part_payload = { { "method", "POST" }, { "url", "http://127.0.0.1:1/" },
        { "body",
        { { "mode", "form-data" },
        { "fields",
        json::array ({ { { "key", "f" }, { "type", "file" }, { "src", outside } } }) } } } };
    auto part = vayu::json::deserialize_request (part_payload);
    ASSERT_TRUE (part.is_ok ());
    ASSERT_EQ (part.value ().body.fields.size (), 1u);
    EXPECT_TRUE (part.value ().body.fields[0].unresolved);

    json chosen          = bare;
    chosen["unresolved"] = false;
    const json chosen_payload = { { "method", "POST" }, { "url", "http://127.0.0.1:1/" },
        { "body", { { "mode", "binary" }, { "file", chosen } } } };
    auto chosen_parsed = vayu::json::deserialize_request (chosen_payload);
    ASSERT_TRUE (chosen_parsed.is_ok ());
    Request chosen_request = std::move (chosen_parsed).value ();
    EXPECT_FALSE (chosen_request.body.file.unresolved);
    FilePlan plan (FileAccessPolicy ({ scratch.dir ("allowed") }));
    EXPECT_FALSE (plan.prepare (chosen_request))
    << "a path a person chose is sent from anywhere";
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
    ref (link.string (), true), "Body file", FileAccessPolicy ({ root }));
    ASSERT_HAS_VALUE (refusal);
    EXPECT_NE (refusal->find ("not under an allowed folder"), std::string::npos) << *refusal;
}

TEST (FileRule, AFormPartIsNamedByItsKey) {
    ScratchDir scratch;
    const std::string outside = scratch.write ("b.png", "b");
    Request request;
    request.body.mode = BodyMode::FormData;
    FormField part;
    part.key        = "avatar";
    part.type       = FormFieldType::File;
    part.src        = outside;
    part.unresolved = true;
    request.body.fields.push_back (part);

    FilePlan plan;
    const auto refusal = plan.prepare (request);
    ASSERT_HAS_VALUE (refusal);
    EXPECT_EQ (
    refusal->rfind ("Form field 'avatar' '" + outside + "' was not chosen", 0), 0u)
    << *refusal;
}

// A small file is read once by the plan and every later copy shares the bytes;
// `fill` never touches the disk. Mutation check: drop the cache-hit return
// from `FilePlan::check_locked` and the open count rises.
TEST (FileRule, ThePlanReadsAFileOnceAndFillsEveryCopy) {
    ScratchDir scratch;
    const std::string payload = binary_payload (1000);
    const std::string src     = scratch.write ("a.bin", payload);

    FilePlan plan;
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
    FilePlan plan;
    ASSERT_FALSE (plan.prepare (request));
    EXPECT_EQ (request.body.file.inline_bytes, nullptr);
    EXPECT_EQ (request.body.file.size, payload.size ());
    EXPECT_EQ (request.body.file.sha256, sha256_hex (payload));
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
        FilePlan plan;
        const auto refusal = plan.prepare (request);
        EXPECT_FALSE (refusal) << refusal.value_or ("");
        Client client;
        auto result = client.send (request);
        EXPECT_TRUE (result.is_ok ());
        return result.value ();
    }

    /// The same, through the event loop every load run drives.
    Response submit (Request request) {
        FilePlan plan;
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

    FilePlan plan;
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
    EXPECT_EQ (body_file_opens () - before, 2u)
    << "one check-and-hash, one stream";
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
        svr_.Post ("/landed", [this] (const httplib::Request& req, httplib::Response& res) {
            const std::lock_guard<std::mutex> lock (mutex_);
            landed_ = req.body;
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
    const std::string outside    = scratch_.write ("elsewhere/a.bin", "secret");
    Request request              = binary_request (server_->url (), outside);
    request.body.file.unresolved = true;

    FilePlan files (FileAccessPolicy ({ scratch_.dir ("allowed") }));
    const auto outcome = exchange (request, &files);
    EXPECT_EQ (outcome.response.status_code, 0);
    EXPECT_NE (outcome.response.error_message.find (
               "Body file '" + outside + "' was not chosen in the editor"),
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
    request.body.file.unresolved = true;
    request.body.file.file_name  = "upload.bin";

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

/// Counts the uploads that arrived intact.
class CountingServer {
    public:
    explicit CountingServer (std::string expected)
    : expected_ (std::move (expected)) {
        svr_.new_task_queue = vayu::tests::pooled_task_queue (16);
        svr_.Post ("/up", [this] (const httplib::Request& req, httplib::Response& res) {
            hits_.fetch_add (1);
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
    httplib::Server svr_;
    std::thread thread_;
    int port_ = 0;
    std::atomic<int> hits_{ 0 };
    std::atomic<int> intact_{ 0 };
};

constexpr const char* LOAD_DB_PATH = "test_file_body_load.db";

// The plan reads the file; the run's transfers share its bytes. Mutation
// check: route every binary body through the streaming arm of
// `apply_method_and_body` and the open count becomes 1 + iterations.
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
            { "body",
            { { "mode", "binary" }, { "file", { { "src", src }, { "unresolved", false } } } } } };

        auto built = build_request (config, &db, 5000, AuthResolution::Apply);
        ASSERT_TRUE (built.ok) << built.error_message;

        const auto before = body_file_opens ();
        auto files        = std::make_shared<FilePlan> ();
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

// A path a data row binds was chosen by the data set: the bind marks it
// unresolved, and the plan checks each distinct bound path once, naming the row
// at fault. Mutation check: drop the `unresolved = true` in
// `visit_file_strings` (scenario_data.cpp) and row 1 is sent from outside the
// allowed folder; drop the `src` visit and row 0 is refused as an unresolved
// variable.
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
    EXPECT_TRUE (bound.body.file.unresolved);
    EXPECT_TRUE (vayu::core::fill_bound_files (&only_inside, /*tmpl=*/templated, /*request=*/bound)
    .ok);
    EXPECT_EQ (bound.body.file.size, 1u);
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
