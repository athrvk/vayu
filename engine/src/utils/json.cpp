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

#include <ostream>
#include <sstream>
#include <string_view>

#include "vayu/core/constants.hpp"
#include "vayu/http/form_body.hpp"

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

// A text field serializes exactly as it always did - the file members are
// emitted only for a file part, so a stored body that has none round-trips
// byte-identically through this.
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
            if (!field.content_type.empty ()) {
                entry["contentType"] = field.content_type;
            }
        }
        out.push_back (std::move (entry));
    }
    return out;
}

} // namespace

Json serialize (const Request& request) {
    Json json;

    json["method"] = to_string (request.method);
    json["url"]    = request.url;

    if (!request.headers.empty ()) {
        json["headers"] = request.headers;
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
            body_json["mode"]    = "binary";
            body_json["content"] = request.body.content;
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
    return json;
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

// Cap a single trace node's `body` string in place. Records bodyTruncated +
// bodyBytes (the original length) when the body is cut so a reader can tell a
// stored slice from the whole body.
void cap_node_body (nlohmann::json& node, size_t max_body_bytes) {
    if (!node.is_object () || !node.contains ("body") || !node["body"].is_string ()) {
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
 * The `specOperation` value both request serializers emit (issue #637).
 *
 * Shared rather than written twice on purpose: `serialize` backs
 * `GET /requests/:id` and `serialize_to_stream` backs `GET /requests`, and a
 * field added to one and forgotten in the other is this file's standing trap -
 * the two views of the same row would disagree about whether a request names an
 * operation at all. One reading, called from both.
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

    json["preRequestScript"]  = c.pre_request_script;
    json["postRequestScript"] = c.post_request_script;

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

Json serialize (const vayu::db::Request& r) {
    Json json;
    json["id"]           = r.id;
    json["collectionId"] = r.collection_id;
    json["name"]         = r.name;
    json["description"]  = r.description;
    json["method"]       = to_string (r.method);
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

    json["preRequestScript"]  = r.pre_request_script;
    json["postRequestScript"] = r.post_request_script;
    json["followRedirects"]   = r.follow_redirects;
    json["maxRedirects"]      = r.max_redirects;
    json["httpVersion"]       = r.http_version;
    json["verifySSL"]         = r.verify_ssl;
    json["stream"]            = r.stream;
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

} // namespace

namespace {

/**
 * The `body` object: its mode, its content and its fields.
 *
 * Both spellings of each form mode reach the same enumerator: every client
 * produces the long one ("x-www-form-urlencoded", "form-data"), while
 * "form"/"formdata" are the engine's own older names, still accepted so a stored
 * or replayed payload keeps working. The table here is the one place a spelling
 * is added - the same rule `read_post_request_script`'s follows.
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
            // added - same rule as read_post_request_script's.
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

        auto fields = parse_form_fields (body_json, request.body.mode);
        if (fields.is_error ()) {
            return fields.error ();
        }
        request.body.fields = std::move (fields).value ();
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

        // Headers (optional)
        if (json.contains ("headers") && json["headers"].is_object ()) {
            for (auto& [key, value] : json["headers"].items ()) {
                request.headers[key] = value.get<std::string> ();
            }
        }

        if (auto refusal = read_request_body (json, request)) {
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

Json serialize (const Response& response) {
    Json json;

    json["status"]         = response.status_code;
    json["statusText"]     = response.status_text;
    json["headers"]        = response.headers;
    json["requestHeaders"] = response.request_headers;
    json["rawRequest"]     = response.raw_request;
    json["bodySize"]       = response.body_size;
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

    // Try to parse body as JSON
    if (auto parsed = try_parse_body (response.body)) {
        json["body"] = *parsed;
    } else {
        json["body"] = nullptr;
    }
    json["bodyRaw"] = response.body;

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
// Script Result Serialization
// ============================================================================

Json serialize (const ScriptResult& result) {
    Json json;

    json["success"] = result.success;

    Json tests = Json::array ();
    for (const auto& test : result.tests) {
        Json test_json;
        test_json["name"]   = test.name;
        test_json["passed"] = test.passed;
        if (!test.error_message.empty ()) {
            test_json["error"] = test.error_message;
        } else {
            test_json["error"] = nullptr;
        }
        tests.push_back (test_json);
    }
    json["testResults"] = tests;

    Json console = Json::array ();
    for (const auto& entry : result.console_output) {
        console.push_back (
        { { "level", to_string (entry.level) }, { "message", entry.message } });
    }
    json["consoleOutput"] = console;

    if (!result.error_message.empty ()) {
        json["error"] = result.error_message;
    }

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
 */
void write_json_column (std::ostream& out,
const char* wire_name,
const std::string& stored,
const char* fallback,
size_t max_field_size) {
    out << "\"" << wire_name << "\":";
    if (stored.empty () || stored.size () > max_field_size) {
        out << fallback;
        return;
    }
    try {
        out << Json::parse (stored).dump ();
    } catch (const std::exception&) {
        out << fallback;
    }
}

} // namespace

void serialize_to_stream (const vayu::db::Request& r, std::ostream& out) {
    const size_t max_field_size = vayu::core::constants::json::MAX_FIELD_SIZE;

    out << "{";
    out << "\"id\":" << Json (r.id).dump () << ",";
    out << "\"collectionId\":" << Json (r.collection_id).dump () << ",";
    out << "\"name\":" << Json (r.name).dump () << ",";
    out << "\"description\":" << Json (r.description).dump () << ",";
    out << "\"method\":" << Json (to_string (r.method)).dump () << ",";
    out << "\"url\":" << Json (r.url).dump () << ",";
    out << "\"order\":" << r.order << ",";

    // Query params - JSON array of KeyValueEntry
    write_json_column (out, "params", r.params, "[]", max_field_size);
    out << ",";

    // Headers - JSON array of KeyValueEntry
    write_json_column (out, "headers", r.headers, "[]", max_field_size);
    out << ",";

    // Body - JSON discriminated union
    write_json_column (out, "body", r.body, "{\"mode\":\"none\"}", max_field_size);
    out << ",";

    out << "\"bodyType\":" << Json (r.body_type.empty () ? "none" : r.body_type).dump ()
        << ",";

    // Auth - JSON RequestAuth object
    write_json_column (out, "auth", r.auth, "{\"mode\":\"inherit\"}", max_field_size);
    out << ",";

    out << "\"preRequestScript\":" << Json (r.pre_request_script).dump () << ",";
    out << "\"postRequestScript\":" << Json (r.post_request_script).dump () << ",";
    out << "\"followRedirects\":" << (r.follow_redirects ? "true" : "false") << ",";
    out << "\"maxRedirects\":" << r.max_redirects << ",";
    out << "\"httpVersion\":" << Json (r.http_version).dump () << ",";
    out << "\"verifySSL\":" << (r.verify_ssl ? "true" : "false") << ",";
    out << "\"stream\":" << (r.stream ? "true" : "false") << ",";
    // Through the same `spec_operation_node` the object serializer uses, so the
    // list route and the single route cannot come to disagree about it.
    out << "\"specOperation\":" << spec_operation_node (r.spec_operation).dump () << ",";
    out << "\"updatedAt\":" << r.updated_at << ",";
    out << "\"createdAt\":" << r.created_at;
    out << "}";
}

std::string sanitize_config_snapshot (const std::string& body) {
    Json parsed;
    try {
        parsed = Json::parse (body);
    } catch (const std::exception&) {
        return body; // not JSON; store as-is
    }

    // Allowlist within the auth subtree: keep only the mode, drop every
    // credential field. Because we keep a fixed key rather than blocking known
    // secret names, no future auth field (client secrets, tokens, private keys)
    // can leak into the persisted snapshot.
    if (parsed.is_object ()) {
        if (auto it = parsed.find ("auth"); it != parsed.end () && it->is_object ()) {
            const std::string mode = it->value ("mode", std::string{ "none" });
            *it                    = Json::object ({ { "mode", mode } });
        }
    }
    return parsed.dump ();
}

} // namespace vayu::json
