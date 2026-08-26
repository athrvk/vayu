/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/mock_server.cpp
 * @brief The collection mock server: an engine-hosted listener that answers a
 *        collection's saved example responses (issue #481 phase 2), plus the
 *        routes that drive it. Lives with the routes for the same reason
 *        inbox.cpp does - the listener needs httplib, which is linked into the
 *        engine and the tests.
 *
 * Phase 1 gave examples somewhere to live; this is what they are *for*. The
 * route table is a start-time snapshot of the collection tree, so the listener
 * thread reads immutable state and the manager's lock never has to be taken
 * from a handler.
 */

#include "vayu/http/mock_server.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/path_template.hpp"
#include "vayu/http/managed_listener.hpp"
#include "vayu/http/routes.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/logger.hpp"

#include <httplib.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <deque>
#include <expected>
#include <format>
#include <set>
#include <string_view>
#include <thread>
#include <unordered_set>

namespace vayu::http {

namespace constants = vayu::core::constants;

namespace {

/// The characters the app's `PATH_TEMPLATE` accepts inside `{ }` (`[\w$-]`) -
/// no dot, deliberately: `{a.b}` is not a path parameter in OpenAPI.
bool is_path_template_char (char ch) {
    const auto c = static_cast<unsigned char> (ch);
    return std::isalnum (c) != 0 || ch == '_' || ch == '$' || ch == '-';
}

std::string trimmed (std::string_view value) {
    const auto begin = value.find_first_not_of (" \t");
    if (begin == std::string_view::npos) {
        return {};
    }
    const auto end = value.find_last_not_of (" \t");
    return std::string (value.substr (begin, end - begin + 1));
}

/// True when @p authority looks like a host rather than the first segment of a
/// relative path: it carries a dot, a port colon, or is `localhost` itself.
/// A stored request URL needs a host to be executable, so this errs towards
/// treating a leading token as one - but `pets` alone stays a path segment.
bool looks_like_authority (std::string_view authority) {
    return authority == "localhost" ||
    authority.find_first_of (".:") != std::string_view::npos;
}

/// `:param` -> `{{param}}`, applied to a whole segment only. Never reached by a
/// scheme (`http://`) or a port (`localhost:3000`) - both live in the authority
/// this runs after.
std::string normalize_colon_segment (const std::string& segment) {
    if (segment.size () < 2 || segment[0] != ':') {
        return segment;
    }
    const std::string_view name = std::string_view (segment).substr (1);
    if (!std::all_of (name.begin (), name.end (), is_path_template_char)) {
        return segment;
    }
    return "{{" + std::string (name) + "}}";
}

} // namespace

std::string normalize_mock_path (const std::string& url) {
    std::string work = trimmed (url);

    // The query and the fragment are not matched on - a mock answers a route,
    // not a query shape.
    if (const auto cut = work.find_first_of ("?#"); cut != std::string::npos) {
        work = work.substr (0, cut);
    }

    // Scheme and host, or the variable standing in for both, name where the
    // real service lives. The mock *is* the host, so they go.
    if (const auto scheme = work.find ("://"); scheme != std::string::npos) {
        const auto slash = work.find ('/', scheme + 3);
        work = slash == std::string::npos ? std::string () : work.substr (slash);
    } else if (work.rfind ("{{", 0) == 0) {
        const auto close = work.find ("}}");
        work = close == std::string::npos ? std::string () : work.substr (close + 2);
    } else if (!work.empty () && work[0] != '/') {
        const auto slash = work.find ('/');
        const std::string_view authority (
        work.data (), slash == std::string::npos ? work.size () : slash);
        if (looks_like_authority (authority)) {
            work = slash == std::string::npos ? std::string () : work.substr (slash);
        }
    }

    work = vayu::core::normalize_path_templates (work);

    // Rebuild from segments: that applies the `:param` rule per whole segment,
    // collapses `//`, drops a trailing slash, and guarantees a leading one.
    std::string out;
    std::size_t start = 0;
    while (start <= work.size ()) {
        const auto slash          = work.find ('/', start);
        const std::string segment = work.substr (
        start, slash == std::string::npos ? std::string::npos : slash - start);
        if (!segment.empty ()) {
            out += '/';
            out += normalize_colon_segment (segment);
        }
        if (slash == std::string::npos) {
            break;
        }
        start = slash + 1;
    }
    return out.empty () ? "/" : out;
}

std::vector<MockPathSegment> mock_path_segments (const std::string& path) {
    std::vector<MockPathSegment> segments;
    std::size_t start = 0;
    while (start <= path.size ()) {
        const auto slash        = path.find ('/', start);
        const std::string piece = path.substr (
        start, slash == std::string::npos ? std::string::npos : slash - start);
        if (!piece.empty ()) {
            MockPathSegment segment;
            const bool templated = piece.size () > 4 && piece.rfind ("{{", 0) == 0 &&
            piece.compare (piece.size () - 2, 2, "}}") == 0;
            segment.templated = templated;
            segment.literal = templated ? piece.substr (2, piece.size () - 4) : piece;
            segments.push_back (std::move (segment));
        }
        if (slash == std::string::npos) {
            break;
        }
        start = slash + 1;
    }
    return segments;
}

// ---------------------------------------------------------------------------
// Payload validation (pure - unit-tested without a listener)
// ---------------------------------------------------------------------------

namespace {

/// Read a bounded integer field, or say why it was refused. Absent and `null`
/// both keep @p out, which the caller seeded with the default.
std::expected<void, MockParseError>
read_bounded_int (const nlohmann::json& json, const char* key, int low, int high, int& out) {
    const auto it = json.find (key);
    if (it == json.end () || it->is_null ()) {
        return {};
    }
    if (!it->is_number_integer () || it->get<int> () < low || it->get<int> () > high) {
        return std::unexpected (MockParseError{ .http_status = 400,
        .code                                                = "bad_request",
        .message                                             = std::format (
        "Invalid '{}': must be an integer between {} and {}", key, low, high) });
    }
    out = it->get<int> ();
    return {};
}

} // namespace

std::expected<MockStartRequest, MockParseError> parse_mock_start (const nlohmann::json& json) {
    if (!json.is_object ()) {
        return std::unexpected (MockParseError{ .http_status = 400,
        .code                                                = "bad_request",
        .message = "Request body must be a JSON object" });
    }

    const auto collection = json.find ("collectionId");
    if (collection == json.end () || !collection->is_string () ||
    collection->get<std::string> ().empty ()) {
        return std::unexpected (MockParseError{ .http_status = 400,
        .code                                                = "bad_request",
        .message =
        "'collectionId' is required and must be a non-empty string" });
    }

    MockStartRequest parsed;
    parsed.collection_id = collection->get<std::string> ();

    if (auto outcome = read_bounded_int (json, "port", 0, 65535, parsed.port); !outcome) {
        return std::unexpected (outcome.error ());
    }
    if (auto outcome = read_bounded_int (json, "latencyMs", 0,
        constants::mock_server::MAX_LATENCY_MS, parsed.latency_ms);
    !outcome) {
        return std::unexpected (outcome.error ());
    }
    if (auto outcome = read_bounded_int (json, "errorRatePct", 0, 100, parsed.error_rate_pct);
    !outcome) {
        return std::unexpected (outcome.error ());
    }
    return parsed;
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

namespace {

/// The enabled header rows of a stored example, in order and with duplicates
/// intact - the reason an example stores an array rather than an object.
std::vector<std::pair<std::string, std::string>> example_headers (const std::string& blob) {
    std::vector<std::pair<std::string, std::string>> out;
    if (blob.empty ()) {
        return out;
    }
    const auto rows = nlohmann::json::parse (blob, nullptr, /*allow_exceptions=*/false);
    if (!rows.is_array ()) {
        return out;
    }
    for (const auto& row : rows) {
        if (!row.is_object ()) {
            continue;
        }
        const auto key = row.find ("key");
        if (key == row.end () || !key->is_string () || key->get<std::string> ().empty ()) {
            continue;
        }
        if (const auto enabled = row.find ("enabled"); enabled != row.end () &&
        enabled->is_boolean () && !enabled->get<bool> ()) {
            continue;
        }
        const auto value = row.find ("value");
        out.emplace_back (key->get<std::string> (),
        (value != row.end () && value->is_string ()) ? value->get<std::string> () : "");
    }
    return out;
}

bool header_is (const std::string& name, const char* wanted) {
    if (name.size () != std::strlen (wanted)) {
        return false;
    }
    return std::equal (name.begin (), name.end (), wanted, [] (char a, char b) {
        return std::tolower (static_cast<unsigned char> (a)) ==
        std::tolower (static_cast<unsigned char> (b));
    });
}

/// The content type an example is served under: its denormalized column, then
/// its own `Content-Type` header, then plain text - never a guess at the body.
std::string example_content_type (const vayu::db::RequestExample& example,
const std::vector<std::pair<std::string, std::string>>& headers) {
    if (!example.content_type.empty ()) {
        return example.content_type;
    }
    for (const auto& [name, value] : headers) {
        if (header_is (name, "content-type")) {
            return value;
        }
    }
    return "text/plain";
}

} // namespace

std::vector<MockRoute>
build_mock_routes (vayu::db::Database& db, const std::string& collection_id) {
    // The whole subtree: an OpenAPI import files its requests under a folder
    // per tag, so a mock reading only direct children would serve nothing.
    std::vector<vayu::db::Collection> all = db.get_collections ();
    std::sort (all.begin (), all.end (), [] (const auto& a, const auto& b) {
        return a.order != b.order ? a.order < b.order : a.id < b.id;
    });

    std::vector<std::string> walk;
    std::deque<std::string> pending{ collection_id };
    std::unordered_set<std::string> seen{ collection_id };
    while (!pending.empty ()) {
        const std::string current = pending.front ();
        pending.pop_front ();
        walk.push_back (current);
        for (const auto& candidate : all) {
            if (candidate.parent_id && *candidate.parent_id == current &&
            seen.insert (candidate.id).second) {
                pending.push_back (candidate.id);
            }
        }
    }

    std::vector<MockRoute> routes;
    for (const auto& id : walk) {
        for (const auto& request : db.get_requests_in_collection (id)) {
            if (routes.size () > constants::mock_server::MAX_ROUTES) {
                return routes; // The caller refuses a table this size; see start().
            }
            MockRoute route;
            route.request_id    = request.id;
            route.request_name  = request.name;
            route.method        = to_string (request.method);
            route.path_template = normalize_mock_path (request.url);
            route.segments      = mock_path_segments (route.path_template);

            const auto examples = db.get_request_examples (request.id);
            if (!examples.empty ()) {
                // The first one, in the order phase 1 made a contract.
                const auto& example    = examples.front ();
                route.has_response     = true;
                route.response.status  = example.status;
                route.response.headers = example_headers (example.headers);
                route.response.body    = example.body;
                route.response.content_type =
                example_content_type (example, route.response.headers);
            }
            routes.push_back (std::move (route));
        }
    }
    return routes;
}

MockMatch resolve_mock_route (const std::vector<MockRoute>& routes,
const std::string& method,
const std::string& path) {
    const auto wanted = mock_path_segments (path);

    MockMatch match;
    std::vector<std::size_t> path_matches;
    for (std::size_t i = 0; i < routes.size (); ++i) {
        const auto& segments = routes[i].segments;
        if (segments.size () != wanted.size ()) {
            continue;
        }
        bool ok = true;
        for (std::size_t s = 0; s < segments.size () && ok; ++s) {
            ok = segments[s].templated || segments[s].literal == wanted[s].literal;
        }
        if (ok) {
            path_matches.push_back (i);
        }
    }

    if (path_matches.empty ()) {
        match.miss = MockMissKind::NoPath;
        return match;
    }

    // Specificity decides, not registration order: `/pets/mine` must beat
    // `/pets/{{petId}}`, otherwise which one answers depends on the order an
    // import happened to write the two requests in.
    std::optional<std::size_t> best;
    std::size_t best_wildcards = 0;
    for (const auto index : path_matches) {
        if (routes[index].method != method) {
            continue;
        }
        const auto wildcards = static_cast<std::size_t> (
        std::count_if (routes[index].segments.begin (), routes[index].segments.end (),
        [] (const MockPathSegment& segment) { return segment.templated; }));
        if (!best || wildcards < best_wildcards) {
            best           = index;
            best_wildcards = wildcards;
        }
    }

    if (!best) {
        match.miss          = MockMissKind::MethodMismatch;
        match.matched_route = path_matches.front ();
        std::set<std::string> methods;
        for (const auto index : path_matches) {
            methods.insert (routes[index].method);
        }
        match.allowed_methods.assign (methods.begin (), methods.end ());
        return match;
    }

    if (!routes[*best].has_response) {
        match.miss          = MockMissKind::NoExample;
        match.matched_route = best;
        return match;
    }

    // `best` carried whole rather than dereferenced and re-wrapped: both fields
    // are the same optional, and the round trip is a dereference that only the
    // `if` above makes safe.
    match.route_index   = best;
    match.matched_route = best;
    return match;
}

namespace {

/// `resolve_mock_route` sets `matched_route` on both of the miss kinds that
/// name a route, which is what makes the index below safe to take. A match
/// built by hand can still break that, and this is what it would cost.
constexpr std::string_view MATCHED_ROUTE_INVARIANT =
"a mock miss kind that names a route carries its index (resolve_mock_route)";

} // namespace

nlohmann::json mock_miss_body (const std::vector<MockRoute>& routes,
const MockMatch& match,
const std::string& method,
const std::string& path) {
    const std::string target = method + " " + path;
    switch (match.miss) {
    case MockMissKind::MethodMismatch: {
        const auto& matched =
        routes[vayu::utils::invariant_value (match.matched_route, MATCHED_ROUTE_INVARIANT)];
        std::string methods;
        for (const auto& allowed : match.allowed_methods) {
            methods += (methods.empty () ? "" : ", ") + allowed;
        }
        return routes::error_body (404,
        target + " - no request matches that method; '" +
        matched.path_template + "' is served for " + methods,
        "mock_method_mismatch");
    }
    case MockMissKind::NoExample: {
        const auto& matched =
        routes[vayu::utils::invariant_value (match.matched_route, MATCHED_ROUTE_INVARIANT)];
        return routes::error_body (501,
        target + " matches request '" + matched.request_name + "', but it has no saved example to serve - import or save one, then restart the mock",
        "mock_no_example");
    }
    case MockMissKind::NoPath:
    default:
        return routes::error_body (404,
        target + " - no request in this collection has that path (" +
        std::to_string (routes.size ()) + " served)",
        "mock_no_route");
    }
}

nlohmann::json mock_server_info_json (const MockServerInfo& info) {
    nlohmann::json out;
    out["mockId"]               = info.mock_id;
    out["collectionId"]         = info.collection_id;
    out["collectionName"]       = info.collection_name;
    out["url"]                  = info.url;
    out["port"]                 = info.port;
    out["latencyMs"]            = info.latency_ms;
    out["errorRatePct"]         = info.error_rate_pct;
    out["routeCount"]           = info.route_count;
    out["routesWithoutExample"] = info.routes_without_example;
    out["createdAt"]            = info.created_at;
    return out;
}

nlohmann::json mock_route_json (const MockRoute& route) {
    nlohmann::json out;
    out["requestId"]   = route.request_id;
    out["requestName"] = route.request_name;
    out["method"]      = route.method;
    out["path"]        = route.path_template;
    out["hasExample"]  = route.has_response;
    out["status"]      = route.has_response ? route.response.status : 0;
    return out;
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

namespace {

/// Whether this completion should be turned into a synthesized 500.
///
/// 0 and 100 are exact by construction rather than by probability, which is
/// what makes them the only rates worth a test. In between, the roll is a
/// splitmix64 of a per-mock counter: decorrelated enough that a run does not
/// see runs of failures, and deterministic enough to have no global RNG state.
bool should_inject_error (int rate_pct, std::atomic<std::uint64_t>& counter) {
    if (rate_pct <= 0) {
        return false;
    }
    if (rate_pct >= 100) {
        return true;
    }
    std::uint64_t x = counter.fetch_add (0x9E3779B97F4A7C15ULL) + 0x9E3779B97F4A7C15ULL;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
    x ^= x >> 31;
    return static_cast<int> (x % 100) < rate_pct;
}

} // namespace

struct MockServerManager::MockServer {
    std::string id;
    std::string collection_id;
    std::string collection_name;
    int port           = 0;
    int latency_ms     = 0;
    int error_rate_pct = 0;
    int64_t created_at = 0;
    /// Built once at start and never written again, so the handler reads it
    /// with no lock at all. A running mock does not hot-reload the collection -
    /// restart it, which is documented and is what keeps this true.
    std::vector<MockRoute> routes;
    int routes_without_example = 0;
    /// Feeds the error-injection roll. Atomic because every pool thread bumps
    /// it; nothing else about a served response is mutable.
    std::atomic<std::uint64_t> served{ 0 };

    /// Declared last so it is destroyed first: the handler reads everything
    /// above it while the accept loop is alive.
    ManagedListener listener;

    MockServerInfo info () const {
        MockServerInfo out;
        out.mock_id         = id;
        out.collection_id   = collection_id;
        out.collection_name = collection_name;
        out.port            = port;
        out.url             = "http://127.0.0.1:" + std::to_string (port);
        out.latency_ms      = latency_ms;
        out.error_rate_pct  = error_rate_pct;
        out.route_count     = static_cast<int> (routes.size ());
        out.routes_without_example = routes_without_example;
        out.created_at             = created_at;
        return out;
    }
};

MockServerManager::MockServerManager () = default;

MockServerManager::~MockServerManager () {
    std::lock_guard<std::mutex> lock (mutex_);
    for (auto& [id, server] : servers_) {
        // A response inside its configured latency is still holding a listener
        // thread, so the join inside stop() waits up to MAX_LATENCY_MS - which
        // is why that bound exists.
        server->listener.stop ();
    }
    servers_.clear ();
}

MockServerManager::StartResult MockServerManager::start (vayu::db::Database& db,
const MockStartRequest& request) {
    StartResult out;

    const auto collection = db.get_collection (request.collection_id);
    if (!collection) {
        out.ok          = false;
        out.http_status = 404;
        out.error_code  = "not_found";
        out.error_message = "Collection '" + request.collection_id + "' not found";
        return out;
    }

    {
        std::lock_guard<std::mutex> lock (mutex_);
        if (servers_.size () >= constants::mock_server::MAX_SERVERS) {
            out.ok            = false;
            out.http_status   = 409;
            out.error_code    = "mock_limit_reached";
            out.error_message = "Already running the maximum of " +
            std::to_string (constants::mock_server::MAX_SERVERS) +
            " mock servers; stop one first";
            return out;
        }
    }

    auto server             = std::make_unique<MockServer> ();
    server->id              = vayu::utils::generate_id ("mock_");
    server->collection_id   = request.collection_id;
    server->collection_name = collection->name;
    server->latency_ms      = request.latency_ms;
    server->error_rate_pct  = request.error_rate_pct;
    server->created_at      = routes::now_ms ();
    server->routes          = build_mock_routes (db, request.collection_id);

    if (server->routes.size () > constants::mock_server::MAX_ROUTES) {
        out.ok            = false;
        out.http_status   = 400;
        out.error_code    = "mock_too_many_routes";
        out.error_message = "Collection '" + collection->name +
        "' has more than " + std::to_string (constants::mock_server::MAX_ROUTES) +
        " requests, past what one mock server holds";
        return out;
    }
    if (server->routes.empty ()) {
        // Loud rather than a listener that 404s everything: a mock of a
        // collection with no requests is never what the caller meant.
        out.ok            = false;
        out.http_status   = 400;
        out.error_code    = "mock_no_requests";
        out.error_message = "Collection '" + collection->name +
        "' (and everything under it) has no requests to serve";
        return out;
    }
    server->routes_without_example =
    static_cast<int> (std::count_if (server->routes.begin (), server->routes.end (),
    [] (const MockRoute& route) { return !route.has_response; }));

    MockServer* raw                    = server.get ();
    httplib::Server::Handler responder = [raw] (const httplib::Request& req,
                                         httplib::Response& res) {
        if (raw->latency_ms > 0) {
            std::this_thread::sleep_for (std::chrono::milliseconds (raw->latency_ms));
        }
        if (should_inject_error (raw->error_rate_pct, raw->served)) {
            res.status = 500;
            res.set_content (
            routes::error_body (500,
            "Injected failure (errorRatePct=" + std::to_string (raw->error_rate_pct) + ")",
            "mock_injected_error")
            .dump (),
            "application/json");
            return;
        }

        const auto match = resolve_mock_route (raw->routes, req.method, req.path);
        if (!match.route_index) {
            const auto body =
            mock_miss_body (raw->routes, match, req.method, req.path);
            res.status = match.miss == MockMissKind::NoExample ? 501 : 404;
            res.set_content (body.dump (), "application/json");
            return;
        }

        const MockRoute& route = raw->routes[*match.route_index];
        res.status             = route.response.status;
        for (const auto& [name, value] : route.response.headers) {
            if (!header_is (name, "content-type")) {
                // Appended rather than set: a repeated `Set-Cookie` is exactly
                // why an example stores its headers as an ordered array.
                res.headers.emplace (name, value);
            }
        }
        if (!route.response.body.empty ()) {
            res.set_content (route.response.body, route.response.content_type);
        } else {
            res.set_header ("Content-Type", route.response.content_type);
        }
    };

    httplib::Server& svr = server->listener.server ();
    // Every method cpp-httplib routes, on every path: the route table decides
    // what answers, not httplib's own matcher.
    svr.Get (".*", responder); // also serves HEAD
    svr.Post (".*", responder);
    svr.Put (".*", responder);
    svr.Patch (".*", responder);
    svr.Delete (".*", responder);
    svr.Options (".*", responder);

    const auto started =
    server->listener.start ("127.0.0.1", request.port, "mock server " + server->id);
    if (started.port <= 0) {
        const std::string where = "127.0.0.1:" +
        (request.port > 0 ? std::to_string (request.port) : std::string ("(any)"));
        out.ok            = false;
        out.http_status   = 409;
        out.error_code    = "mock_bind_failed";
        out.error_message = started.held_by.empty () ?
        "Could not bind " + where + " - the address may be in use or unavailable" :
        "Could not bind " + where + " - " + started.held_by + " is already listening there";
        return out;
    }
    server->port = started.port;

    {
        std::lock_guard<std::mutex> lock (mutex_);
        out.info             = server->info ();
        servers_[server->id] = std::move (server);
    }
    out.ok          = true;
    out.http_status = 200;
    vayu::utils::log_info ("Mock server started: " + out.info.mock_id + " on " +
    out.info.url + " (" + std::to_string (out.info.route_count) + " routes)");
    return out;
}

bool MockServerManager::stop (const std::string& mock_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = servers_.find (mock_id);
    if (it == servers_.end ()) {
        return false;
    }
    // Stop joins every in-flight handler before returning, so once this is done
    // nothing is still reading the record being erased.
    it->second->listener.stop ();
    servers_.erase (it);
    vayu::utils::log_info ("Mock server stopped: " + mock_id);
    return true;
}

std::optional<MockServerInfo> MockServerManager::get (const std::string& mock_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = servers_.find (mock_id);
    if (it == servers_.end ()) {
        return std::nullopt;
    }
    return it->second->info ();
}

std::vector<MockServerInfo> MockServerManager::list () {
    std::lock_guard<std::mutex> lock (mutex_);
    std::vector<MockServerInfo> out;
    out.reserve (servers_.size ());
    for (const auto& [id, server] : servers_) {
        out.push_back (server->info ());
    }
    return out;
}

std::optional<std::vector<MockRoute>> MockServerManager::routes (const std::string& mock_id) {
    std::lock_guard<std::mutex> lock (mutex_);
    auto it = servers_.find (mock_id);
    if (it == servers_.end ()) {
        return std::nullopt;
    }
    return it->second->routes;
}

} // namespace vayu::http

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

namespace vayu::http::routes {

void register_mock_server_routes (RouteContext& ctx) {
    /**
     * POST /mock/start
     * Body: {collectionId (required), port, latencyMs, errorRatePct}.
     * Starts a loopback listener answering the collection tree's saved
     * examples. Returns the started mock: {mockId, collectionId,
     * collectionName, url, port, latencyMs, errorRatePct, routeCount,
     * routesWithoutExample, createdAt}.
     */
    ctx.server.Post (
    "/mock/start", [&ctx] (const httplib::Request& req, httplib::Response& res) {
        nlohmann::json body;
        try {
            body = req.body.empty () ? nlohmann::json::object () :
                                       nlohmann::json::parse (req.body);
        } catch (const std::exception& e) {
            send_error (res, 400, std::string ("Invalid JSON body: ") + e.what ());
            return;
        }
        const auto start = parse_mock_start (body);
        if (!start) {
            const auto& refusal = start.error ();
            vayu::utils::log_warning ("POST /mock/start - " + refusal.message);
            send_error (res, refusal.http_status, refusal.message, refusal.code);
            return;
        }
        try {
            auto result = ctx.mock_server_manager.start (ctx.db, *start);
            if (!result.ok) {
                vayu::utils::log_warning ("POST /mock/start - " + result.error_message);
                send_error (res, result.http_status, result.error_message,
                result.error_code);
                return;
            }
            send_json (res, mock_server_info_json (result.info));
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /mock/start - Error: " + std::string (e.what ()));
            send_error (res, 500, e.what ());
        }
    });

    /**
     * POST /mock/:id/stop
     * Stops the listener and drops the record - a mock holds nothing that
     * outlives its listener, so there is no stopped state to read (unlike an
     * inbox, whose captures are the reason its record survives a stop).
     */
    ctx.server.Post (R"(/mock/([^/]+)/stop)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string mock_id = req.matches[1];
        if (!ctx.mock_server_manager.stop (mock_id)) {
            send_error (res, 404, "Mock server not found");
            return;
        }
        send_json (res, nlohmann::json{ { "mockId", mock_id }, { "stopped", true } });
    });

    /** GET /mock - every running mock server. */
    ctx.server.Get ("/mock", [&ctx] (const httplib::Request&, httplib::Response& res) {
        nlohmann::json data = nlohmann::json::array ();
        for (const auto& info : ctx.mock_server_manager.list ()) {
            data.push_back (mock_server_info_json (info));
        }
        send_json (res, nlohmann::json{ { "data", std::move (data) } });
    });

    /**
     * GET /mock/:id/routes
     * The table the mock is serving - method, path template, and whether the
     * request behind it has an example. This is how "the mock answers 404" gets
     * diagnosed without sending a request per guess.
     */
    ctx.server.Get (R"(/mock/([^/]+)/routes)",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string mock_id = req.matches[1];
        const auto routes         = ctx.mock_server_manager.routes (mock_id);
        if (!routes) {
            send_error (res, 404, "Mock server not found");
            return;
        }
        nlohmann::json data = nlohmann::json::array ();
        for (const auto& route : *routes) {
            data.push_back (mock_route_json (route));
        }
        send_json (res, nlohmann::json{ { "data", std::move (data) } });
    });
}

} // namespace vayu::http::routes
