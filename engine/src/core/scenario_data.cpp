/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_data.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "vayu/http/graphql_body.hpp"
#include "vayu/http/request_composer.hpp"

namespace vayu::core {

namespace {

/// The row's keys, in payload order, for the "columns: ..." half of an error.
std::string describe_columns (const nlohmann::json& row) {
    std::string out;
    for (const auto& [key, value] : row.items ()) {
        (void)value;
        if (!out.empty ()) {
            out += ", ";
        }
        out += key;
    }
    return out.empty () ? "none" : out;
}

/// `{{data.<column>}}` - the token as it was written, for an error to name.
std::string token_for (const std::string& column) {
    return "{{" + std::string (vayu::http::DATA_NAMESPACE_PREFIX) + column + "}}";
}

/// What kind of text a visited field is, for the one rule that depends on it.
enum class FieldContext : std::uint8_t {
    /// A URL, a header, a form field, a text body: no quoting rule of its own.
    Plain,
    /// A body whose text is a JSON document, so a token may land inside a
    /// string literal and has to be escaped when it does.
    JsonDocument,
};

/**
 * Whether this request's body text is a JSON document.
 *
 * `Json` and `JsonRpc` always are. A `graphql` body is either shape - the JSON
 * envelope or a bare GraphQL document - so it is asked, through the same
 * classifier the envelope itself uses; a bare document is *not* a JSON document
 * here, because `graphql_wire_body` escapes it wholesale when it wraps it and
 * escaping first would double every quote.
 *
 * Every other mode is plain text as far as a bind is concerned - the `Xml` mode
 * #580 added included, deliberately: a bound value lands in the document
 * verbatim, so one holding `&` or `<` produces XML the server will reject. XML
 * needs an encoding of its own rather than JSON's (its rules differ between
 * text content and an attribute value, so the position of the token decides it,
 * which is more than this classifier can say) - tracked as #618.
 */
FieldContext body_context (const vayu::Body& body) {
    switch (body.mode) {
    case vayu::BodyMode::Json:
    case vayu::BodyMode::JsonRpc: return FieldContext::JsonDocument;
    case vayu::BodyMode::GraphQL:
        return vayu::http::graphql_body_is_enveloped (body.content) ?
        FieldContext::JsonDocument :
        FieldContext::Plain;
    default: return FieldContext::Plain;
    }
}

/**
 * The one list of strings a data row binds: URL, header names and values, raw
 * body, and both halves of every form field.
 *
 * Splitting and joining both drive it, so neither can cover a field the other
 * does not - a field only the splitter walked would be a token nobody joins,
 * and one only the joiner walked would be addressed by an index the splitter
 * never handed out.
 *
 * Header *names* are substituted too, because composition substitutes them: the
 * payload carries headers as `[{key, value}]`, and `resolve_json_strings`
 * resolves every string value in that array, key included. A map cannot have
 * its keys rewritten in place, so this rebuilds it.
 *
 * Each field is visited with the context it sits in, so the splitter can decide
 * a token's encoding from the same walk that hands out its position.
 */
template <typename Visit>
void walk_bindable_fields (vayu::Request& request, Visit&& visit) {
    visit (request.url, FieldContext::Plain);

    if (!request.headers.empty ()) {
        vayu::Headers rebound;
        for (const auto& [name, value] : request.headers) {
            std::string bound_name  = name;
            std::string bound_value = value;
            visit (bound_name, FieldContext::Plain);
            visit (bound_value, FieldContext::Plain);
            rebound.emplace (std::move (bound_name), std::move (bound_value));
        }
        request.headers = std::move (rebound);
    }

    // Read before the visit: the join rewrites the content in place, and a
    // bound body is not the text the mode was decided from.
    const FieldContext content_context = body_context (request.body);
    visit (request.body.content, content_context);
    for (auto& field : request.body.fields) {
        visit (field.key, FieldContext::Plain);
        visit (field.value, FieldContext::Plain);
    }
}

/**
 * Whether the text so far has left us inside a JSON string literal.
 *
 * Only the literal chunks are scanned, never a bound value, and that is sound
 * precisely because of the encoding this decides: a value bound inside a string
 * is escaped, so it cannot close the string, and one bound outside is rendered
 * as balanced JSON. Either way the state after a token is the state before it.
 */
bool advance_json_string_state (std::string_view literal, bool in_string) {
    bool escaped = false;
    for (const char c : literal) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (in_string && c == '\\') {
            escaped = true;
            continue;
        }
        if (c == '"') {
            in_string = !in_string;
        }
    }
    return in_string;
}

/**
 * Split each visited field around its `{{data.*}}` tokens, keeping only the
 * fields that carry one.
 */
class FieldSplitter {
    public:
    /// Takes its field by const reference: a split rewrites nothing, and the
    /// credential walk visits strings it has no copy of.
    void operator() (const std::string& field, FieldContext context) {
        const size_t position = next_field_++;
        if (field.empty ()) {
            return;
        }
        auto split = vayu::http::split_tokens (field, vayu::http::is_data_variable_name);
        if (split.names.empty ()) {
            return;
        }
        DataFieldTemplate entry;
        entry.field    = position;
        entry.literals = std::move (split.literals);
        entry.columns.reserve (split.names.size ());
        entry.encodings.reserve (split.names.size ());
        bool in_string = false;
        for (size_t i = 0; i < split.names.size (); ++i) {
            entry.columns.push_back (
            split.names[i].substr (vayu::http::DATA_NAMESPACE_PREFIX.size ()));
            if (context == FieldContext::JsonDocument) {
                in_string = advance_json_string_state (entry.literals[i], in_string);
            }
            entry.encodings.push_back (in_string ? DataValueEncoding::JsonString :
                                                   DataValueEncoding::Verbatim);
        }
        template_.fields.push_back (std::move (entry));
    }

