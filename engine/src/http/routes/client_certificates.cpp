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
 *  1. **A registered entry is usable.** Host shape, port range, the file paths
 *     the declared format calls for, and that format against the file's own
 *     bytes are all checked at write time (`client_cert_rejection`). A path
 *     that is not there - or a PKCS#12 file registered as a PEM pair - fails at
 *     handshake time as an SSL error naming the endpoint, which reads as "the
 *     API is broken" - the misdiagnosis this epic exists to end.
 *  2. **One entry per host+port.** Two rows claiming the same target would make
 *     the certificate presented depend on row order, so the second one is a 409
 *     naming the first rather than a silent shadowing.
 */

#include "vayu/http/routes.hpp"
#include "vayu/http/transport_policy.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/id.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/logger.hpp"

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
RouteResult apply_port_field (const nlohmann::json& json, std::optional<int>& out, bool is_create) {
    if (!json.contains ("port")) {
        if (is_create) {
            out.reset ();
        }
        return {};
    }
    if (json["port"].is_null ()) {
        out.reset ();
        return {};
    }
    if (!json["port"].is_number_integer ()) {
        return route_error (400,
        "Invalid 'port': must be an integer 1..65535, or null for every port");
    }
    out = json["port"].get<int> ();
    return {};
}

/**
 * The 409 for a host+port pair another row already claims, or nullopt.
 *
 * @param self_id The row being updated, which is allowed to keep its own pair.
 */
RouteResult reject_duplicate_target (vayu::db::Database& db,
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
            return route_error (409,
            "A client certificate is already registered for '" + target +
            "' (id " + row.id + "); update or delete that entry instead");
        }
    }
    return {};
}

/// The wire spellings a `certFormat` may take, for the tail of a rejection.
/// Built from `all_client_cert_formats()` so the set accepted and the set
/// advertised cannot drift - the `http_version_valid_list` rule.
std::string cert_format_valid_list () {
    std::string list;
    for (const auto format : vayu::http::all_client_cert_formats ()) {
        if (!list.empty ()) {
            list += ", ";
        }
        list += "'" + std::string (vayu::http::to_string (format)) + "'";
    }
    return list;
}

/**
 * The `certFormat` of a create or update body onto @p out (issue #833).
 *
 * Absent on create is the one place this engine *guesses*, and it guesses from
 * the file rather than from a constant: a user who named a `.p12` gets a
 * PKCS#12 row without having to know the field exists, and a file that says
 * nothing this engine can read falls back to `pem`, which is what every row
 * written before the field existed is. An explicit value is never overridden -
 * `client_cert_rejection` then checks it against the file and refuses a
 * contradiction, so correcting a bad sniff is possible and being wrong is loud.
 *
 * An unrecognised spelling is a 400 rather than the silent ignore
 * `apply_string_field` would give it: an entry quietly registered as PEM
 * because "PKCS12" was not the word we wanted is a handshake failure against
 * the endpoint later.
 */
RouteResult apply_cert_format_field (const nlohmann::json& json,
std::string& out,
std::string_view cert_path,
bool is_create) {
    const auto seed = [&] () {
        const auto sniffed = vayu::http::sniff_client_cert_format (cert_path);
        out                = sniffed ? vayu::http::to_string (*sniffed) :
                                       vayu::http::to_string (vayu::http::ClientCertFormat::Pem);
    };
    if (!json.contains ("certFormat")) {
        if (is_create) {
            seed ();
        }
        return {};
    }
    if (json["certFormat"].is_null ()) {
        seed ();
        return {};
    }
    if (!json["certFormat"].is_string ()) {
        return route_error (400,
        "Invalid 'certFormat': must be a string. Valid values: " + cert_format_valid_list ());
    }
    const std::string candidate = json["certFormat"].get<std::string> ();
    if (!vayu::http::client_cert_format_from_string (candidate)) {
        return route_error (400,
        "Invalid 'certFormat': '" + candidate +
        "' is not a certificate format. Valid values: " + cert_format_valid_list ());
    }
    out = candidate;
    return {};
}

