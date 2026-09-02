/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/form_body.hpp"

#include <curl/curl.h>

#include "vayu/http/graphql_body.hpp"
#include "vayu/http/jsonrpc_body.hpp"
#include "vayu/http/url_parts.hpp"
#include "vayu/utils/reentrant.hpp"

#include <cerrno>
#include <cstdio>
#include <memory>

namespace vayu::http {

namespace {

// The percent-encoder is `url_parts.hpp`'s, not a copy here: both wrapped the
// same `curl_easy_escape` call, and the one that is exported is the one a
// query-string builder can reach (issue #1228). The decoder below stays,
// because it is *not* the same function - the `+` rule is this media type's.

// libcurl's decoder, with the media type's `+` rule applied before unescaping so a
// `%2B` still decodes to a literal plus. libcurl's unescape returns the decoded
// length out-of-band because a decoded value may contain NUL bytes.
std::string percent_decode (std::string value) {
    for (char& c : value) {
        if (c == '+') {
            c = ' ';
        }
    }
    int decoded_length = 0;
    char* unescaped    = curl_easy_unescape (
    nullptr, value.c_str (), static_cast<int> (value.size ()), &decoded_length);
    if (!unescaped) {
        return {};
    }
    std::string out (unescaped, static_cast<size_t> (decoded_length));
    curl_free (unescaped);
    return out;
}

} // namespace

// Declared in the header since issue #1003: `pm.request.body.formdata` names a
// part the same way the rendering does, and a second copy of the rule would not
// receive this one's fixes.
std::string declared_file_name (const FormField& field) {
    if (!field.file_name.empty ()) {
        return field.file_name;
    }
    const auto slash = field.src.find_last_of ("/\\");
    return slash == std::string::npos ? field.src : field.src.substr (slash + 1);
}

bool is_form_mode (BodyMode mode) {
    return mode == BodyMode::Form || mode == BodyMode::FormData;
}

std::vector<FormField> enabled_fields (const std::vector<FormField>& fields) {
    std::vector<FormField> out;
    out.reserve (fields.size ());
    for (const auto& field : fields) {
        if (field.enabled) {
            out.push_back (field);
        }
    }
    return out;
}

std::string encode_urlencoded (const std::vector<FormField>& fields) {
    std::string out;
    for (const auto& field : fields) {
        if (!field.enabled) {
            continue;
        }
        if (!out.empty ()) {
            out += '&';
        }
        out += percent_encode (field.key);
        out += '=';
        out += percent_encode (field.value);
    }
    return out;
}

std::string render_form_data_parts (const std::vector<FormField>& fields) {
    std::string out;
    for (const auto& field : fields) {
        if (!field.enabled) {
            continue;
        }
        if (!out.empty ()) {
            out += '&';
        }
        out += percent_encode (field.key);
        out += '=';
        if (field.type == FormFieldType::File) {
            // Unescaped, so it cannot be produced by a text part's value.
            // A part with no file selected renders a bare `@`, which is still
            // distinct from an empty text value - it is refused before the
            // transfer (`unsendable_file_part`), but a pre-request script runs
            // first and reads the body as it stands.
            out += '@';
            out += percent_encode (declared_file_name (field));
        } else {
            out += percent_encode (field.value);
        }
    }
    return out;
}

std::vector<FormField> parse_urlencoded (const std::string& encoded) {
    std::vector<FormField> fields;
    size_t start = 0;
    while (start <= encoded.size ()) {
        const size_t amp     = encoded.find ('&', start);
        const size_t end     = amp == std::string::npos ? encoded.size () : amp;
        const std::string kv = encoded.substr (start, end - start);
        if (!kv.empty ()) {
            const size_t eq = kv.find ('=');
            FormField field;
            field.key =
            percent_decode (eq == std::string::npos ? kv : kv.substr (0, eq));
            field.value   = eq == std::string::npos ?
              std::string{} :
              percent_decode (kv.substr (eq + 1));
            field.enabled = true;
            fields.push_back (std::move (field));
        }
        if (amp == std::string::npos) {
            break;
        }
        start = amp + 1;
    }
    return fields;
}

bool has_wire_body (const Body& body) {
    if (body.mode == BodyMode::None) {
        return false;
    }
    if (is_form_mode (body.mode)) {
        for (const auto& field : body.fields) {
            if (field.enabled) {
                return true;
            }
        }
        return false;
    }
    return !body.content.empty ();
}

std::string wire_body_bytes (const Body& body) {
    if (!has_wire_body (body)) {
        return {};
    }
    switch (body.mode) {
    case BodyMode::Form: return encode_urlencoded (body.fields);
    // Multipart is libcurl's to encode - see the header.
    case BodyMode::FormData: return {};
    case BodyMode::GraphQL: return graphql_wire_body (body.content);
    case BodyMode::JsonRpc: return jsonrpc_wire_body (body.content);
    default: return body.content;
    }
}

std::string implied_content_type (const Body& body) {
    if (!has_wire_body (body)) {
        return {};
    }
    switch (body.mode) {
    case BodyMode::Form: return "application/x-www-form-urlencoded";
    // GraphQL and JSON-RPC are JSON on the wire - `wire_body` above builds each
    // one's envelope, and the envelope is what the header describes.
    case BodyMode::Json:
    case BodyMode::GraphQL:
    case BodyMode::JsonRpc: return "application/json";
    case BodyMode::Xml: return "application/xml";
    // `text` is the one content mode with no answer, and that is a decision
    // rather than a gap (issue #889): `text/plain`, `text/csv`, a JWT and a
    // raw signature are all this mode, so the header is the author's to write.
    // `binary` is the same question with the same answer.
    default: return {};
    }
}

namespace {

/**
 * The GraphQL-over-HTTP GET transport, asked as one question: the query
 * parameters this request's body travels as, or nothing when it travels in the
 * body frame like every other request.
 *
 * One function rather than a condition repeated at each of the four answers
 * below, because a request whose URL carried the document *and* whose body
 * frame carried it too would send the query twice - and the two conditions
 * would have to be kept identical by hand to prevent it.
 */
std::optional<std::string> graphql_url_transport (const Request& request) {
    if (request.method != HttpMethod::GET || request.body.mode != BodyMode::GraphQL) {
        return std::nullopt;
    }
    if (!has_wire_body (request.body)) {
        return std::nullopt;
    }
    return graphql_get_parameters (request.body.content);
}

} // namespace

bool has_wire_body (const Request& request) {
    if (graphql_url_transport (request)) {
        return false;
    }
    return has_wire_body (request.body);
}

std::string wire_body_bytes (const Request& request) {
    if (!has_wire_body (request)) {
        return {};
    }
    return wire_body_bytes (request.body);
}

std::string implied_content_type (const Request& request) {
    // A request with no body frame has no body to describe: deriving
    // `application/json` for a GraphQL GET would announce a body that is not
    // there, on a request whose document is in the URL.
    if (!has_wire_body (request)) {
        return {};
    }
    return implied_content_type (request.body);
}

std::string wire_url (const Request& request) {
    if (const auto parameters = graphql_url_transport (request)) {
        return url_with_query (request.url, *parameters);
    }
    return request.url;
}

bool content_type_is_engine_owned (const Body& body) {
    return body.mode == BodyMode::FormData && has_wire_body (body);
}

bool has_file_parts (const Body& body) {
    if (body.mode != BodyMode::FormData) {
        return false;
    }
    for (const auto& field : body.fields) {
        if (field.enabled && field.type == FormFieldType::File) {
            return true;
        }
    }
    return false;
}

std::optional<std::string> unsendable_file_part (const Body& body) {
    if (!has_file_parts (body)) {
        return std::nullopt;
    }
    for (const auto& field : enabled_fields (body.fields)) {
        if (field.type != FormFieldType::File) {
            continue;
        }
        const std::string name =
        field.key.empty () ? std::string{ "(unnamed)" } : field.key;
        if (field.src.empty ()) {
            return "Form field '" + name + "' is a file part with no file selected - choose a file or remove the part";
        }
        // fopen rather than a stat: the question is whether *this* process can
        // read the bytes, which permissions and a dangling symlink both answer
        // differently from mere existence. A directory opens on some platforms
        // and fails to read, so it is rejected on the read attempt below.
        //
        // The handle owns itself, which is what removes the two findings a bare
        // `std::FILE*` and a matching `std::fclose` carried: a close return
        // nobody read (`cert-err33-c`) and a resource held by a plain pointer
        // (`cppcoreguidelines-owning-memory`). There is nothing to discard and
        // no path out of the loop that forgets to close - including the early
        // return below, which the hand-written version reached only because the
        // close sat above it.
        const std::unique_ptr<std::FILE, int (*) (std::FILE*)> handle (
        std::fopen (field.src.c_str (), "rb"), &std::fclose);
        if (!handle) {
            return "Form field '" + name + "': cannot read file '" + field.src +
            "' (" + vayu::utils::errno_message (errno) + ")";
        }
        char probe           = 0;
        const size_t read    = std::fread (&probe, 1, 1, handle.get ());
        const bool readable  = read == 1 || std::feof (handle.get ()) != 0;
        const int read_errno = errno;
        if (!readable) {
            return "Form field '" + name + "': cannot read file '" + field.src +
            "' (" + vayu::utils::errno_message (read_errno) + ")";
        }
    }
    return std::nullopt;
}

} // namespace vayu::http