    [[nodiscard]] StepDataTemplate take () {
        return std::move (template_);
    }

    private:
    StepDataTemplate template_;
    size_t next_field_ = 0;
};

/**
 * @p text as the inside of a JSON string literal.
 *
 * Only what JSON forbids raw is rewritten - the quote, the backslash and the
 * control characters - so every other byte survives the bind exactly as the
 * cell wrote it. Deliberately *not* `nlohmann::json::dump`, which additionally
 * validates UTF-8 and would throw on a cell a latin-1 CSV produced; a bind is
 * not the place to reject bytes the rest of the request would have carried.
 */
std::string escape_json_string_content (const std::string& text) {
    std::string out;
    out.reserve (text.size ());
    for (const char c : text) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char> (c) < 0x20) {
                constexpr const char* kHex = "0123456789abcdef";
                out += "\\u00";
                out += kHex[(static_cast<unsigned char> (c) >> 4U) & 0x0FU];
                out += kHex[static_cast<unsigned char> (c) & 0x0FU];
            } else {
                out += c;
            }
        }
    }
    return out;
}

/// The rendered cell as it is written into the text around it.
std::string encode_data_value (const nlohmann::json& value, DataValueEncoding encoding) {
    std::string rendered = render_data_value (value);
    if (encoding == DataValueEncoding::JsonString) {
        return escape_json_string_content (rendered);
    }
    return rendered;
}

/**
 * Join the templated fields of one step against one row.
 *
 * Failure is recorded rather than thrown: the caller is a per-step path in a
 * run worker, and the first bad token is the one worth naming - later ones are
 * consequences of the same missing column.
 */
class TemplateJoiner {
    public:
    TemplateJoiner (const StepDataTemplate& tmpl, const nlohmann::json& row, size_t row_index)
    : template_ (tmpl), row_ (row), row_index_ (row_index) {
    }