/**
 * The fields of a create or update body onto @p c, under the standard
 * null-vs-absent rule, ending in the shared usability check.
 *
 * The check runs on the *merged* row rather than on the body, which is what
 * makes a PUT that moves only `keyPath` still prove the pair works together.
 */
RouteResult apply_client_certificate_fields (vayu::db::ClientCertificate& c,
const nlohmann::json& json,
bool is_create) {
    if (auto outcome = apply_required_string_field (json, "host", c.host, is_create); !outcome) {
        return outcome;
    }
    // Hosts are stored lower-cased, so a match is a compare rather than a
    // second case-folding rule at every read - see `ClientCertRule::host`.
    c.host = vayu::utils::ascii_lower (c.host);
    if (auto outcome = apply_port_field (json, c.port, is_create); !outcome) {
        return outcome;
    }
    if (auto outcome = apply_required_string_field (json, "certPath", c.cert_path, is_create);
    !outcome) {
        return outcome;
    }
    // After `certPath`, because an absent format is read off that file.
    if (auto outcome = apply_cert_format_field (json, c.cert_format, c.cert_path, is_create);
    !outcome) {
        return outcome;
    }
    // `keyPath` is required for a PEM pair and must be absent for a PKCS#12
    // bundle, so it cannot go through `apply_required_string_field`: what a
    // complete row looks like depends on the format beside it. `null` clears
    // it, which is how an entry moves from PEM to PKCS#12 in one PUT; the
    // "which format needs which file" rule itself stays in
    // `client_cert_rejection`, the one copy both this route and the resolver
    // read.
    if (json.contains ("keyPath")) {
        if (json["keyPath"].is_null ()) {
            c.key_path.clear ();
        } else if (!json["keyPath"].is_string ()) {
            return route_error (400,
            "Invalid 'keyPath': must be a string, or null for a "
            "PKCS#12 entry that carries its own key");
        } else {
            c.key_path = json["keyPath"].get<std::string> ();
        }
    } else if (is_create) {
        c.key_path.clear ();
    }
    // The one field with a default: a key without a passphrase is the common
    // case, so absent on create means "none" and `null` on update clears it.
    apply_string_field (json, "passphrase", c.passphrase, "", is_create);

    // The merged row's format. Unparseable only when the *stored* value is one
    // no route would have written - a hand-edited row - and that is a 400
    // rather than a fallback to `pem`: an update that answered 200 while
    // leaving the row unusable is the silent acceptance this file exists to
    // avoid, and the caller can fix it by naming `certFormat` here.
    const auto format = vayu::http::client_cert_format_from_string (c.cert_format);
    if (!format) {
        return route_error (400,
        "Stored 'certFormat' is '" +
        c.cert_format + "', which is not a certificate format - set it explicitly. Valid values: " +
        cert_format_valid_list ());
    }
    if (const auto rejection = vayu::http::client_cert_rejection (
        c.host, c.port, *format, c.cert_path, c.key_path)) {
        return route_error (400, "Invalid client certificate: " + *rejection);
    }
    return {};
}

} // namespace

/**
 * The check-decide-write of POST /client-certificates, run under the caller's
 * lock: stages a fresh row, proves no other row claims its host and port, and
 * writes it.
 */
static std::pair<int, nlohmann::json> create_client_certificate_locked (vayu::db::Database& db,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    if (auto outcome = reject_client_supplied_id (json); !outcome) {
        return as_response (outcome.error ());
    }

    vayu::db::ClientCertificate c;
    c.id         = vayu::utils::generate_id ("cert_");
    c.created_at = now_ms ();
    c.updated_at = now_ms ();

    if (auto outcome = apply_client_certificate_fields (c, json, /*is_create=*/true); !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = reject_duplicate_target (db, c, /*self_id=*/""); !outcome) {
        return as_response (outcome.error ());
    }

    if (before_write) {
        before_write ();
    }
    db.save_client_certificate (c);
    return { 200, vayu::json::serialize (c) };
}

