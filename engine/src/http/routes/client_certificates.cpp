/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/routes/client_certificates.cpp
 * @brief The client-certificate registry (issue #707).
 *
 * A certificate belongs to a *host*, not to a request, so this is a registry
 * and not a request field: the transfer that needs mTLS is as often a token
 * fetch, a redirect or a script's `pm.sendRequest` as it is the request the
 * user is looking at, and none of those are places anything can be attached.
 * `resolve_transport_policy` reads the whole table into the policy, and
 * `match_client_certificate` picks the entry per transfer.
 *
 * Two rules are enforced here rather than deeper down, because only a route can
 * answer with a status code:
 *
 *  1. **A registered entry is usable.** Host shape, port range and both file
 *     paths are checked at write time (`client_cert_rejection`). A path that is
 *     not there fails at handshake time as an SSL error naming the endpoint,
 *     which reads as "the API is broken" - the misdiagnosis this epic exists to
 *     end.
 *  2. **One entry per host+port.** Two rows claiming the same target would make
 *     the certificate presented depend on row order, so the second one is a 409
 *     naming the first rather than a silent shadowing.
 */

#include "vayu/http/routes.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <string>
#include <utility>

namespace vayu::http::routes {

namespace {

/**
 * The one null-vs-absent rule for `port`, which is nullable rather than
 * defaulted: absent on create and explicit `null` both mean "every port", and
 * absent on update keeps what is stored.
 *
 * A non-integer is a 400 rather than the silent ignore `apply_int_field` gives
 * a scalar with a default. There is no value to fall back to here - a dropped
 * `port` would widen the entry from one port to all of them, which is the
 * opposite of what the client asked for and is invisible until the wrong
 * certificate is presented somewhere else.
 */
std::optional<std::pair<int, nlohmann::json>>
apply_port_field (const nlohmann::json& json, std::optional<int>& out, bool is_create) {
    if (!json.contains ("port")) {
        if (is_create) {
            out.reset ();
        }
        return std::nullopt;
    }
    if (json["port"].is_null ()) {
        out.reset ();
        return std::nullopt;
    }
    if (!json["port"].is_number_integer ()) {
        return std::make_pair (400,
        error_body (400, "Invalid 'port': must be an integer 1..65535, or null for every port"));
    }
    out = json["port"].get<int> ();
    return std::nullopt;
}

/// Hosts are stored lower-cased, so a match is a compare rather than a second
/// case-folding rule at every read - see `ClientCertRule::host`.
std::string lowered (std::string value) {
    std::transform (value.begin (), value.end (), value.begin (),
    [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
    return value;
}

/**
 * The 409 for a host+port pair another row already claims, or nullopt.
 *
 * @param self_id The row being updated, which is allowed to keep its own pair.
 */
std::optional<std::pair<int, nlohmann::json>> reject_duplicate_target (vayu::db::Database& db,
const vayu::db::ClientCertificate& candidate,
const std::string& self_id) {
    for (const auto& row : db.get_client_certificates ()) {
        if (row.id == self_id) {
            continue;
        }
        if (row.host == candidate.host && row.port == candidate.port) {
            const std::string target = candidate.port ?
            candidate.host + ":" + std::to_string (*candidate.port) :
            candidate.host;
            return std::make_pair (409,
            error_body (409,
            "A client certificate is already registered for '" + target +
            "' (id " + row.id + "); update or delete that entry instead"));
        }
    }
    return std::nullopt;
}

/**
 * The fields of a create or update body onto @p c, under the standard
 * null-vs-absent rule, ending in the shared usability check.
 *
 * The check runs on the *merged* row rather than on the body, which is what
 * makes a PUT that moves only `keyPath` still prove the pair works together.
 */
std::optional<std::pair<int, nlohmann::json>> apply_client_certificate_fields (
vayu::db::ClientCertificate& c,
const nlohmann::json& json,
bool is_create) {
    if (auto err = apply_required_string_field (json, "host", c.host, is_create)) {
        return err;
    }
    c.host = lowered (std::move (c.host));
    if (auto err = apply_port_field (json, c.port, is_create)) {
        return err;
    }
    if (auto err = apply_required_string_field (json, "certPath", c.cert_path, is_create)) {
        return err;
    }
    if (auto err = apply_required_string_field (json, "keyPath", c.key_path, is_create)) {
        return err;
    }
    // The one field with a default: a key without a passphrase is the common
    // case, so absent on create means "none" and `null` on update clears it.
    apply_string_field (json, "passphrase", c.passphrase, "", is_create);

    if (const auto rejection =
        vayu::http::client_cert_rejection (c.host, c.port, c.cert_path, c.key_path)) {
        return std::make_pair (
        400, error_body (400, "Invalid client certificate: " + *rejection));
    }
    return std::nullopt;
}

} // namespace

/**
 * Testable core of POST /client-certificates - **create only**, returning
 * {http_status, json_body}. The engine owns the id (#97), so a body carrying
 * one is a 400.
 */
std::pair<int, nlohmann::json>
create_client_certificate_response (vayu::db::Database& db, const nlohmann::json& json) {
    if (auto err = reject_client_supplied_id (json)) {
        return *err;
    }

    vayu::db::ClientCertificate c;
    c.id         = vayu::utils::generate_id ("cert_");
    c.created_at = now_ms ();
    c.updated_at = now_ms ();

    if (auto err = apply_client_certificate_fields (c, json, /*is_create=*/true)) {
        return *err;
    }
    if (auto err = reject_duplicate_target (db, c, /*self_id=*/"")) {
        return *err;
    }

    db.save_client_certificate (c);
    return { 200, vayu::json::serialize (c) };
}

/**
 * Testable core of PUT /client-certificates/:id - **update only**
 * (merge-patch), returning {http_status, json_body}. A missing id is a 404
 * rather than a silent create, like every other resource.
 */
std::pair<int, nlohmann::json> update_client_certificate_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    if (auto err = reject_mismatched_body_id (json, id)) {
        return *err;
    }
    auto existing = db.get_client_certificate (id);
    if (!existing) {
        return { 404, error_body (404, "Client certificate not found") };
    }

    vayu::db::ClientCertificate c = *existing;
    if (auto err = apply_client_certificate_fields (c, json, /*is_create=*/false)) {
        return *err;
    }
    if (auto err = reject_duplicate_target (db, c, /*self_id=*/id)) {
        return *err;
    }
    c.updated_at = now_ms ();

    db.save_client_certificate (c);
    return { 200, vayu::json::serialize (c) };
}

void register_client_certificate_routes (RouteContext& ctx) {
    /**
     * GET /client-certificates
     * The registry, newest field values as stored. `passphrase` is never
     * echoed - see serialize(ClientCertificate).
     */
    ctx.server.Get ("/client-certificates",
    [&ctx] (const httplib::Request&, httplib::Response& res) {
        auto rows               = ctx.db.get_client_certificates ();
        nlohmann::json response = nlohmann::json::array ();
        for (const auto& row : rows) {
            response.push_back (vayu::json::serialize (row));
        }
        vayu::utils::log_debug ("GET /client-certificates - Returning " +
        std::to_string (rows.size ()) + " entries");
        res.set_content (response.dump (), "application/json");
    });

    /**
     * POST /client-certificates
     * Registers a certificate for a host. Create only.
     * Body params: host (required), port (int or null = every port),
     * certPath (required), keyPath (required), passphrase.
     * Returns: the created entry, 400 (bad shape, unreadable file, body `id`)
     * or 409 (host+port already registered).
     */
    ctx.server.Post ("/client-certificates",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        try {
            auto json = nlohmann::json::parse (req.body);
            auto [status, body] = create_client_certificate_response (ctx.db, json);
            if (status != 200) {
                vayu::utils::log_warning ("POST /client-certificates - " +
                std::to_string (status) + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info (
                "POST /client-certificates - Registered: id=" + body["id"].get<std::string> () +
                ", host=" + body["host"].get<std::string> ());
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "POST /client-certificates - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * PUT /client-certificates/:id
     * Updates an entry (merge-patch: absent keeps, null resets - `port: null`
     * widens the entry to every port, `passphrase: null` clears it). Update
     * only - a missing id is a 404.
     */
    ctx.server.Put (R"(/client-certificates/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        try {
            auto json = nlohmann::json::parse (req.body);
            auto [status, body] = update_client_certificate_response (ctx.db, id, json);
            if (status != 200) {
                vayu::utils::log_warning ("PUT /client-certificates/:id - " +
                std::to_string (status) + " for id=" + id + ": " + error_message_of (body));
            } else {
                vayu::utils::log_info (
                "PUT /client-certificates/:id - Updated: id=" + id);
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error (
            "PUT /client-certificates/:id - Error: " + std::string (e.what ()));
            send_error (res, 400, e.what ());
        }
    });

    /**
     * DELETE /client-certificates/:id
     * Removes an entry. The files it named are untouched - they are the user's,
     * and this registry only ever held the way to find them.
     */
    ctx.server.Delete (R"(/client-certificates/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        vayu::utils::log_info ("DELETE /client-certificates/" + id);

        if (!ctx.db.get_client_certificate (id)) {
            send_error (res, 404, "Client certificate not found");
            return;
        }

        ctx.db.delete_client_certificate (id);
        res.set_content (R"({"success": true})", "application/json");
    });
}

} // namespace vayu::http::routes
