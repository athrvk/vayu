#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/db/database.hpp"

#include <cstdint>
#include <expected>
#include <map>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace vayu::http {

/**
 * One segment of a request path, as the route table matches it.
 *
 * A templated segment matches any single non-empty segment; `literal` then
 * holds the template's own name purely so a 404 can say which route nearly
 * matched. Matching is per segment rather than by regex over the whole path,
 * because a template is only ever a *whole* segment in every format Vayu
 * imports - `/pets/{petId}` - and a substring matcher would have `/petsfoo`
 * answering a route for `/pets`.
 */
struct MockPathSegment {
    std::string literal;
    bool templated = false;
};

/** The response one route answers with - a request's first saved example. */
struct MockResponse {
    int status = 200;
    /// In stored order, duplicates intact: an example holds a KeyValueEntry
    /// array precisely so a repeated `Set-Cookie` survives being re-served.
    std::vector<std::pair<std::string, std::string>> headers;
    std::string body;
    std::string content_type;
};

/**
 * One entry of a mock's route table: a stored request, its path template, and
 * the example it answers with.
 *
 * Built once when the mock starts and const thereafter. A running mock does not
 * hot-reload edits to the collection - restart it - which is what makes the
 * table safe to read from a listener thread without a lock.
 */
struct MockRoute {
    std::string request_id;
    std::string request_name;
    /// Upper-cased, as the wire carries it.
    std::string method;
    /// The normalized template, e.g. `/pets/{{petId}}` - what a 404 prints and
    /// what `GET /mock` lists, so a user can see what the mock will answer.
    std::string path_template;
    std::vector<MockPathSegment> segments;
    /// False when the request has no saved example. The route is kept anyway:
    /// "this request matched but has nothing to serve" is a far better answer
    /// than "no such route", and it is the one an import that dropped its
    /// examples produces.
    bool has_response = false;
    MockResponse response;
};

/** Why a request did not match, so the 404 body can say which near-miss it was. */
enum class MockMissKind {
    /// Nothing in the table has this path shape at all.
    NoPath,
    /// The path matches a route, but none of them is registered for this method.
    MethodMismatch,
    /// A route matched, and it has no saved example to answer with.
    NoExample,
};

/** The outcome of resolving one inbound `method + path` against a route table. */
struct MockMatch {
    /// Index into the table, set only when a route matched *and* can answer.
    std::optional<size_t> route_index;
    MockMissKind miss = MockMissKind::NoPath;
    /// For `MethodMismatch`: the methods this path *is* registered for, sorted
    /// and de-duplicated. For `NoExample`: empty - `route_index` is unset but
    /// `matched_route` names the request that has nothing to serve.
    std::vector<std::string> allowed_methods;
    /// The route that matched the path, for the two miss kinds that had one.
    std::optional<size_t> matched_route;
};

/** A started mock server, as `GET /mock` and the start route report it. */
struct MockServerInfo {
    std::string mock_id;
    std::string collection_id;
    std::string collection_name;
    /// `http://127.0.0.1:<port>` - the base a client points at. No trailing
    /// slash: it is concatenated with a path that always has a leading one.
    std::string url;
    int port           = 0;
    int latency_ms     = 0;
    int error_rate_pct = 0;
    /// How many routes the table holds, and how many of those have no example
    /// to serve. The second number is the one that explains an empty-looking
    /// mock, so it is reported rather than left to be discovered per-404.
    int route_count            = 0;
    int routes_without_example = 0;
    int64_t created_at         = 0;
};

/** A validated `POST /mock/start` payload. */
struct MockStartRequest {
    std::string collection_id;
    int port           = 0; // 0 = pick an ephemeral port
    int latency_ms     = 0;
    int error_rate_pct = 0;
};

/**
 * The outcome of validating a payload - the same plain-field shape
 * `InboxParseError` uses, so the parsing cores stay free of the route helpers
 * and testable on their own.
 */
struct MockParseError {
    int http_status = 400;
    std::string code;
    std::string message;
};

/**
 * Validate a `POST /mock/start` payload, and yield the request it describes.
 *
 * `collectionId` is the one required field; every other rejection is loud
 * rather than a fallback to the default, for the reason `parse_inbox_start`
 * gives - a mock quietly serving with no latency when 50000ms was asked for is
 * a listener doing something other than what its caller asked for.
 *
 * There is no `bind`: a mock is loopback-only in v1. Unlike an inbox there is
 * no case for exposing it - it answers with stored example bodies, which can
 * carry whatever a recorded response carried, and the engine has no route auth.
 *
 * The parsed request is the *value*, not an out-parameter: this used to return
 * `std::optional<MockParseError>` with the result written through a reference,
 * so an empty return meant success and a caller could read a half-filled `out`
 * it never checked. `std::expected` makes the request unreachable unless the
 * payload was accepted.
 */
