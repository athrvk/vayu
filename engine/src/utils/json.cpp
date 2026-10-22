/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file utils/json.cpp
 * @brief JSON utilities implementation
 */

#include "vayu/utils/json.hpp"

#include <algorithm>
#include <functional>
#include <ostream>
#include <sstream>
#include <string_view>
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/core/path_template.hpp"
#include "vayu/core/query_encoding.hpp"
#include "vayu/http/default_headers.hpp"
#include "vayu/http/file_access_policy.hpp"
#include "vayu/http/form_body.hpp"
#include "vayu/http/header_names.hpp"
#include "vayu/http/target_policy.hpp"
#include "vayu/utils/encoding.hpp"
#include "vayu/utils/log_redact.hpp"
#include "vayu/utils/text_escape.hpp"

namespace vayu::json {

// ============================================================================
// Parsing
// ============================================================================

Result<Json> parse (const std::string& str) {
    try {
        return Json::parse (str);
    } catch (const Json::parse_error& e) {
        return Error{ ErrorCode::InternalError, e.what () };
    }
}

bool is_valid_json (const std::string& str) {
    return Json::accept (str);
}

std::optional<Json> try_parse_body (const std::string& body) {
    if (body.empty ()) {
        return std::nullopt;
    }
    try {
        return std::make_optional (Json::parse (body));
    } catch (...) {
        return std::nullopt;
    }
}

// ============================================================================
// Request Serialization
// ============================================================================

namespace {

// A text field with no content type serializes exactly as it always did - the
// file members are emitted only for a file part, `contentType` only when set
// (a text part carries one too, #2539) - so a stored body that has neither
// round-trips byte-identically through this.
Json serialize_form_fields (const std::vector<FormField>& fields) {
    Json out = Json::array ();
    for (const auto& field : fields) {
        Json entry{ { "key", field.key }, { "value", field.value },
            { "enabled", field.enabled } };
        if (field.type == FormFieldType::File) {
            entry["type"] = "file";
            entry["src"]  = field.src;
            if (!field.file_name.empty ()) {
                entry["fileName"] = field.file_name;
            }
        }
        if (!field.content_type.empty ()) {
            entry["contentType"] = field.content_type;
        }
        out.push_back (std::move (entry));
    }
    return out;
}

// A binary body's file reference. The plan-time members (`inline_bytes`,
// `sha256`, `size`, `approved`) are engine-internal and never leave it.
Json serialize_file_ref (const FileRef& file) {
    Json out{ { "src", file.src } };
    if (!file.file_name.empty ()) {
        out["fileName"] = file.file_name;
    }
    if (!file.content_type.empty ()) {
        out["contentType"] = file.content_type;
    }
    return out;
}

} // namespace

Json serialize (const Request& request) {
    Json json;

    json["method"] = to_string (request.method);
    json["url"]    = request.url;

    if (!request.headers.empty ()) {
        json["headers"] = serialize_header_lines (request.headers.lines ());
    }

    if (request.body.mode != BodyMode::None) {
        Json body_json;

        switch (request.body.mode) {
        case BodyMode::Json:
            body_json["mode"] = "json";
            // Try to parse as JSON for proper nesting
            if (auto parsed = try_parse_body (request.body.content)) {
                body_json["content"] = *parsed;
            } else {
                body_json["content"] = request.body.content;
            }
            break;
        case BodyMode::Text:
            body_json["mode"]    = "text";
            body_json["content"] = request.body.content;
            break;
        // The two form modes are emitted under the spelling every client
        // produces (the renderer, the importers, the curl parser) and carry
        // `fields`, so a serialized body parses back to the same request.
        case BodyMode::Form:
            body_json["mode"]   = "x-www-form-urlencoded";
            body_json["fields"] = serialize_form_fields (request.body.fields);
            break;
        case BodyMode::FormData:
            body_json["mode"]   = "form-data";
            body_json["fields"] = serialize_form_fields (request.body.fields);
            break;
        case BodyMode::Binary:
            body_json["mode"] = "binary";
            body_json["file"] = serialize_file_ref (request.body.file);
            break;
        case BodyMode::GraphQL:
            body_json["mode"]    = "graphql";
            body_json["content"] = request.body.content;
            break;
        // Stored as the string the user wrote, never as re-serialized JSON: the
        // envelope is completed at wire time (`jsonrpc_body.hpp`), so a
        // round-trip through storage that reformatted it would change bytes the
        // user never edited - and a body still holding `{{tokens}}` is not JSON
        // to re-serialize in the first place.
        case BodyMode::JsonRpc:
            body_json["mode"]    = "jsonrpc";
            body_json["content"] = request.body.content;
            break;
        // Verbatim, like every other text mode: an XML body reaches the wire as
        // the bytes the user wrote (`wire_body_bytes` has no case for it), so
        // storage must not reformat what sending will not.
        case BodyMode::Xml:
            body_json["mode"]    = "xml";
            body_json["content"] = request.body.content;
            break;
        default: break;
        }

        json["body"] = body_json;
    }

    json["timeout"]         = request.timeout_ms;
    json["followRedirects"] = request.follow_redirects;
    json["maxRedirects"]    = request.max_redirects;
    json["verifySSL"]       = request.verify_ssl;
    json["httpVersion"]     = to_string (request.http_version);

    return json;
}

Json serialize (const vayu::db::Run& run) {
    Json json;
    json["id"]        = run.id;
    json["type"]      = to_string (run.type);
    json["status"]    = to_string (run.status);
    json["startTime"] = run.start_time;
    json["endTime"]   = run.end_time;
    // Try to parse configSnapshot as JSON if possible, otherwise string
    if (auto parsed = try_parse_body (run.config_snapshot)) {
        json["configSnapshot"] = *parsed;
    } else {
        json["configSnapshot"] = run.config_snapshot;
    }

    json["requestId"] =
    run.request_id.has_value () ? Json (run.request_id.value ()) : Json (nullptr);
    json["environmentId"] = run.environment_id.has_value () ?
    Json (run.environment_id.value ()) :
    Json (nullptr);
    // Emitted on the single-run payload as well as the list row, so a client
    // that opened a run directly can draw its pin without re-listing.
    json["baseline"] = run.baseline;
    json["origin"]   = serialize_run_origin (run);
    return json;
}

Json serialize_run_origin (const vayu::db::Run& run) {
    return Json{ { "kind", run.origin },
        { "client", run.origin_client ? Json (*run.origin_client) : Json (nullptr) } };
}

void attach_design_result (nlohmann::json& json,
const vayu::db::Run& run,
const std::vector<vayu::db::Result>& results) {
    if (run.type != vayu::RunType::Design || results.empty ())
        return;

    const auto& result = results.front ();
    nlohmann::json out;
    out["timestamp"]  = result.timestamp;
    out["statusCode"] = result.status_code;
    out["statusText"] = result.status_text;
    out["latencyMs"]  = result.latency_ms;
    if (!result.error.empty ())
        out["error"] = result.error;
    if (!result.trace_data.empty ()) {
        try {
            out["trace"] = nlohmann::json::parse (result.trace_data);
        } catch (...) {
            out["trace"] = result.trace_data;
        }
    }
    json["result"] = out;
}

namespace {

// Cap a base64 `body` by the bytes it decodes to. Four characters carry three
// bytes, so keeping a whole number of groups needs no decode: the prefix of the
// text *is* the encoding of the prefix of the bytes. Every character before the
// padding carries six bits, which is the whole of the decoded-length sum.
void cap_base64_node_body (nlohmann::json& node, size_t max_body_bytes) {
    const auto& text      = node["body"].get_ref<const std::string&> ();
    const size_t unpadded = text.find_last_not_of ('=') + 1; // npos + 1 is 0
    const size_t decoded_bytes = (unpadded * 3) / 4;
    if (decoded_bytes <= max_body_bytes) {
        return;
    }
    const size_t kept_groups = max_body_bytes / 3;
    node["body"]             = text.substr (0, kept_groups * 4);
    node["bodyTruncated"]    = true;
    node["bodyBytes"]        = decoded_bytes;
}

// Cap a single trace node's `body` string in place. Records bodyTruncated +
// bodyBytes (the original length) when the body is cut so a reader can tell a
// stored slice from the whole body.
void cap_node_body (nlohmann::json& node, size_t max_body_bytes) {
    if (!node.is_object () || !node.contains ("body") || !node["body"].is_string ()) {
        return;
    }
    if (node.value ("bodyEncoding", "") == BODY_ENCODING_BASE64) {
        cap_base64_node_body (node, max_body_bytes);
        return;
    }
    const std::string body = node["body"].get<std::string> ();
    if (body.size () > max_body_bytes) {
        node["body"]          = body.substr (0, max_body_bytes);
        node["bodyTruncated"] = true;
        node["bodyBytes"]     = body.size ();
    }
}

// Cap the body half of a request node's `rawRequest`, leaving the header block
// whole.
//
// The stored wire message ends with the same body the `body` field beside it
// carries, so the cap has to reach it too - otherwise a 50 MB POST lands in
// `trace_data` in full through the field that was added last, which is the
// bloat `cap_node_body` exists to bound.
//
// The cut is body-side only, and deliberately so: the header block is the whole
// reason the field is stored (it carries the `Cookie` line libcurl attached),
// and a `maxTraceBodyBytes` smaller than the headers would eat exactly what a
// reader opened the tab for. A message with no blank line has no body to cap
// and is left alone.
//
// No separate truncation marker: the cut lands at the same limit `cap_node_body`
// applies to the node's own `body`, so the `bodyTruncated`/`bodyBytes` pair it
// records already tells a reader this trace's request body is a stored slice.
void cap_node_raw_request (nlohmann::json& node, size_t max_body_bytes) {
    if (!node.is_object () || !node.contains ("rawRequest") ||
    !node["rawRequest"].is_string ()) {
        return;
    }
    const std::string raw = node["rawRequest"].get<std::string> ();

    static constexpr std::string_view HEADER_BODY_SEPARATOR = "\r\n\r\n";
    const size_t separator = raw.find (HEADER_BODY_SEPARATOR);
    if (separator == std::string::npos) {
        return;
    }

    const size_t body_start = separator + HEADER_BODY_SEPARATOR.size ();
    if (raw.size () - body_start > max_body_bytes) {
        node["rawRequest"] = raw.substr (0, body_start + max_body_bytes);
    }
}

} // namespace

void cap_trace_bodies (nlohmann::json& trace, size_t max_body_bytes) {
    if (trace.contains ("request")) {
        cap_node_body (trace["request"], max_body_bytes);
        cap_node_raw_request (trace["request"], max_body_bytes);
    }
    if (trace.contains ("response")) {
        cap_node_body (trace["response"], max_body_bytes);
    }
}

namespace {

/**
 * The `specOperation` value every request serializer emits (issue #637).
 *
 * Shared rather than written twice on purpose: `serialize` backs
 * `GET /requests/:id`, `serialize_to_stream` backs `GET /requests` and the
 * `RequestSummary` overload its `fields=summary` form (#2546), and a
 * field added to one and forgotten in the other is this file's standing trap -
 * the two views of the same row would disagree about whether a request names an
 * operation at all. One reading, called from each.
 *
 * `null` for a column that is NULL and for a blob that no longer parses: the
 * two are the same answer to "which operation is this", and every block around
 * here degrades the same way rather than failing the read it sits in.
 */
Json spec_operation_node (const std::optional<std::string>& stored) {
    if (!stored.has_value () || stored->empty ()) {
        return nullptr;
    }
    try {
        auto parsed = Json::parse (*stored);
        return parsed.is_object () ? parsed : Json (nullptr);
    } catch (const std::exception&) {
        return nullptr;
    }
}

/**
 * The `methodSource` value both request serializers emit (issue #1505), on
 * the `spec_operation_node` precedent above: one reading, called from both,
 * so the single-request and list routes cannot come to disagree about
 * whether `method` still carries an app-written marker. A plain string
 * column, not JSON, so there is nothing here to fail to parse.
 */
Json method_source_node (const std::optional<std::string>& stored) {
    return stored.has_value () ? Json (*stored) : Json (nullptr);
}

/**
 * The `disabledSystemHeaders` array both request serializers emit (issue
 * #1765): the stored column, or `[]` for a value that will not parse as an
 * array of strings - the write route never stores one, so that is a
 * hand-edited row, and an execute default is safer than a refusal.
 */
Json disabled_system_headers_node (const std::string& stored) {
    Json parsed = Json::parse (stored, nullptr, /*allow_exceptions=*/false);
    if (!parsed.is_array ()) {
        return Json::array ();
    }
    for (const auto& name : parsed) {
        if (!name.is_string ()) {
            return Json::array ();
        }
    }
    return parsed;
}

/**
 * The `postmanProtocolBehavior` both request serializers emit (issue #1765):
 * always a key, the stored JSON text itself - a string - when it holds an
 * object, else `null`. Text rather than a parsed object for the reason the
 * importer writes text: this reader's objects do not keep member order, and
 * a client that sends the value back (the app's Duplicate) must write the
 * source's order, which the export then reproduces byte for byte.
 */
Json postman_protocol_behavior_node (const std::optional<std::string>& stored) {
    if (!stored.has_value () || !spec_operation_node (stored).is_object ()) {
        return nullptr;
    }
    return *stored;
}

} // namespace

Json serialize (const vayu::db::SpecDocument& s) {
    Json json;
    json["id"] = s.id;
    // Verbatim, and the whole of it: the Spec tab renders this text, a re-fetch
    // diffs against it, and a validator resolves `$ref`s through it. A cap here
    // would be a truncation nothing downstream could detect - the write path is
    // where the size is refused.
    json["content"] = s.content;
    // Null rather than "" when the document did not come from a URL, so a client
    // can offer "re-fetch" for exactly the documents that have somewhere to
    // re-fetch from.
    json["sourceUrl"] = s.source_url.has_value () ? Json (*s.source_url) : Json (nullptr);
    json["fetchedAt"] = s.fetched_at;
    json["hash"]      = s.hash;
    // The declared-operation index (#629), as the array it was stored as. Null
    // for a document that carries none, so a client can tell "this document was
    // stored before coverage existed" from "this document declares nothing" -
    // an empty array would spell both the same way.
    json["operations"] = Json (nullptr);
    if (!s.operations.empty ()) {
        try {
            auto parsed = Json::parse (s.operations);
            if (parsed.is_array ()) {
                json["operations"] = std::move (parsed);
            }
        } catch (const std::exception&) {
            // @deliberate: an unreadable stored index reads as absent, the same
            // answer every reader of it gives; the write path is where a bad
            // one is refused.
        }
    }
    // The response schema index (#628), on the same null-means-none terms as
    // `operations` above: a client can tell a document stored before schema
    // validation existed from one whose operations declare no schema at all.
    json["responseSchemas"] = Json (nullptr);
    if (!s.response_schemas.empty ()) {
        try {
            auto parsed = Json::parse (s.response_schemas);
            if (parsed.is_object ()) {
                json["responseSchemas"] = std::move (parsed);
            }
        } catch (const std::exception&) {
            // @deliberate: same reading as above - absent, and refused at the
            // write.
        }
    }
    return json;
}

Json serialize_meta (const vayu::db::SpecDocument& s) {
    // Built from the full serialization and *narrowed*, never spelled a second
    // time: two hand-written shapes of one row is how `sourceUrl` comes to be
    // `null` on one read and `""` on the other. A field added above therefore
    // reaches this read too unless it is named here - which is what the erase
    // list is, and what `SpecMetaCarriesTheSameValuesAsTheFullDocument` pins.
    Json json = serialize (s);
    // The three heavy fields, and the only reason this route exists: the
    // document is up to `maxSpecDocumentBytes` and both indexes are extracted
    // from it, so a "metadata" read carrying any of them would transfer what
    // the caller asked not to be sent.
    json.erase ("content");
    json.erase ("operations");
    json.erase ("responseSchemas");
    // Bytes as the engine counts them - `content.size()`, the same measure
    // `spec_size_cap` refuses a write by, so a size shown beside a document and
    // the limit it was stored under are the same unit. SQLite's `length()`
    // would count characters and quietly disagree on any non-ASCII document.
    json["contentBytes"] = s.content.size ();
    return json;
}

Json serialize (const vayu::db::Collection& c) {
    Json json;
    json["id"] = c.id;
    json["parentId"] =
    c.parent_id.has_value () ? Json (c.parent_id.value ()) : Json (nullptr);
    json["name"]        = c.name;
    json["description"] = c.description;
    json["order"]       = c.order;
    json["createdAt"]   = c.created_at;
    json["updatedAt"]   = c.updated_at;

    // Parse collection variables JSON
    if (c.variables.empty ()) {
        json["variables"] = Json::object ();
    } else {
        try {
            json["variables"] = Json::parse (c.variables);
        } catch (const std::exception&) {
            json["variables"] = Json::object ();
        }
    }

    // Parse auth JSON
    if (c.auth.empty ()) {
        json["auth"] = Json::object ({ { "mode", "none" } });
    } else {
        try {
            json["auth"] = Json::parse (c.auth);
        } catch (const std::exception&) {
            json["auth"] = Json::object ({ { "mode", "none" } });
        }
    }

    // Elements (issue #1513, run by issue #1514's pipeline) - the only
    // script source since the cut-over; a migrated collection's scripts are
    // `script.pre` / `script.post` entries here. Neither `preRequestScript`
    // nor `postRequestScript` is emitted any more.
    if (c.elements.empty ()) {
        json["elements"] = Json::array ();
    } else {
        try {
            json["elements"] = Json::parse (c.elements);
        } catch (const std::exception&) {
            json["elements"] = Json::array ();
        }
    }

    // The declared data contract. Same try-parse-with-default block as
    // variables: a row written before the column existed holds "", and an
    // unparseable blob is no more a schema than an absent one.
    if (c.data_schema.empty ()) {
        json["dataSchema"] = Json::object ();
    } else {
        try {
            json["dataSchema"] = Json::parse (c.data_schema);
        } catch (const std::exception&) {
            json["dataSchema"] = Json::object ();
        }
    }

    // The OpenAPI binding (issue #637). Same try-parse-with-default block, and
    // `{}` for the same two cases: a row written before the column existed, and
    // a blob that no longer parses. Both mean "bound to nothing", which is what
    // an empty object says.
    if (c.openapi.empty ()) {
        json["openapi"] = Json::object ();
    } else {
        try {
            json["openapi"] = Json::parse (c.openapi);
        } catch (const std::exception&) {
            json["openapi"] = Json::object ();
        }
    }

    return json;
}

Json serialize (const vayu::db::Request& r, const vayu::http::FileAccessPolicy& files) {
    Json json;
    json["id"]           = r.id;
    json["collectionId"] = r.collection_id;
    json["name"]         = r.name;
    json["description"]  = r.description;
    json["method"]       = to_string (r.method);
    // Always present as a key, `null` when the column is - same rule as
    // `specOperation` below, and for the same reason (issue #1505).
    json["methodSource"] = method_source_node (r.method_source);
    json["url"]          = r.url;
    json["order"]        = r.order;

    // Query params - stored as JSON array of KeyValueEntry
    if (r.params.empty ()) {
        json["params"] = Json::array ();
    } else {
        try {
            json["params"] = Json::parse (r.params);
        } catch (const std::exception&) {
            json["params"] = Json::array ();
        }
    }

    // Headers - stored as JSON array of KeyValueEntry
    if (r.headers.empty ()) {
        json["headers"] = Json::array ();
    } else {
        try {
            json["headers"] = Json::parse (r.headers);
        } catch (const std::exception&) {
            json["headers"] = Json::array ();
        }
    }

    // Body - stored as JSON discriminated union {mode, content?} | {mode, fields?}
    if (r.body.empty ()) {
        json["body"] = Json::object ({ { "mode", "none" } });
    } else {
        try {
            json["body"] = Json::parse (r.body);
        } catch (const std::exception&) {
            json["body"] = Json::object ({ { "mode", "none" } });
        }
    }
    derive_file_trust (json["body"], files);

    json["bodyType"] = r.body_type.empty () ? "none" : r.body_type;

    if (r.auth.empty ()) {
        json["auth"] = Json::object ({ { "mode", "inherit" } });
    } else {
        try {
            json["auth"] = Json::parse (r.auth);
        } catch (const std::exception&) {
            json["auth"] = Json::object ({ { "mode", "inherit" } });
        }
    }

    // Elements (issue #1513, run by issue #1514's pipeline) - the only
    // script source since the cut-over. Neither `preRequestScript` nor
    // `postRequestScript` is emitted any more.
    if (r.elements.empty ()) {
        json["elements"] = Json::array ();
    } else {
        try {
            json["elements"] = Json::parse (r.elements);
        } catch (const std::exception&) {
            json["elements"] = Json::array ();
        }
    }
    json["followRedirects"] = r.follow_redirects;
    json["maxRedirects"]    = r.max_redirects;
    json["httpVersion"]     = r.http_version;
    json["verifySSL"]       = r.verify_ssl;
    json["stream"]          = r.stream;
    // Postman's per-request protocol settings (issue #1765), always emitted
    // like every other execution option.
    json["disableCookies"] = r.disable_cookies;
    json["disabledSystemHeaders"] = disabled_system_headers_node (r.disabled_system_headers);
    json["disableUrlEncoding"] = r.disable_url_encoding;
    json["postmanProtocolBehavior"] =
    postman_protocol_behavior_node (r.postman_protocol_behavior);
    json["mockResponseMode"] = r.mock_response_mode;
    json["mockExampleId"] =
    r.mock_example_id.has_value () ? Json (*r.mock_example_id) : Json (nullptr);
    // Operation identity (issue #637). Always present as a key, `null` when the
    // request declares none - the column is nullable, and a client that has to
    // tell "no operation" from "key not serialized yet" would be guessing. An
    // unparseable blob reads as null for the same reason the blocks above
    // degrade to their defaults.
    json["specOperation"] = spec_operation_node (r.spec_operation);
    json["updatedAt"]     = r.updated_at;
    json["createdAt"]     = r.created_at;
    return json;
}

Json serialize (const vayu::db::RequestSummary& summary) {
    Json json;
    json["id"]            = summary.id;
    json["collectionId"]  = summary.collection_id;
    json["name"]          = summary.name;
    json["method"]        = to_string (summary.method);
    json["url"]           = summary.url;
    json["order"]         = summary.order;
    json["createdAt"]     = summary.created_at;
    json["specOperation"] = spec_operation_node (summary.spec_operation);
    return json;
}

Json serialize (const vayu::db::RequestExample& example) {
    Json json;
    json["id"]        = example.id;
    json["requestId"] = example.request_id;
    json["name"]      = example.name;
    json["status"]    = example.status;

    // Headers - stored as JSON array of KeyValueEntry, same as a request's.
    // An unparseable blob degrades to `[]` exactly as the request serializer
    // does: one bad row must not fail the list read it sits in.
    if (example.headers.empty ()) {
        json["headers"] = Json::array ();
    } else {
        try {
            json["headers"] = Json::parse (example.headers);
        } catch (const std::exception&) {
            json["headers"] = Json::array ();
        }
    }

    json["body"]        = example.body;
    json["contentType"] = example.content_type;
    json["order"]       = example.order;
    json["origin"]      = example.origin;
    // Always present, never inferred from the body's length: only the writer
    // knew the response was cut (issue #659).
    json["bodyTruncated"] = example.body_truncated;
    json["createdAt"]     = example.created_at;
    json["updatedAt"]     = example.updated_at;
    return json;
}

Json serialize (const vayu::db::Environment& e) {
    Json json;
    json["id"]          = e.id;
    json["name"]        = e.name;
    json["description"] = e.description;

    // Safely parse variables JSON with exception handling
    if (e.variables.empty ()) {
        json["variables"] = Json::object ();
    } else {
        try {
            json["variables"] = Json::parse (e.variables);
        } catch (const std::exception&) {
            json["variables"] = Json::object ();
        }
    }

    json["isActive"]  = e.is_active;
    json["updatedAt"] = e.updated_at;
    return json;
}

Json serialize (const vayu::db::ClientCertificate& certificate) {
    Json json;
    json["id"]   = certificate.id;
    json["host"] = certificate.host;
    // `null`, not 0 or an omitted key: "every port" is the absence of a port
    // and the card renders it as such. An omitted key would make a reader
    // unable to tell it from an engine too old to answer.
    if (certificate.port) {
        json["port"] = *certificate.port;
    } else {
        json["port"] = nullptr;
    }
    json["certPath"] = certificate.cert_path;
    // `""`, not null, for a PKCS#12 entry: the field is a path the row does not
    // have rather than a value withheld, and the card renders the empty string
    // as "no key file" without a second case for absence.
    json["keyPath"] = certificate.key_path;
    // What the certificate file is read as (issue #833). Echoed because the
    // card prints it per row - a format stored and never shown would be a
    // guess the user cannot correct.
    json["certFormat"] = certificate.cert_format;
    // Whether the key has a passphrase, never the passphrase - see the header.
    json["hasPassphrase"] = !certificate.passphrase.empty ();
    json["createdAt"]     = certificate.created_at;
    json["updatedAt"]     = certificate.updated_at;
    return json;
}

namespace {

/**
 * One stored variable, field by field.
 *
 * Per-field tolerance is the D17 rule of issue #226, decided once here for
 * every reader: a non-string `value` reads as "" and a non-boolean `enabled`
 * counts as enabled (absent already did). `Json::value()` would instead throw on
 * the first malformed field, and the catch in `parse_variables` then discarded
 * the whole scope - one bad variable silently emptied every other one.
 */
vayu::Variable read_variable (const Json& value) {
    vayu::Variable var;
    if (auto it = value.find ("value"); it != value.end () && it->is_string ()) {
        var.value = it->get<std::string> ();
    }
    if (auto it = value.find ("enabled"); it != value.end () && it->is_boolean ()) {
        var.enabled = it->get<bool> ();
    }
    if (auto it = value.find ("secret"); it != value.end () && it->is_boolean ()) {
        var.secret = it->get<bool> ();
    }
    if (auto it = value.find ("type"); it != value.end () && it->is_string ()) {
        var.type = it->get<std::string> ();
    }
    if (auto it = value.find ("createdAt"); it != value.end () && it->is_number ()) {
        var.created_at = it->get<int64_t> ();
    }
    if (auto it = value.find ("description"); it != value.end () && it->is_string ()) {
        var.description = it->get<std::string> ();
    }
    return var;
}

} // namespace

vayu::Environment parse_variables (const std::string& json_str) {
    vayu::Environment env;
    if (json_str.empty ()) {
        return env;
    }

    try {
        auto json = Json::parse (json_str);
        if (json.is_object ()) {
            for (auto& [key, value] : json.items ()) {
                if (!value.is_object ()) {
                    continue;
                }
                env[key] = read_variable (value);
            }
        }
    } catch (const std::exception&) {
        // @deliberate: a stored variables blob that will not parse reads as an
        // environment with no variables, which is what an environment that
        // declares none reads as too - resolution then leaves every `{{token}}`
        // unresolved, and that is visible to the user rather than substituted.
    }
    return env;
}

std::string serialize_variables (const vayu::Environment& env) {
    Json obj = Json::object ();
    for (const auto& [key, var] : env) {
        obj[key]            = Json::object ();
        obj[key]["value"]   = var.value;
        obj[key]["enabled"] = var.enabled;
        obj[key]["secret"]  = var.secret;
        obj[key]["type"] = var.type.empty () ? std::string{ "string" } : var.type;
        if (var.created_at.has_value ()) {
            obj[key]["createdAt"] = *var.created_at;
        }
        if (!var.description.empty ()) {
            obj[key]["description"] = var.description;
        }
    }
    return obj.dump ();
}

namespace {

/**
 * The file half of a field. `type` is the discriminator and the D17 leniency
 * stops here: an unreadable spelling would silently become a text part carrying
 * an empty value - a part that is on the wire and yet is not the file that was
 * asked for - so anything but the two known values is refused, as is a file part
 * in a mode whose wire form has no file.
 */
std::optional<Error> read_form_field_type (const Json& item, BodyMode mode, FormField& field) {
    if (const auto type = item.find ("type"); type != item.end () && !type->is_null ()) {
        if (!type->is_string ()) {
            return Error{ ErrorCode::InternalError,
                "Body field 'type' must be the string \"text\" or \"file\"" };
        }
        const auto spelling = type->get<std::string> ();
        if (spelling == "file") {
            field.type = FormFieldType::File;
        } else if (spelling != "text") {
            return Error{ ErrorCode::InternalError,
                "Body field 'type' must be \"text\" or \"file\", got \"" + spelling + "\"" };
        }
    }
    if (field.type == FormFieldType::File && mode != BodyMode::FormData) {
        return Error{ ErrorCode::InternalError,
            "A file part is only valid in a 'form-data' body - "
            "'x-www-form-urlencoded' has no file form" };
    }
    return std::nullopt;
}

/**
 * One `fields` entry.
 *
 * A malformed field is refused rather than skipped: this endpoint's whole
 * contract is "send exactly what was built", and a silently dropped field is the
 * failure mode the form modes already had.
 */
Result<FormField> parse_form_field (const Json& item, BodyMode mode) {
    if (!item.is_object ()) {
        return Error{ ErrorCode::InternalError, "Each entry of body 'fields' must be an object" };
    }
    const auto key = item.find ("key");
    if (key == item.end () || !key->is_string ()) {
        return Error{ ErrorCode::InternalError,
            "Each entry of body 'fields' needs a string 'key'" };
    }

    FormField field;
    field.key = key->get<std::string> ();
    if (const auto value = item.find ("value"); value != item.end () && value->is_string ()) {
        field.value = value->get<std::string> ();
    }
    if (const auto enabled = item.find ("enabled");
    enabled != item.end () && enabled->is_boolean ()) {
        field.enabled = enabled->get<bool> ();
    }

    if (auto refusal = read_form_field_type (item, mode, field)) {
        return *refusal;
    }
    for (const auto& [name, target] :
    { std::pair<const char*, std::string*>{ "src", &field.src },
    { "fileName", &field.file_name }, { "contentType", &field.content_type } }) {
        const auto member = item.find (name);
        if (member == item.end () || member->is_null ()) {
            continue;
        }
        if (!member->is_string ()) {
            return Error{ ErrorCode::InternalError,
                std::string{ "Body field '" } + name + "' must be a string" };
        }
        *target = member->get<std::string> ();
    }
    // A text part carrying a file's source is ambiguous in the one direction
    // that matters: the caller pointed at a file and nothing would send it.
    if (field.type == FormFieldType::Text && !field.src.empty ()) {
        return Error{ ErrorCode::InternalError,
            "Body field '" + field.key +
            "' has a 'src' but is not a file part - set 'type' to \"file\"" };
    }
    return field;
}

// The `fields` half of a body, for the two form modes.
//
// A malformed field is refused rather than skipped: this endpoint's whole
// contract is "send exactly what was built", and a silently dropped field is
// the failure mode the form modes already had. The leniency that does exist
// mirrors the D17 rules `parse_variables` applies to the same client shape -
// an absent or non-boolean `enabled` means enabled, a non-string `value` means
// "" - because those are the values a client can produce without meaning
// anything by them. A field with no usable `key` has no wire form at all, so
// it is an error.
Result<std::vector<FormField>> parse_form_fields (const Json& body_json, BodyMode mode) {
    const bool is_form = vayu::http::is_form_mode (mode);
    const auto entry   = body_json.find ("fields");

    if (entry == body_json.end () || entry->is_null ()) {
        if (is_form) {
            // The mode says the content is a field list and there is none.
            // Before this was an error the request went out with an empty
            // body, which is the same wrongness without the message.
            return Error{ ErrorCode::InternalError,
                "Body mode 'x-www-form-urlencoded'/'form-data' requires a "
                "'fields' array" };
        }
        return std::vector<FormField>{};
    }

    if (!is_form) {
        return Error{ ErrorCode::InternalError,
            "Body 'fields' is only valid for the 'x-www-form-urlencoded' and "
            "'form-data' modes" };
    }
    if (!entry->is_array ()) {
        return Error{ ErrorCode::InternalError, "Body 'fields' must be an array" };
    }

    std::vector<FormField> fields;
    fields.reserve (entry->size ());
    for (const auto& item : *entry) {
        auto field = parse_form_field (item, mode);
        if (field.is_error ()) {
            return field.error ();
        }
        fields.push_back (std::move (field).value ());
    }
    return fields;
}

/**
 * A `binary` body's `file` object. The mode's whole content is the reference,
 * so a binary body without one is refused rather than sent bodiless - the
 * silent outcome an engine older than this shape produces.
 */
Result<FileRef> parse_file_ref (const Json& body_json) {
    const auto entry = body_json.find ("file");
    if (entry == body_json.end () || !entry->is_object ()) {
        return Error{ ErrorCode::InternalError,
            "A 'binary' body needs a 'file' object naming the file to send" };
    }
    FileRef file;
    for (const auto& [name, target] :
    { std::pair<const char*, std::string*>{ "src", &file.src },
    { "fileName", &file.file_name }, { "contentType", &file.content_type } }) {
        const auto member = entry->find (name);
        if (member == entry->end () || member->is_null ()) {
            continue;
        }
        if (!member->is_string ()) {
            return Error{ ErrorCode::InternalError,
                std::string{ "Body file '" } + name + "' must be a string" };
        }
        *target = member->get<std::string> ();
    }
    return file;
}

/// The structured halves of a body whose `mode` is already read: the form
/// modes' `fields` and the binary mode's `file`.
std::optional<Error> read_body_parts (const Json& body_json, Body& body) {
    auto fields = parse_form_fields (body_json, body.mode);
    if (fields.is_error ()) {
        return fields.error ();
    }
    body.fields = std::move (fields).value ();

    if (body.mode == BodyMode::Binary) {
        auto file = parse_file_ref (body_json);
        if (file.is_error ()) {
            return file.error ();
        }
        body.file = std::move (file).value ();
    } else if (body_json.contains ("file")) {
        return Error{ ErrorCode::InternalError, "Body 'file' is only valid for the 'binary' mode" };
    }
    return std::nullopt;
}

} // namespace

namespace {

/**
 * The `body` object: its mode, its content and its fields.
 *
 * Both spellings of each form mode reach the same enumerator: every client
 * produces the long one ("x-www-form-urlencoded", "form-data"), while
 * "form"/"formdata" are the engine's own older names, still accepted so a stored
 * or replayed payload keeps working. The table here is the one place a spelling
 * is added - the same rule `read_script`'s list-key/legacy-key pair follows.
 */
std::optional<Error> read_request_body (const Json& json, Request& request) {
    // Body (optional)
    if (json.contains ("body") && json["body"].is_object ()) {
        const auto& body_json = json["body"];

        if (body_json.contains ("mode")) {
            std::string mode = body_json["mode"].get<std::string> ();

            // Both spellings of each form mode reach the same enumerator:
            // every client produces the long one ("x-www-form-urlencoded",
            // "form-data"), while "form"/"formdata" are the engine's own
            // older names, still accepted so a stored or replayed payload
            // keeps working. This table is the one place a spelling is
            // added - same rule as read_script's list-key/legacy-key pair.
            if (mode == "json") {
                request.body.mode = BodyMode::Json;
            } else if (mode == "text") {
                request.body.mode = BodyMode::Text;
            } else if (mode == "form" || mode == "x-www-form-urlencoded") {
                request.body.mode = BodyMode::Form;
            } else if (mode == "formdata" || mode == "form-data") {
                request.body.mode = BodyMode::FormData;
            } else if (mode == "binary") {
                request.body.mode = BodyMode::Binary;
            } else if (mode == "graphql") {
                request.body.mode = BodyMode::GraphQL;
            } else if (mode == "jsonrpc") {
                request.body.mode = BodyMode::JsonRpc;
            } else if (mode == "xml") {
                request.body.mode = BodyMode::Xml;
            }
        }

        if (body_json.contains ("content")) {
            if (body_json["content"].is_string ()) {
                request.body.content = body_json["content"].get<std::string> ();
            } else {
                // Serialize nested JSON
                request.body.content = body_json["content"].dump ();
            }
        }

        if (auto refusal = read_body_parts (body_json, request.body)) {
            return refusal;
        }
    }
    return std::nullopt;
}

/**
 * The default headers this send refuses (issue #1229), as `disabledDefaultHeaders`.
 *
 * Refused rather than dropped when the shape is wrong: a client sending
 * `"User-Agent"` instead of `["User-Agent"]`, or a name that cannot be a header
 * name, is asking for a request it will not get, and the load path has no
 * later gate that would notice. A name the engine adds nothing under is
 * accepted and does nothing, because it says the same thing either way -
 * "do not add this" - and config can switch a default off between the moment a
 * client read the declared set and the moment it sends.
 */
std::optional<Error> read_default_header_opt_outs (const Json& json, Request& request) {
    if (!json.contains ("disabledDefaultHeaders")) {
        return std::nullopt;
    }
    const auto& names = json["disabledDefaultHeaders"];
    if (!names.is_array ()) {
        return Error{ ErrorCode::InternalError,
            "'disabledDefaultHeaders' must be an array of header names" };
    }
    for (const auto& name : names) {
        if (!name.is_string ()) {
            return Error{ ErrorCode::InternalError,
                "'disabledDefaultHeaders' must hold header names as strings" };
        }
        const auto text = name.get<std::string> ();
        // The token rule alone (issue #1765): `unusable_header_name` is the
        // correlation-id validator and refuses `User-Agent`, the one name this
        // list most exists to carry.
        if (auto rejection = vayu::http::invalid_header_token (text)) {
            return Error{ ErrorCode::InternalError, "'disabledDefaultHeaders': " + *rejection };
        }
        request.suppressed_default_headers.insert (text);
    }
    return std::nullopt;
}

/**
 * The request's stored `disabledSystemHeaders` (issue #1765, Postman's own
 * list), unioned into the same set the per-send `disabledDefaultHeaders`
 * fills: both say "do not add this", one for every send of the request and
 * one for this send. Same shape rules and the same refusal.
 */
std::optional<Error> read_disabled_system_headers (const Json& json, Request& request) {
    const auto names = json.find ("disabledSystemHeaders");
    if (names == json.end () || names->is_null ()) {
        return std::nullopt;
    }
    if (!names->is_array ()) {
        return Error{ ErrorCode::InternalError,
            "'disabledSystemHeaders' must be an array of header names" };
    }
    for (const auto& name : *names) {
        if (!name.is_string ()) {
            return Error{ ErrorCode::InternalError,
                "'disabledSystemHeaders' must hold header names as strings" };
        }
        const auto text = name.get<std::string> ();
        if (auto rejection = vayu::http::invalid_header_token (text)) {
            return Error{ ErrorCode::InternalError, "'disabledSystemHeaders': " + *rejection };
        }
        request.suppressed_default_headers.insert (text);
    }
    return std::nullopt;
}

/**
 * `bodyModeHeaders` (issue #1765): the names of headers the request carries
 * only because its body mode wrote them - a stored row marked
 * `source: "body-mode"`, the Body panel's Content-Type or the one an importer
 * adds for a GraphQL, JSON-RPC or XML body. Such a header is a system header
 * in Postman's sense, not a declaration, so a refused name drops it here and
 * the header builder then treats the request as declaring none (removing
 * libcurl's own default in its place). A row the user typed carries no
 * marker and is always sent. Read after both opt-out lists, which it consults.
 */
std::optional<Error> drop_refused_body_mode_headers (const Json& json, Request& request) {
    const auto names = json.find ("bodyModeHeaders");
    if (names == json.end () || names->is_null ()) {
        return std::nullopt;
    }
    if (!names->is_array ()) {
        return Error{ ErrorCode::InternalError,
            "'bodyModeHeaders' must be an array of header names" };
    }
    for (const auto& name : *names) {
        if (!name.is_string ()) {
            return Error{ ErrorCode::InternalError,
                "'bodyModeHeaders' must hold header names as strings" };
        }
        const auto text = name.get<std::string> ();
        if (request.suppressed_default_headers.contains (text)) {
            request.headers.erase (text);
        }
    }
    return std::nullopt;
}

/**
 * @p written as the name it is stored under (issue #2467): its surrounding
 * spaces and tabs trimmed, then refused when what is left is not a token
 * (`http/header_names.hpp`). A name that trims to nothing is stored empty, for
 * the empty-name refusal every send already makes.
 */
Result<std::string> stored_header_name (std::string_view written) {
    const std::string name (vayu::http::trim_optional_whitespace (written));
    if (name.empty ()) {
        return name;
    }
    if (auto refusal = vayu::http::invalid_header_name_refusal (name)) {
        return Error{ ErrorCode::InvalidHeaderName, std::move (*refusal) };
    }
    return name;
}

/**
 * `headers`, in either shape (issue #2466): an array of `{"name", "value"}`
 * lines in send order, every one kept, or the older object, one line per name
 * in the object's key order. Names are settled by `stored_header_name`.
 */
std::optional<Error> read_request_headers (const Json& json, Request& request) {
    const auto headers = json.find ("headers");
    if (headers == json.end () || headers->is_null ()) {
        return std::nullopt;
    }
    if (headers->is_object ()) {
        // A JSON object names a header once, and the map this replaced folded
        // two spellings of one name into one: `[]` keeps that (first spelling,
        // last value), where `add` would send both.
        for (const auto& [written, value] : headers->items ()) {
            auto name = stored_header_name (written);
            if (name.is_error ()) {
                return name.error ();
            }
            request.headers[name.value ()] = value.get<std::string> ();
        }
        return std::nullopt;
    }
    if (!headers->is_array ()) {
        return Error{ ErrorCode::InternalError, "'headers' must be an array of {\"name\", \"value\"} lines or an object" };
    }
    for (const auto& line : *headers) {
        const auto name = line.is_object () ? line.find ("name") : line.end ();
        const auto value = line.is_object () ? line.find ("value") : line.end ();
        if (name == line.end () || value == line.end () ||
        !name->is_string () || !value->is_string ()) {
            return Error{ ErrorCode::InternalError,
                "'headers' lines must be objects with a string \"name\" and a "
                "string \"value\"" };
        }
        auto stored = stored_header_name (name->get<std::string> ());
        if (stored.is_error ()) {
            return stored.error ();
        }
        request.headers.add (std::move (stored).value (), value->get<std::string> ());
    }
    return std::nullopt;
}

/** The per-request options, each optional and each with a documented default. */
void read_request_options (const Json& json, Request& request) {
    // Options
    if (json.contains ("timeout")) {
        request.timeout_ms = json["timeout"].get<int> ();
    } else {
        // Use default timeout constant if not specified
        // Note: To use a custom default, specify timeout in the request JSON
        request.timeout_ms = vayu::core::constants::server::DEFAULT_TIMEOUT_MS;
    }
    if (json.contains ("followRedirects")) {
        request.follow_redirects = json["followRedirects"].get<bool> ();
    }
    if (json.contains ("maxRedirects")) {
        request.max_redirects = json["maxRedirects"].get<int> ();
    }
    if (json.contains ("verifySSL")) {
        request.verify_ssl = json["verifySSL"].get<bool> ();
    }
    // Postman's per-request protocol settings (issue #1765). A non-boolean
    // throws and fails the parse, the rule every sibling here follows.
    if (json.contains ("disableCookies") && !json["disableCookies"].is_null ()) {
        request.disable_cookies = json["disableCookies"].get<bool> ();
    }
    if (json.contains ("disableUrlEncoding") && !json["disableUrlEncoding"].is_null ()) {
        request.disable_url_encoding = json["disableUrlEncoding"].get<bool> ();
    }
    if (json.contains ("httpVersion")) {
        // A corrupted or downgraded stored row must not execute as
        // something arbitrary, so an unrecognized *string* coerces to Auto
        // rather than being rejected (rejecting user input is the route
        // layer's job - see routes.hpp).
        //
        // Note POST /execute is the one write path that relies on this
        // coercion instead of validating: POST /runs
        // (normalize_run_http_version) and the requests CRUD
        // (apply_http_version_field) both reject an unrecognized value
        // with a 400. Neither shipped client can send one - the renderer
        // sends a typed union, MCP validates with z.enum - so this is a
        // gap in consistency, not a live hole.
        //
        // A non-string value throws here and fails the whole parse, which
        // is deliberate and matches every sibling field in this block. It
        // is unreachable from storage - db::Request::http_version is a
        // std::string and both serializers emit it as one - so it can only
        // come from a hand-crafted payload, where failing closed with a 400
        // is the right answer.
        auto parsed_version =
        http_version_from_string (json["httpVersion"].get<std::string> ());
        request.http_version = parsed_version.value_or (HttpVersion::Auto);
    }
}

} // namespace

namespace {

bool is_file_part (const Json& field) {
    if (!field.is_object ()) {
        return false;
    }
    const auto type = field.find ("type");
    return type != field.end () && type->is_string () &&
    type->get_ref<const std::string&> () == "file";
}

} // namespace

void for_each_file_ref (Json& body, const std::function<void (Json& ref)>& visit) {
    if (!body.is_object ()) {
        return;
    }
    if (const auto file = body.find ("file"); file != body.end () && file->is_object ()) {
        visit (*file);
    }
    const auto fields = body.find ("fields");
    if (fields == body.end () || !fields->is_array ()) {
        return;
    }
    for (Json& field : *fields) {
        if (is_file_part (field)) {
            visit (field);
        }
    }
}

void erase_file_trust (Json& body) {
    for_each_file_ref (body, [] (Json& ref) { ref.erase ("unresolved"); });
}

void derive_file_trust (Json& body, const vayu::http::FileAccessPolicy& files) {
    for_each_file_ref (body, [&files] (Json& ref) {
        const auto src = ref.find ("src");
        if (src == ref.end () || !src->is_string () ||
        src->get_ref<const std::string&> ().empty ()) {
            ref.erase ("unresolved");
            return;
        }
        const std::string& path = src->get_ref<const std::string&> ();
        ref["unresolved"] = path.find ("{{") == std::string::npos && !files.allows (path);
    });
}

Result<Request> deserialize_request (const Json& json) {
    try {
        Request request;

        // Method (required)
        if (!json.contains ("method")) {
            return Error{ ErrorCode::InvalidMethod, "Missing 'method' field" };
        }
        auto method = parse_method (json["method"].get<std::string> ());
        if (!method) {
            return Error{ ErrorCode::InvalidMethod, "Invalid HTTP method" };
        }
        request.method = *method;

        // URL (required)
        if (!json.contains ("url")) {
            return Error{ ErrorCode::InvalidUrl, "Missing 'url' field" };
        }
        request.url = json["url"].get<std::string> ();
        // The `:name` segments composition left for a later pass to fill
        // (issue #1764): the path rows the composed payload still carries.
        if (const auto params = json.find ("params"); params != json.end ()) {
            request.path_variables = vayu::core::pending_path_variables_of (*params);
        }

        if (auto refusal = read_request_headers (json, request)) {
            return *refusal;
        }
        if (auto refusal = read_request_body (json, request)) {
            return *refusal;
        }
        if (auto refusal = read_default_header_opt_outs (json, request)) {
            return *refusal;
        }
        if (auto refusal = read_disabled_system_headers (json, request)) {
            return *refusal;
        }
        if (auto refusal = drop_refused_body_mode_headers (json, request)) {
            return *refusal;
        }
        read_request_options (json, request);


        return request;
    } catch (const std::exception& e) {
        return Error{ ErrorCode::InternalError, e.what () };
    }
}

Result<Request> deserialize_request (const std::string& str) {
    auto json_result = parse (str);
    if (json_result.is_error ()) {
        return json_result.error ();
    }
    return deserialize_request (json_result.value ());
}

// ============================================================================
// Response Serialization
// ============================================================================

Json serialize_header_lines (const std::vector<HeaderLine>& lines) {
    Json out = Json::array ();
    for (const auto& line : lines) {
        out.push_back ({ { "name", line.name }, { "value", line.value } });
    }
    return out;
}

Json serialize_redirects (const std::vector<RedirectHop>& hops) {
    Json out = Json::array ();
    for (const auto& hop : hops) {
        out.push_back ({ { "status", hop.status_code }, { "statusText", hop.status_text },
        { "headerLines", serialize_header_lines (hop.header_lines) } });
    }
    return out;
}

namespace {

/// `serialize`'s `body` for a text body: its parse, or `null` when the caller
/// declined one, the text is past `MAX_PARSED_RESPONSE_BODY_BYTES` (#2544), or
/// it is not JSON. The size is checked first so a large body is never parsed.
Json parsed_body (const std::string& text, bool include_parsed_body) {
    if (!include_parsed_body ||
    text.size () > vayu::core::constants::http::MAX_PARSED_RESPONSE_BODY_BYTES) {
        return nullptr;
    }
    auto parsed = try_parse_body (text);
    return parsed ? std::move (*parsed) : Json (nullptr);
}

} // namespace

Json serialize (const Response& response, bool include_parsed_body) {
    Json json;

    json["status"]      = response.status_code;
    json["statusText"]  = response.status_text;
    json["headers"]     = response.headers;
    json["headerLines"] = serialize_header_lines (response.header_lines);
    // Always present, empty when no redirect was followed: the earlier hops'
    // headers are otherwise gone, since `headers` holds the final hop only
    // (issue #2461).
    json["redirects"] = serialize_redirects (response.redirect_hops);
    // One value per name, for the readers written against it, and every line
    // as sent, in order (issue #2466).
    json["requestHeaders"] = response.request_headers.folded ();
    json["requestHeaderLines"] =
    serialize_header_lines (response.request_headers.lines ());
    json["rawRequest"] = response.raw_request;
    json["bodySize"]   = response.body_size;
    // The negotiated protocol, distinct from the requested `httpVersion` on
    // the Request side (see Response::http_version). "" when nothing was
    // negotiated - not omitted, so a caller reading this field can't confuse
    // "we don't know" with "this key doesn't exist on responses".
    json["httpVersion"] = response.http_version;
    // Always present, like `httpVersion` above and for the same reason: a
    // reader must be able to tell "not downgraded" from "this engine is too old
    // to say". See Response::http_version_downgraded.
    json["httpVersionDowngraded"] = response.http_version_downgraded;

    // Which registry entry's certificate this exchange presented, "" when none
    // (issue #707). Always present, like the two above and for the same reason:
    // "no certificate was used" and "this engine cannot say" are different
    // facts. `build_result_trace` writes the same value under the same name, so
    // the live pane and a restored one read one field.
    json["clientCertificate"] = response.client_certificate;

    // Decided once, by `response_body_text` (issue #2458): a JSON string holds
    // only UTF-8, so bytes that are not text travel as base64 rather than
    // making the route's dump throw. Always present, like the fields above, so
    // a reader never has to guess which spelling `bodyRaw` is in.
    if (const auto text = response_body_text (response)) {
        std::string raw (*text);
        json["body"]         = parsed_body (raw, include_parsed_body);
        json["bodyRaw"]      = std::move (raw);
        json["bodyEncoding"] = BODY_ENCODING_UTF8;
    } else {
        json["body"]         = nullptr;
        json["bodyRaw"]      = vayu::utils::base64_encode (response.body);
        json["bodyEncoding"] = BODY_ENCODING_BASE64;
    }

    // Whether `body`/`bodyRaw` are a prefix, because the read stopped at
    // `maxDesignResponseBodyBytes` (issue #1157). Always present, like the
    // three fields above and for the same reason: a pane that cannot tell "not
    // capped" from "this engine is too old to say" would have to guess, and
    // guessing wrong shows a cut body as the whole response.
    //
    // Deliberately not called `bodyTruncated`: the stored trace already uses
    // that name for `maxTraceBodyBytes` shortening a body for storage, which a
    // re-send recovers from. This one a re-send reproduces, so the two are
    // different facts and the app says different things about them.
    json["bodyCapped"] = response.body_truncated;

    // Error information (for client-side failures)
    if (response.error_code != vayu::ErrorCode::None) {
        json["errorCode"]    = vayu::to_string (response.error_code);
        json["errorMessage"] = response.error_message;
    }

    // Timing. Same `*Ms` key convention as the stored trace (store_result /
    // load_strategy), so the live response and a restored one need no renaming.
    Json timing;
    timing["totalMs"]     = response.timing.total_ms;
    timing["wireMs"]      = response.timing.wire_ms;
    timing["queueWaitMs"] = response.timing.queue_wait_ms;
    timing["dnsMs"]       = response.timing.dns_ms;
    timing["connectMs"]   = response.timing.connect_ms;
    timing["tlsMs"]       = response.timing.tls_ms;
    timing["firstByteMs"] = response.timing.first_byte_ms;
    timing["downloadMs"]  = response.timing.download_ms;
    json["timing"]        = timing;

    return json;
}

std::optional<std::string_view> response_body_text (const Response& response) {
    std::string_view body = response.body;
    if (response.body_truncated) {
        body = vayu::utils::without_incomplete_utf8_tail (body);
    }
    if (!vayu::utils::is_valid_utf8_text (body)) {
        return std::nullopt;
    }
    return body;
}

std::optional<std::string> response_body_bytes (const Json& answer) {
    std::string raw = answer.value ("bodyRaw", "");
    const std::string encoding =
    answer.value ("bodyEncoding", std::string (BODY_ENCODING_UTF8));
    if (encoding == BODY_ENCODING_UTF8) {
        return raw;
    }
    if (encoding == BODY_ENCODING_BASE64) {
        return vayu::utils::base64_decode (raw);
    }
    return std::nullopt;
}

std::string serialize_string (const Response& response, int indent) {
    return serialize (response).dump (indent);
}

// ============================================================================
// Error Serialization
// ============================================================================

Json serialize (const Error& error) {
    Json json;
    json["error"]["code"]    = to_string (error.code);
    json["error"]["message"] = error.message;
    return json;
}

// ============================================================================
// Pretty Printing
// ============================================================================

namespace {

// ANSI color codes
constexpr const char* RESET   = "\033[0m";
constexpr const char* CYAN    = "\033[36m"; // Keys
constexpr const char* GREEN   = "\033[32m"; // Strings
constexpr const char* YELLOW  = "\033[33m"; // Numbers
constexpr const char* MAGENTA = "\033[35m"; // Booleans/null
constexpr const char* WHITE   = "\033[37m"; // Brackets

/** The escape a colourised dump writes, or nothing when colour is off. */
const char* paint (const char* code, bool color) {
    return color ? code : "";
}

void pretty_print_impl (std::ostringstream& ss, const Json& json, int indent, int current_indent, bool color);

/** An object, one `"key": value` per line. */
void pretty_print_object (std::ostringstream& ss, const Json& json, int indent, int current_indent, bool color) {
    const std::string next_indent_str (static_cast<size_t> (current_indent + indent), ' ');
    ss << paint (WHITE, color) << "{" << paint (RESET, color) << "\n";

    size_t i = 0;
    for (auto& [key, value] : json.items ()) {
        ss << next_indent_str;
        ss << paint (CYAN, color) << "\"" << key << "\"" << paint (RESET, color);
        ss << ": ";
        pretty_print_impl (ss, value, indent, current_indent + indent, color);

        if (++i < json.size ()) {
            ss << ",";
        }
        ss << "\n";
    }

    ss << std::string (static_cast<size_t> (current_indent), ' ')
       << paint (WHITE, color) << "}" << paint (RESET, color);
}

/** An array, one element per line. */
void pretty_print_array (std::ostringstream& ss, const Json& json, int indent, int current_indent, bool color) {
    const std::string next_indent_str (static_cast<size_t> (current_indent + indent), ' ');
    ss << paint (WHITE, color) << "[" << paint (RESET, color) << "\n";

    for (size_t i = 0; i < json.size (); ++i) {
        ss << next_indent_str;
        pretty_print_impl (ss, json[i], indent, current_indent + indent, color);

        if (i < json.size () - 1) {
            ss << ",";
        }
        ss << "\n";
    }

    ss << std::string (static_cast<size_t> (current_indent), ' ')
       << paint (WHITE, color) << "]" << paint (RESET, color);
}

void pretty_print_impl (std::ostringstream& ss, const Json& json, int indent, int current_indent, bool color) {
    if (json.is_object ()) {
        pretty_print_object (ss, json, indent, current_indent, color);
    } else if (json.is_array ()) {
        pretty_print_array (ss, json, indent, current_indent, color);
    } else if (json.is_string ()) {
        ss << paint (GREEN, color) << "\"" << json.get<std::string> () << "\""
           << paint (RESET, color);
    } else if (json.is_number ()) {
        ss << paint (YELLOW, color) << json.dump () << paint (RESET, color);
    } else if (json.is_boolean ()) {
        ss << paint (MAGENTA, color) << (json.get<bool> () ? "true" : "false")
           << paint (RESET, color);
    } else if (json.is_null ()) {
        ss << paint (MAGENTA, color) << "null" << paint (RESET, color);
    }
}
} // namespace

std::string pretty_print (const Json& json, bool color) {
    std::ostringstream ss;
    pretty_print_impl (ss, json, 2, 0, color);
    return ss.str ();
}

// ============================================================================
// Streaming Serialization
// ============================================================================

namespace {

/**
 * One stored JSON column, echoed as the value of @p wire_name.
 *
 * A column that will not parse - or one past the field cap - is written as
 * @p fallback rather than failing the row: the list route streams many rows, and
 * one unreadable column must not cost the caller every other one.
 *
 * Returns true when @p fallback was written because the column was over
 * @p max_field_size, so the caller can name the field in `truncatedFields`
 * (issue #1485) - a column that is merely empty or unparseable is not
 * "truncated" and does not count.
 *
 * @p shape, when set, adjusts the parsed value before it is written; a
 * fallback is written as it stands.
 */
bool write_json_column (std::ostream& out,
const char* wire_name,
const std::string& stored,
const char* fallback,
size_t max_field_size,
const std::function<void (Json&)>& shape = nullptr) {
    out << "\"" << wire_name << "\":";
    if (stored.size () > max_field_size) {
        out << fallback;
        return true;
    }
    if (stored.empty ()) {
        out << fallback;
        return false;
    }
    try {
        Json value = Json::parse (stored);
        if (shape) {
            shape (value);
        }
        out << value.dump ();
    } catch (const std::exception&) {
        out << fallback;
    }
    return false;
}

} // namespace

void serialize_to_stream (const vayu::db::Request& r,
std::ostream& out,
const vayu::http::FileAccessPolicy& files) {
    const size_t max_field_size = vayu::core::constants::json::MAX_FIELD_SIZE;
    std::vector<std::string> truncated_fields;

    out << "{";
    out << "\"id\":" << Json (r.id).dump () << ",";
    out << "\"collectionId\":" << Json (r.collection_id).dump () << ",";
    out << "\"name\":" << Json (r.name).dump () << ",";
    out << "\"description\":" << Json (r.description).dump () << ",";
    out << "\"method\":" << Json (to_string (r.method)).dump () << ",";
    // Through the same `method_source_node` the object serializer uses, so the
    // list route and the single route cannot come to disagree about it.
    out << "\"methodSource\":" << method_source_node (r.method_source).dump () << ",";
    out << "\"url\":" << Json (r.url).dump () << ",";
    out << "\"order\":" << r.order << ",";

    // Query params - JSON array of KeyValueEntry
    if (write_json_column (out, "params", r.params, "[]", max_field_size)) {
        truncated_fields.emplace_back ("params");
    }
    out << ",";

    // Headers - JSON array of KeyValueEntry
    if (write_json_column (out, "headers", r.headers, "[]", max_field_size)) {
        truncated_fields.emplace_back ("headers");
    }
    out << ",";

    // Body - JSON discriminated union, its file trust derived as `serialize` does
    if (write_json_column (out, "body", r.body, "{\"mode\":\"none\"}", max_field_size,
        [&files] (Json& body) { derive_file_trust (body, files); })) {
        truncated_fields.emplace_back ("body");
    }
    out << ",";

    out << "\"bodyType\":" << Json (r.body_type.empty () ? "none" : r.body_type).dump ()
        << ",";

    // Auth - JSON RequestAuth object
    if (write_json_column (out, "auth", r.auth, "{\"mode\":\"inherit\"}", max_field_size)) {
        truncated_fields.emplace_back ("auth");
    }
    out << ",";

    // Elements (issue #1513, run by issue #1514's pipeline) - the only
    // script source since the cut-over.
    if (write_json_column (out, "elements", r.elements, "[]", max_field_size)) {
        truncated_fields.emplace_back ("elements");
    }
    out << ",";
    out << "\"followRedirects\":" << (r.follow_redirects ? "true" : "false") << ",";
    out << "\"maxRedirects\":" << r.max_redirects << ",";
    out << "\"httpVersion\":" << Json (r.http_version).dump () << ",";
    out << "\"verifySSL\":" << (r.verify_ssl ? "true" : "false") << ",";
    out << "\"stream\":" << (r.stream ? "true" : "false") << ",";
    out << "\"disableCookies\":" << (r.disable_cookies ? "true" : "false") << ",";
    out << "\"disabledSystemHeaders\":"
        << disabled_system_headers_node (r.disabled_system_headers).dump () << ",";
    out << "\"disableUrlEncoding\":" << (r.disable_url_encoding ? "true" : "false") << ",";
    out << "\"postmanProtocolBehavior\":"
        << postman_protocol_behavior_node (r.postman_protocol_behavior).dump () << ",";
    out << "\"mockResponseMode\":" << Json (r.mock_response_mode).dump () << ",";
    out << "\"mockExampleId\":"
        << (r.mock_example_id.has_value () ? Json (*r.mock_example_id).dump () : "null")
        << ",";
    // Through the same `spec_operation_node` the object serializer uses, so the
    // list route and the single route cannot come to disagree about it.
    out << "\"specOperation\":" << spec_operation_node (r.spec_operation).dump () << ",";
    out << "\"updatedAt\":" << r.updated_at << ",";
    out << "\"createdAt\":" << r.created_at;
    // Absent, not an empty array, when nothing was substituted (issue #1485) -
    // the same absent-vs-zero rule this report's other optional sections
    // follow, so a reader can tell "checked, nothing over cap" from "field not
    // sent yet" without special-casing an empty list.
    if (!truncated_fields.empty ()) {
        out << ",\"truncatedFields\":" << Json (truncated_fields).dump ();
    }
    out << "}";
}

namespace {

// Cap a config snapshot's `body.content` in place, recording bodyTruncated +
// bodyBytes (the original length) on the `body` object when cut - the same
// sibling-key shape `cap_node_body` records on a trace node, one level down
// here because `content` lives inside `body` rather than being it.
void cap_snapshot_body (nlohmann::json& parsed, size_t max_body_bytes) {
    auto body_it = parsed.find ("body");
    if (body_it == parsed.end () || !body_it->is_object ()) {
        return;
    }
    auto content_it = body_it->find ("content");
    if (content_it == body_it->end () || !content_it->is_string ()) {
        return;
    }
    const std::string content = content_it->get<std::string> ();
    if (content.size () > max_body_bytes) {
        *content_it                 = content.substr (0, max_body_bytes);
        (*body_it)["bodyTruncated"] = true;
        (*body_it)["bodyBytes"]     = content.size ();
    }
}

// A secret value shorter than this is not masked. Two or three characters
// ("v1", "dev", "42") recur in ordinary URL and body text, so masking every
// occurrence would shred the snapshot while withholding nothing a guess could
// not recover.
constexpr size_t kMinMaskedSecretLength = 4;

// Each secret value as the snapshot can hold it: raw, RFC 3986's strict form
// (`url_encode`, what a client escaping a component writes), Postman's query
// form (what composition writes, `encode_query_component`), the JSON string
// escape (a JSON body is stored as text, so `pa"ss` is `pa\"ss` inside it) and
// the XML escapes of character data and of each attribute delimiter. Longest
// first, so a secret that contains another is masked whole rather than around
// the shorter one.
std::vector<std::string> masked_secret_forms (const std::vector<std::string>& values) {
    std::vector<std::string> forms;
    for (const auto& value : values) {
        if (value.size () < kMinMaskedSecretLength) {
            continue;
        }
        forms.push_back (value);
        forms.push_back (vayu::utils::url_encode (value));
        forms.push_back (
        vayu::core::encode_query_component (value, vayu::core::QueryPart::Value));
        forms.push_back (vayu::utils::escape_json_string_content (value));
        for (const char quote : { '\0', '"', '\'' }) {
            forms.push_back (vayu::utils::escape_xml_content (value, quote));
        }
    }
    std::sort (forms.begin (), forms.end (), [] (const std::string& a, const std::string& b) {
        return a.size () != b.size () ? a.size () > b.size () : a < b;
    });
    forms.erase (std::unique (forms.begin (), forms.end ()), forms.end ());
    return forms;
}

// Every string leaf under @p node with each of @p forms replaced by the marker.
// Object keys are left alone: a header or field *name* is not a value.
void mask_secret_values (Json& node, const std::vector<std::string>& forms) {
    if (node.is_string ()) {
        auto& text = node.get_ref<std::string&> ();
        for (const auto& form : forms) {
            for (auto pos = text.find (form); pos != std::string::npos;
            pos = text.find (form, pos + vayu::utils::kRedactedMarker.size ())) {
                text.replace (pos, form.size (), vayu::utils::kRedactedMarker);
            }
        }
        return;
    }
    if (node.is_structured ()) {
        for (auto& child : node) {
            mask_secret_values (child, forms);
        }
    }
}

/**
 * Each header line's value in a payload's `headers`, in either shape (issue
 * #2466): an object's member values, or each `{"name", "value"}` line's
 * `value`. A name is never visited, the same rule `mask_secret_values` keeps
 * for an object key.
 */
void for_each_header_value (Json& headers,
const std::function<void (const std::string& name, Json& value)>& visit) {
    if (headers.is_object ()) {
        for (auto& [name, value] : headers.items ()) {
            visit (name, value);
        }
        return;
    }
    if (!headers.is_array ()) {
        return;
    }
    for (auto& line : headers) {
        const auto name = line.is_object () ? line.find ("name") : line.end ();
        const auto value = line.is_object () ? line.find ("value") : line.end ();
        if (name != line.end () && value != line.end () && name->is_string ()) {
            visit (name->get_ref<const std::string&> (), *value);
        }
    }
}

// The members of a composed payload a resolved `{{variable}}` can land in.
void mask_snapshot_secrets (Json& parsed, const std::vector<std::string>& forms) {
    for (const char* key : { "url", "params" }) {
        if (auto it = parsed.find (key); it != parsed.end ()) {
            mask_secret_values (*it, forms);
        }
    }
    if (auto it = parsed.find ("headers"); it != parsed.end ()) {
        for_each_header_value (*it, [&forms] (const std::string&, Json& value) {
            mask_secret_values (value, forms);
        });
    }
    auto body_it = parsed.find ("body");
    if (body_it == parsed.end () || !body_it->is_object ()) {
        return;
    }
    for (const char* key : { "content", "fields" }) {
        if (auto it = body_it->find (key); it != body_it->end ()) {
            mask_secret_values (*it, forms);
        }
    }
}

// The header an `apikey` auth names, read before `auth` is collapsed to its
// mode, or nothing.
std::vector<std::string> api_key_header_names (const Json& parsed) {
    const auto auth = parsed.find ("auth");
    if (auth == parsed.end () || !auth->is_object () || auth->value ("mode", "") != "apikey") {
        return {};
    }
    const auto key = auth->find ("key");
    if (key == auth->end () || !key->is_string () ||
    key->get_ref<const std::string&> ().empty ()) {
        return {};
    }
    return { key->get<std::string> () };
}

void withhold_credential_headers (Json& parsed, const std::vector<std::string>& extra_names) {
    auto headers = parsed.find ("headers");
    if (headers == parsed.end ()) {
        return;
    }
    for_each_header_value (*headers, [&extra_names] (const std::string& name, Json& value) {
        if (vayu::utils::is_secret_header_name (name, extra_names)) {
            value = std::string (vayu::utils::kRedactedMarker);
        }
    });
}

} // namespace

std::string sanitize_config_snapshot (const std::string& body,
size_t max_body_bytes,
const std::vector<std::string>& secret_values) {
    Json parsed;
    try {
        parsed = Json::parse (body);
    } catch (const std::exception&) {
        return body; // not JSON; store as-is
    }
    if (!parsed.is_object ()) {
        return parsed.dump ();
    }

    // Stored in its own columns (#1817); a second copy here could only disagree.
    parsed.erase ("origin");
    // The caller's per-send host rule (#2521), which governed the send and
    // says nothing about what was sent: never stored.
    parsed.erase (vayu::http::TARGET_POLICY_FIELD);
    if (const auto body_it = parsed.find ("body"); body_it != parsed.end ()) {
        erase_file_trust (*body_it);
    }
    withhold_credential_headers (parsed, api_key_header_names (parsed));
    // Allowlist within the auth subtree: keep only the mode, drop every
    // credential field. Because we keep a fixed key rather than blocking
    // known secret names, no future auth field (client secrets, tokens,
    // private keys) can leak into the persisted snapshot.
    if (auto it = parsed.find ("auth"); it != parsed.end () && it->is_object ()) {
        const std::string mode = it->value ("mode", std::string{ "none" });
        *it                    = Json::object ({ { "mode", mode } });
    }
    // Masked before the cap, which could otherwise cut a secret in two and
    // leave its prefix behind unrecognised.
    mask_snapshot_secrets (parsed, masked_secret_forms (secret_values));
    cap_snapshot_body (parsed, max_body_bytes);
    return parsed.dump ();
}

bool exceeds_depth (const Json& value, size_t max_depth) {
    // Each entry is a container and the level it sits at (the root is level
    // 1); scalars never go on the stack, so a wide array of them costs one
    // pass and no growth.
    std::vector<std::pair<const Json*, size_t>> pending;
    if (value.is_structured ()) {
        pending.emplace_back (&value, 1);
    }
    while (!pending.empty ()) {
        const auto [node, level] = pending.back ();
        pending.pop_back ();
        if (level > max_depth) {
            return true;
        }
        for (const auto& child : *node) {
            if (child.is_structured ()) {
                pending.emplace_back (&child, level + 1);
            }
        }
    }
    return false;
}

} // namespace vayu::json
