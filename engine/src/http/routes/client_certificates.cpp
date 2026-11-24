/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The client-certificate registry (#707). A certificate belongs to a host, not
 * a request: the transfer needing mTLS is as often a token fetch, a redirect or
 * a script's `pm.sendRequest` as the request on screen, and none of those can
 * carry an attachment. `resolve_transport_policy` reads the whole table and
 * `match_client_certificate` picks an entry per transfer.
 *
 * Two rules live here, not deeper, because only a route answers with a status:
 *
 *  1. **A registered entry is usable.** Host shape, port range, the file paths
 *     the format needs and the format against the file's bytes are checked at
 *     write time (`client_cert_rejection`). A missing path, or a PKCS#12 file
 *     registered as a PEM pair, would fail at handshake as an SSL error naming
 *     the endpoint, read as "the API is broken", the misdiagnosis this epic
 *     exists to end.
 *  2. **One entry per host+port.** Two rows on one target would make the
 *     presented certificate depend on row order, so the second is a 409 naming
 *     the first.
 *
 * A row can become unusable after it was written (its file moved, or an edit
 * around the routes), and the resolver drops it; the list says so per row
 * (`usable`, `problem`) rather than show an entry the engine no longer
 * presents.
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
 * The null-vs-absent rule for `port`, nullable rather than defaulted: absent on
 * create and `null` mean every port, absent on update keeps. A non-integer is a
 * 400, not `apply_int_field`'s silent ignore: there is no fallback, and a
 * dropped `port` would widen the entry to every port, invisibly until the wrong
 * certificate is presented elsewhere.
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
    const auto holder =
    db.client_certificate_for_target (candidate.host, candidate.port, self_id);
    if (!holder) {
        return {};
    }
    return route_error (409,
    "A client certificate is already registered for '" +
    vayu::http::client_cert_label (candidate.host, candidate.port) + "' (id " +
    holder->id + "); update or delete that entry instead");
}

/// The wire spellings `certFormat` may take, for a rejection's tail, built from
/// `all_client_cert_formats ()` so accepted and advertised cannot drift (the
/// `http_version_valid_list` rule).
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
 * A create or update body's `certFormat` onto @p out (#833). Absent on create
 * is the one place this engine guesses, from the file, not a constant: a `.p12`
 * gets a PKCS#12 row without the user knowing the field, and a file it cannot
 * read falls back to `pem`, what every row predating the field is. An explicit
 * value is never overridden: `client_cert_rejection` checks it against the file
 * and refuses a contradiction, so a bad sniff can be corrected and being wrong
 * is loud. An unrecognised spelling is a 400, not `apply_string_field`'s silent
 * ignore: a row quietly registered as PEM over "PKCS12" is a handshake failure
 * later.
 */