std::expected<MockStartRequest, MockParseError> parse_mock_start (const nlohmann::json& json);

/**
 * Reduce a stored request URL to the path template the mock matches on.
 *
 * A stored URL is whatever the user or an importer wrote: `{{baseUrl}}/pets/1`,
 * `https://api.example.com/pets/{petId}`, `/pets/:petId`. Everything before the
 * path - scheme and host, or a leading `{{var}}` standing in for both - is
 * dropped, since the mock *is* the host; the query and fragment go with it.
 *
 * The three template spellings collapse to one: `{{petId}}`, `{petId}` and
 * `:petId` all normalize to `{{petId}}`. The `{x}` -> `{{x}}` half mirrors the
 * app's `normalizeVars(path, {pathTemplates: true})` exactly, and the two are
 * pinned together by `tests/fixtures/path-template-conformance.json` - the app
 * writes the URLs this function has to read back, so a rule answered two ways
 * is an imported request the mock cannot route.
 */
std::string normalize_mock_path (const std::string& url);

/** Split a normalized path into the segments `resolve_mock_route` matches. */
std::vector<MockPathSegment> mock_path_segments (const std::string& path);

/**
 * Build a mock's route table from a collection and every collection under it.
 *
 * The whole subtree, not one level: an OpenAPI import puts its requests in a
 * folder per tag, so a mock of the root collection that only read direct
 * children would serve nothing at all.
 *
 * Ordered by collection walk then by the request's own `order`, and the first
 * matching route wins ties - so the table is reproducible across restarts
 * rather than dependent on map iteration.
 */
std::vector<MockRoute>
build_mock_routes (vayu::db::Database& db, const std::string& collection_id);

/**
 * Resolve one inbound `method + path` against @p routes.
 *
 * Specificity, not registration order, decides between two matching routes:
 * fewer templated segments wins, so `/pets/mine` beats `/pets/{{petId}}` for
 * `/pets/mine`. Without it the answer would depend on which request an import
 * happened to write first, and a literal route could be permanently shadowed.
 */
MockMatch resolve_mock_route (const std::vector<MockRoute>& routes,
const std::string& method,
const std::string& path);

/** The 404 body a miss answers with - the near-miss is the debugging value. */
nlohmann::json mock_miss_body (const std::vector<MockRoute>& routes,
const MockMatch& match,
const std::string& method,
const std::string& path);

/** The wire shape of a mock, shared by start and list. */
nlohmann::json mock_server_info_json (const MockServerInfo& info);

/** The wire shape of one route, for `GET /mock/:id/routes`. */
nlohmann::json mock_route_json (const MockRoute& route);

/**
 * Owns the engine's collection mock servers (issue #481 phase 2).
 *
 * Each mock is an independent `httplib::Server` on its own thread that answers
 * a collection's saved example responses on the paths its requests describe.
 * The route table is built once at start and never reloaded, so a mock serves a
 * consistent snapshot for its whole life - edit the collection and restart it.
 *
 * Thread-safe. The destructor stops and joins every listener; the handlers read
 * only the immutable route table and the manager's own lock is never taken from
 * one, so a teardown holding it can always join.
 */
class MockServerManager {
    public:
    // Out-of-line because the map holds unique_ptr<MockServer> and MockServer
    // is incomplete here (same reason as InboxManager).
    MockServerManager ();
    ~MockServerManager ();

    MockServerManager (const MockServerManager&)            = delete;
    MockServerManager& operator= (const MockServerManager&) = delete;
    MockServerManager (MockServerManager&&)                 = delete;
    MockServerManager& operator= (MockServerManager&&)      = delete;

    struct StartResult {
        bool ok         = true;
        int http_status = 500;
        std::string error_code;
        std::string error_message;
        MockServerInfo info;
    };

    StartResult start (vayu::db::Database& db, const MockStartRequest& request);

    /**
     * Stop the listener and drop the record.
     *
     * A stop *is* a delete here, unlike an inbox: a mock holds no captured
     * state that would outlive its listener, so a stopped record would list
     * something that answers nothing and can never answer again (the table is
     * a start-time snapshot). Same shape a mock issuer's stop takes.
     *
     * False when no such mock exists.
     */
    bool stop (const std::string& mock_id);

    std::optional<MockServerInfo> get (const std::string& mock_id);
    std::vector<MockServerInfo> list ();

    /// The route table @p mock_id is serving, or nullopt when it does not
    /// exist. Const since start(), so this is a copy of an immutable snapshot.
    std::optional<std::vector<MockRoute>> routes (const std::string& mock_id);

    private:
    struct MockServer;
    std::mutex mutex_;
    std::map<std::string, std::unique_ptr<MockServer>> servers_;
};

} // namespace vayu::http