/**
 * Testable core of POST /client-certificates - **create only**, returning
 * {http_status, json_body}. The engine owns the id (#97), so a body carrying
 * one is a 400.
 *
 * **The check and the write are one lock scope** (#1455, the create-side
 * sibling of #1440): two creates for the same host and port racing each other
 * must not both pass `reject_duplicate_target` before either writes, or two
 * rows end up claiming one target and the certificate presented depends on
 * row order - exactly what the 409 exists to prevent.
 * `update_client_certificate_response`'s doc comment states the identical
 * reasoning for the update side of this invariant; this is the second (not
 * the only) lock scope in the engine that reads the filesystem, for the same
 * reason - `apply_client_certificate_fields`'s usability check reads the
 * first page of the file this create is about to register.
 *
 * @param before_write Test seam, invoked inside the lock scope with the new
 *        row staged and immediately before it is written; see
 *        `update_request_response` for why it is an overload.
 */
std::pair<int, nlohmann::json> create_client_certificate_response (vayu::db::Database& db,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock (
    [&] { result = create_client_certificate_locked (db, json, before_write); });
    return result;
}

std::pair<int, nlohmann::json>
create_client_certificate_response (vayu::db::Database& db, const nlohmann::json& json) {
    return create_client_certificate_response (db, json, nullptr);
}

/**
 * The read-merge-write of PUT /client-certificates/:id, run under the caller's
 * lock.
 */
static std::pair<int, nlohmann::json> update_client_certificate_locked (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    if (auto outcome = reject_mismatched_body_id (json, id); !outcome) {
        return as_response (outcome.error ());
    }
    auto existing = db.get_client_certificate (id);
    if (!existing) {
        return { 404, error_body (404, "Client certificate not found") };
    }

    vayu::db::ClientCertificate c = *existing;
    if (auto outcome = apply_client_certificate_fields (c, json, /*is_create=*/false);
    !outcome) {
        return as_response (outcome.error ());
    }
    if (auto outcome = reject_duplicate_target (db, c, /*self_id=*/id); !outcome) {
        return as_response (outcome.error ());
    }
    c.updated_at = now_ms ();

    if (before_write) {
        before_write ();
    }
    db.save_client_certificate (c);
    return { 200, vayu::json::serialize (c) };
}

/**
 * Testable core of PUT /client-certificates/:id - **update only**
 * (merge-patch), returning {http_status, json_body}. A missing id is a 404
 * rather than a silent create, like every other resource.
 *
 * **The read, the merge and the write are one lock scope** (#1440), for the
 * reason `update_request_response` states. This resource has a second stake in
 * it: `reject_duplicate_target` proves no other row claims this host and port,
 * and that proof is only worth as much as the window between it and the write -
 * two PUTs converging on one target from either side of it would both pass and
 * leave the presented certificate decided by row order, the state the 409
 * exists to prevent.
 *
 * It is also one of the two lock scopes in the engine that touch the
 * filesystem (the other being this file's own create, #1455):
 * `client_cert_rejection` stats the paths and reads the first page of the
 * certificate to catch a `.p12` registered as a PEM pair. That check reads the
 * *merged* row, which is why it cannot be hoisted out - and moving it out
 * anyway would only trade this bounded read for a window between the check and
 * the write it exists to guard. Bounded, local, and one page per path; see
 * `docs/engine/architecture.md`, which names both as the exception to the rule
 * that a file read stays outside.
 *
 * @param before_write Test seam, invoked inside the lock scope with the merged
 *        row staged and immediately before it is written; see
 *        `update_request_response` for why it is an overload.
 */
std::pair<int, nlohmann::json> update_client_certificate_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json,
const std::function<void ()>& before_write) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        result = update_client_certificate_locked (db, id, json, before_write);
    });
    return result;
}

std::pair<int, nlohmann::json> update_client_certificate_response (vayu::db::Database& db,
const std::string& id,
const nlohmann::json& json) {
    return update_client_certificate_response (db, id, json, nullptr);
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
     * certPath (required), certFormat ('pem' | 'p12', read off the file when
     * absent), keyPath (required for 'pem', refused for 'p12'), passphrase.
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