RouteResult apply_cert_format_field (const nlohmann::json& json,
std::string& out,
std::string_view cert_path,
bool is_create) {
    const auto seed = [&] () {
        const auto sniffed = vayu::http::sniff_client_cert_format (cert_path);
        out = sniffed ? vayu::http::to_string (*sniffed) :
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
 * A create or update body's fields onto @p c under the null-vs-absent rule,
 * ending in the shared usability check, which runs on the merged row so a PUT
 * moving only `keyPath` still proves the pair works.
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
    // bundle, so not `apply_required_string_field`: a complete row depends on
    // the format. `null` clears it, moving an entry from PEM to PKCS#12 in one
    // PUT; the which-format-needs-which-file rule stays in
    // `client_cert_rejection`, the one copy this route and the resolver read.
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
    if (auto outcome = apply_string_field (json, "passphrase", c.passphrase, "", is_create);
    !outcome) {
        return outcome;
    }

    // The merged row's format, unparseable only for a hand-edited stored value,
    // and then a 400, not a `pem` fallback: a 200 leaving the row unusable is
    // the silent acceptance this file avoids, and naming `certFormat` here
    // fixes it.
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
 * Testable core of GET /client-certificates, {http_status, json_body}: every
 * live row as `serialize` writes it, plus `usable` and, when not, `problem`,
 * judged by `check_client_cert_row`, the check `resolve_transport_policy` drops
 * a row by. Only the list has them: a create or update answers 400 for an
 * unusable row. It reads the files each row names, so it runs outside the
 * database lock: rows first (that call locks), checks after.
 */
std::pair<int, nlohmann::json> list_client_certificates_response (vayu::db::Database& db) {
    nlohmann::json response = nlohmann::json::array ();
    for (const auto& row : db.get_client_certificates ()) {
        nlohmann::json item = vayu::json::serialize (row);
        const auto checked  = vayu::http::check_client_cert_row (row);
        item["usable"]      = checked.has_value ();
        if (!checked) {
            item["problem"] = checked.error ();
        }
        response.push_back (std::move (item));
    }
    return { 200, std::move (response) };
}

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
 * Testable core of POST /client-certificates, **create only**, {http_status,
 * json_body}; the engine owns the id (#97), so a body carrying one is a 400.
 *
 * **The check and the write are one lock scope** (#1455, the create-side
 * sibling of #1440): two creates for one host and port must not both pass
 * `reject_duplicate_target` before either writes, or two rows claim one target
 * and row order picks the certificate. This is one of the two lock scopes in
 * the engine reading the filesystem (`update_client_certificate_response` says
 * why): the usability check reads the first page of the file being registered.
 *
 * @param before_write Test seam, invoked inside the lock scope with the new row
 *        staged and immediately before it is written; see
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

/// The read-merge-write of PUT /client-certificates/:id, run under the caller's
/// lock.
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
 * Testable core of PUT /client-certificates/:id, **update only** (merge-patch),
 * {http_status, json_body}; a missing id is a 404.
 *
 * **The read, the merge and the write are one lock scope** (#1440), for
 * `update_request_response`'s reason and a second: `reject_duplicate_target` is
 * worth only the window between it and the write, and two PUTs converging on
 * one target would both pass and let row order pick the certificate.
 *
 * One of the two lock scopes in the engine touching the filesystem (the other
 * is this file's create, #1455): `client_cert_rejection` stats the paths and
 * reads the certificate's first page to catch a `.p12` registered as PEM. It
 * reads the merged row, so it cannot be hoisted, and moving it out would trade
 * a bounded read for a window between check and write. Bounded, local, one page
 * per path; `docs/engine/architecture.md` names both as the exception to the
 * file-read-outside rule.
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

/**
 * Testable core of DELETE /client-certificates/:id - a soft delete (#2973): the
 * row is stamped, `GET /trash` lists it, the transport policy stops presenting
 * it, and every read here answers 404 for it, a second delete included. The
 * existence check and the stamp are one lock scope, so of two racing deletes
 * only one answers 200.
 */
std::pair<int, nlohmann::json>
delete_client_certificate_response (vayu::db::Database& db, const std::string& id) {
    std::pair<int, nlohmann::json> result{ 500, nlohmann::json::object () };
    db.with_lock ([&] {
        if (!db.get_client_certificate (id)) {
            result = error_response (404, "Client certificate not found");
            return;
        }
        db.delete_client_certificate (id);
        result = { 200, nlohmann::json{ { "success", true } } };
    });
    return result;
}

void register_client_certificate_routes (RouteContext& ctx) {
    /**
     * GET /client-certificates
     * The registry, newest field values as stored. `passphrase` is never
     * echoed - see serialize(ClientCertificate). Each row also says whether the
     * engine would present it (`usable`, and `problem` when not).
     */
    ctx.server.Get ("/client-certificates",
    [&ctx] (const httplib::Request&, httplib::Response& res) {
        const auto [status, body] = list_client_certificates_response (ctx.db);
        vayu::utils::log_debug (
        "http", "Returning " + std::to_string (body.size ()) + " entries");
        res.status = status;
        res.set_content (body.dump (), "application/json");
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
        const auto json = parse_request_json (req.body);
        if (!json) {
            refuse_request_body (res, "POST /client-certificates", json.error ());
            return;
        }
        try {
            auto [status, body] = create_client_certificate_response (ctx.db, *json);
            if (status != 200) {
                vayu::utils::log_warning ("http",
                "POST /client-certificates - " + std::to_string (status) +
                ": " + error_message_of (body));
            } else {
                vayu::utils::log_info ("http", "Registered client certificate",
                { { "id", body["id"].get<std::string> () },
                { "host", body["host"].get<std::string> () } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "POST /client-certificates - Error: " + std::string (e.what ()));
            send_exception (res, e);
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
        const auto json      = parse_request_json (req.body);
        if (!json) {
            refuse_request_body (res, "PUT /client-certificates/:id", json.error ());
            return;
        }
        try {
            auto [status, body] = update_client_certificate_response (ctx.db, id, *json);
            if (status != 200) {
                vayu::utils::log_warning ("http", "PUT /client-certificates/:id failed",
                { { "status", status }, { "id", id }, { "error", error_message_of (body) } });
            } else {
                vayu::utils::log_info ("http",
                "PUT /client-certificates/:id - Updated", { { "id", id } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "PUT /client-certificates/:id - Error: " + std::string (e.what ()));
            send_exception (res, e);
        }
    });

    /**
     * DELETE /client-certificates/:id
     * Moves an entry to the trash (#2973): restorable through
     * `POST /trash/:id/restore` until a purge or retention destroys it, and
     * presented to no host meanwhile. The files it named are untouched - they
     * are the user's, and this registry only ever held the way to find them.
     * Returns: {success: true}, or 404 if no live entry has that id.
     */
    ctx.server.Delete (R"(/client-certificates/([^/]+))",
    [&ctx] (const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        try {
            auto [status, body] = delete_client_certificate_response (ctx.db, id);
            if (status != 200) {
                vayu::utils::log_warning ("http", "DELETE /client-certificates/:id failed",
                { { "status", status }, { "id", id }, { "error", error_message_of (body) } });
            } else {
                vayu::utils::log_info (
                "http", "Deleted client certificate", { { "id", id } });
            }
            res.status = status;
            res.set_content (body.dump (), "application/json");
        } catch (const std::exception& e) {
            vayu::utils::log_error ("http",
            "DELETE /client-certificates/:id - Error: " + std::string (e.what ()));
            send_exception (res, e);
        }
    });
}

} // namespace vayu::http::routes