    void operator() (std::string& field, FieldContext /*context*/) {
        const size_t position = next_field_++;
        // The templates are in ascending walk order, so one cursor finds them
        // all without searching - every field between two of them is untouched.
        if (!result_.ok || cursor_ >= template_.fields.size ()) {
            return;
        }
        const DataFieldTemplate& entry = template_.fields[cursor_];
        if (entry.field != position) {
            return;
        }
        ++cursor_;

        std::string out = entry.literals[0];
        for (size_t i = 0; i < entry.columns.size (); ++i) {
            const auto cell = row_.find (entry.columns[i]);
            if (cell == row_.end ()) {
                result_.ok    = false;
                result_.error = token_for (entry.columns[i]) +
                " names a column data row " + std::to_string (row_index_) +
                " does not have (columns: " + describe_columns (row_) + ")";
                return;
            }
            // Same rule as a missing column, one type down: the token says the
            // value comes from the file, and a null cell has none to give.
            // Writing "" here is the quiet wrong request the namespace exists
            // to remove - `{"n": }` for a typed placement, a blank field for a
            // quoted one (issue #593).
            if (cell->is_null ()) {
                result_.ok    = false;
                result_.error = token_for (entry.columns[i]) +
                " names a column that is null in data row " +
                std::to_string (row_index_) + " - a data token substitutes a value, and this row has none for it";
                return;
            }
            out += encode_data_value (*cell, entry.encodings[i]);
            out += entry.literals[i + 1];
        }
        field = std::move (out);
    }

    [[nodiscard]] DataBindResult result () const {
        return result_;
    }

    private:
    const StepDataTemplate& template_;
    const nlohmann::json& row_;
    size_t row_index_  = 0;
    size_t next_field_ = 0;
    size_t cursor_     = 0;
    DataBindResult result_{ true, {} };
};

} // namespace

std::optional<std::string> StepDataTemplate::first_token () const {
    if (fields.empty () || fields.front ().columns.empty ()) {
        return std::nullopt;
    }
    return token_for (fields.front ().columns.front ());
}

std::string render_data_value (const nlohmann::json& value) {
    if (value.is_string ()) {
        return value.get<std::string> ();
    }
    if (value.is_null ()) {
        return {};
    }
    return value.dump ();
}

StepDataTemplate tokenize_data_fields (const vayu::Request& request) {
    // Copied because the walk rewrites in place; nothing is actually rewritten
    // here, since a split substitutes no token. Sharing the walk is what the
    // copy buys - see the header for why a second field list would be the wrong
    // trade.
    vayu::Request scratch = request;
    FieldSplitter splitter;
    walk_bindable_fields (scratch, [&splitter] (const std::string& field, FieldContext context) {
        splitter (field, context);
    });
    return splitter.take ();
}

StepDataTemplate tokenize_auth_fields (const vayu::http::Auth& auth) {
    FieldSplitter splitter;
    vayu::http::walk_auth_credentials (auth, [&splitter] (const std::string& field) {
        splitter (field, FieldContext::Plain);
    });
    return splitter.take ();
}

DataBindResult apply_auth_data_template (vayu::http::Auth& auth,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index) {
    if (tmpl.empty ()) {
        return DataBindResult{ true, {} };
    }
    TemplateJoiner joiner (tmpl, row, row_index);
    vayu::http::walk_auth_credentials (auth,
    [&joiner] (std::string& field) { joiner (field, FieldContext::Plain); });
    return joiner.result ();
}

std::optional<std::string> first_data_token_in (const nlohmann::json& value) {
    if (value.is_string ()) {
        const auto split = vayu::http::split_tokens (
        value.get<std::string> (), vayu::http::is_data_variable_name);
        if (split.names.empty ()) {
            return std::nullopt;
        }
        return "{{" + split.names.front () + "}}";
    }
    if (value.is_object () || value.is_array ()) {
        for (const auto& child : value) {
            if (auto found = first_data_token_in (child)) {
                return found;
            }
        }
    }
    return std::nullopt;
}

DataBindResult apply_data_template (vayu::Request& request,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index) {
    if (tmpl.empty ()) {
        return DataBindResult{ true, {} };
    }
    TemplateJoiner joiner (tmpl, row, row_index);
    walk_bindable_fields (request, [&joiner] (std::string& field, FieldContext context) {
        joiner (field, context);
    });
    return joiner.result ();
}

DataBindResult bind_data_row (vayu::Request& request, const nlohmann::json& row, size_t row_index) {
    return apply_data_template (request, tokenize_data_fields (request), row, row_index);
}

} // namespace vayu::core
