/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_data.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>

#include "vayu/http/graphql_body.hpp"
// `ends_a_header_line` - the same rule the composer and the pre-send gate
// apply, so a bound cell and a substituted variable cannot drift apart on what
// a header may hold.
#include "vayu/http/header_text.hpp"
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

/// What kind of text a visited field is, for the rules that depend on it.
enum class FieldContext : std::uint8_t {
    /// A URL, a form field, a text body: no quoting rule of its own.
    Plain,
    /// A header name or value, or a credential `apply_auth` writes into a
    /// header line. Plain text like @ref Plain - a header has no quoting rule -
    /// except that a CR or LF in a bound value ends the line rather than
    /// sitting in it, so the join refuses one (issue #732).
    Header,
    /// A body whose text is a JSON document, so a token may land inside a
    /// string literal and has to be escaped when it does.
    JsonDocument,
    /// A body whose text is an XML document, so how a token is written depends
    /// on which part of the document it landed in.
    XmlDocument,
};

/**
 * What kind of document this request's body text is.
 *
 * `Json` and `JsonRpc` always are JSON. A `graphql` body is either shape - the
 * JSON envelope or a bare GraphQL document - so it is asked, through the same
 * classifier the envelope itself uses; a bare document is *not* a JSON document
 * here, because `graphql_wire_body` escapes it wholesale when it wraps it and
 * escaping first would double every quote.
 *
 * `Xml` (the mode #580 added) is a document too, with quoting rules of its own
 * rather than JSON's - see `advance_xml_state` for what a bound value is
 * written as, and why it depends on the token's position.
 *
 * Every other mode is plain text as far as a bind is concerned.
 */
FieldContext body_context (const vayu::Body& body) {
    switch (body.mode) {
    case vayu::BodyMode::Json:
    case vayu::BodyMode::JsonRpc: return FieldContext::JsonDocument;
    case vayu::BodyMode::Xml: return FieldContext::XmlDocument;
    case vayu::BodyMode::GraphQL:
        return vayu::http::graphql_body_is_enveloped (body.content) ?
        FieldContext::JsonDocument :
        FieldContext::Plain;
    default: return FieldContext::Plain;
    }
}

/** Two header names that became one when a row was bound into them. */
struct HeaderCollision {
    /// The name as the request carries it, before the bind - the text the user
    /// has to go and fix, so the error names this rather than the result.
    std::string original;
    /// The name already taken, equal (ignoring case) to what @ref original
    /// became. It is the *other* header's bound name, which is the one that
    /// survives a first-wins insert.
    std::string taken;
};

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
 *
 * Returns the first header collision the rebuild produced, for the caller to
 * refuse the bind over; `nullopt` for the ordinary walk. Only a *bind* can
 * produce one - `request.headers` is already a case-insensitive map, so its own
 * keys are unique - which is why a split never reports one.
 */
template <typename Visit>
std::optional<HeaderCollision> walk_bindable_fields (vayu::Request& request, Visit&& visit) {
    std::optional<HeaderCollision> collision;

    visit (request.url, FieldContext::Plain);

    if (!request.headers.empty ()) {
        vayu::Headers rebound;
        for (const auto& [name, value] : request.headers) {
            std::string bound_name  = name;
            std::string bound_value = value;
            visit (bound_name, FieldContext::Header);
            visit (bound_value, FieldContext::Header);
            // A plain `emplace` is first-wins and silent, and a dropped header
            // is exactly the quiet wrong request this namespace exists to
            // remove - worse than most, because the collision belongs to the
            // *row*: a file whose row 3 binds `authorization` beside a literal
            // `Authorization` sends two good requests and then one missing its
            // auth, with nothing said. Recorded and refused by the caller.
            //
            // The walk still finishes: the field positions the joiner addresses
            // are counted by it, so an early return would make the contract
            // above ("neither can address a field the other does not") depend
            // on a row's contents.
            auto [existing, inserted] =
            rebound.emplace (std::move (bound_name), std::move (bound_value));
            if (!inserted && !collision) {
                // `bound_name` was consumed by the failed emplace; the key that
                // won says what it collided with, and says it in the spelling
                // that survives.
                collision = HeaderCollision{ name, existing->first };
            }
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

    return collision;
}

/// The refusal a header collision reads as, in the same shape as the missing-
/// column and null-cell errors above: the token's own text, then the row.
std::string describe_header_collision (const HeaderCollision& collision, size_t row_index) {
    return "binding header \"" + collision.original + "\" against data row " +
    std::to_string (row_index) + " produced \"" + collision.taken +
    "\", which another header of this request already resolves to - one of the "
    "two would be dropped, so the row is refused rather than sent with a "
    "header missing";
}

/// Which `FieldContext` a credential headed for @p destination binds under.
FieldContext credential_context (vayu::http::CredentialDestination destination) {
    return destination == vayu::http::CredentialDestination::HeaderLine ?
    FieldContext::Header :
    FieldContext::Plain;
}

/**
 * The refusal a value that would end the header line it is bound into reads as.
 *
 * A header line is `Key: value` terminated by CRLF, so a cell carrying either
 * byte does not sit in the header - it ends it, and whatever follows is read as
 * a header of its own. JSON and JSONL rows reach the binder as native strings,
 * with no CSV grammar to have stripped a newline on the way in, so this is an
 * ordinary cell rather than an exotic one.
 *
 * A refusal rather than an encoding, for the reason an XML comment is one: a
 * header value has no escape for a line break, so every candidate encoding
 * either changes the value or leaves the line ended. Stripping the bytes would
 * be the quiet wrong request this namespace exists to remove - the header would
 * arrive holding something the file does not say.
 */
std::string describe_header_line_break (const std::string& column, size_t row_index) {
    return token_for (column) + " is bound into a header, and data row " +
    std::to_string (row_index) +
    " has a line break in that column - a CR or LF ends the header line rather "
    "than sitting in it, so the rest of the value would be read as headers of "
    "its own; the row is refused rather than sent forging a header";
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
 * Where in an XML document the text scanned so far has left us.
 *
 * JSON's question is one bit - inside a string literal or not - because a JSON
 * string has one quoting rule. XML has several, and which one applies is the
 * only thing that decides how a value may be written, so the scan has to say
 * which part of the document the next token sits in rather than whether it is
 * "in" something.
 */
enum class XmlPosition : std::uint8_t {
    /// Character data, between tags.
    Text,
    /// Inside a tag but not inside an attribute value: a tag name, an attribute
    /// name, the whitespace between them.
    Markup,
    /// Inside a `"`-delimited attribute value.
    AttributeDouble,
    /// Inside a `'`-delimited attribute value.
    AttributeSingle,
    /// Inside `<![CDATA[` … `]]>`.
    Cdata,
    /// Inside `<!--` … `-->`.
    Comment,
    /// Inside `<?` … `?>`.
    ProcessingInstruction,
};

/** How far into a delimiter the scan is, carried across literal chunks. */
struct XmlScanState {
    XmlPosition position = XmlPosition::Text;
    /// The characters of a delimiter matched so far and not yet resolved - the
    /// `<![CDATA[` a chunk stopped halfway through, or the `]]` waiting for the
    /// `>` that would end one. A token can sit anywhere, including between the
    /// two halves of a delimiter, so this cannot live inside one chunk's scan.
    std::string pending;
};

/// The delimiter that ends @p position, or empty for the positions that end at
/// a single character the scan handles inline.
std::string_view xml_closing_delimiter (XmlPosition position) {
    switch (position) {
    case XmlPosition::Cdata: return "]]>";
    case XmlPosition::Comment: return "-->";
    case XmlPosition::ProcessingInstruction: return "?>";
    default: return {};
    }
}

/// The longest suffix of @p candidate that is a *proper* prefix of @p pattern -
/// how much of a delimiter is still in hand once it has failed to complete.
std::string longest_partial_match (std::string_view candidate, std::string_view pattern) {
    const size_t longest = std::min (candidate.size (), pattern.size () - 1);
    for (size_t length = longest; length > 0; --length) {
        if (candidate.substr (candidate.size () - length) == pattern.substr (0, length)) {
            return std::string (candidate.substr (candidate.size () - length));
        }
    }
    return {};
}

/** A delimiter a `<` in character data can open, and what it opens. */
struct XmlOpener {
    std::string_view text;
    XmlPosition opens;
};

/// The three things a `<` in character data can open. Anything else it opens is
/// a tag, and every tag is @ref XmlPosition::Markup - a `<!DOCTYPE` included,
/// which ends at its `>` like a tag and carries nothing a row would bind into.
constexpr auto XML_OPENERS = std::to_array<XmlOpener> ({
{ "<!--", XmlPosition::Comment },
{ "<![CDATA[", XmlPosition::Cdata },
{ "<?", XmlPosition::ProcessingInstruction },
});

/// Where @p c leaves a scan that is inside a tag but not inside an attribute
/// value. Asked twice - once per ordinary character, once for the character
/// that revealed the tag - and it is the same question both times.
XmlPosition xml_position_after_markup_char (char c) {
    if (c == '"') {
        return XmlPosition::AttributeDouble;
    }
    if (c == '\'') {
        return XmlPosition::AttributeSingle;
    }
    if (c == '>') {
        return XmlPosition::Text;
    }
    return XmlPosition::Markup;
}

/**
 * Advance @p state over one literal chunk of an XML body.
 *
 * Only the literal chunks are scanned, never a bound value, and - as with
 * `advance_json_string_state` - that is sound because of the encodings this
 * decides. A value bound in character data has its `&` and `<` escaped, so it
 * cannot open markup; one bound in an attribute value has that attribute's
 * delimiter escaped, so it cannot close it; one bound in a CDATA section has
 * its `]]>` split across a reopened section, so it cannot end it and leaves the
 * scan inside CDATA either way; and one bound in a comment or a processing
 * instruction is refused outright, so nothing is written there at all. The
 * state after a token is therefore the state before it.
 *
 * @ref XmlPosition::Markup is the one exception, and it is the position where
 * no escape could help: a token there is a tag or attribute *name*, and a name
 * that legally contains `>` or a quote does not exist - so the value is written
 * verbatim, as it was before this rule, and the scan trusts it to contribute no
 * delimiter. That trust is the author's to keep; a name is not content, and a
 * data file is not where one comes from.
 */
/**
 * One character of character data.
 *
 * A `<` is held until enough of what follows it has arrived to say which
 * construct it opened - which may be after the token that sits in the middle of
 * it, hence `pending`.
 */
void advance_xml_text (char c, XmlScanState& state) {
    if (state.pending.empty ()) {
        if (c == '<') {
            state.pending = "<";
        }
        return;
    }
    state.pending += c;
    bool opened  = false;
    bool partial = false;
    for (const XmlOpener& opener : XML_OPENERS) {
        if (state.pending == opener.text) {
            state.position = opener.opens;
            state.pending.clear ();
            opened = true;
            break;
        }
        partial = partial ||
        opener.text.substr (0, state.pending.size ()) == state.pending;
    }
    if (opened || partial) {
        return;
    }
    // It opened a tag after all. The character that settled that is part of the
    // tag, so it is re-read in the position it actually sits in - `<>` would
    // otherwise leave the scan inside markup that already closed.
    state.pending.clear ();
    state.position = xml_position_after_markup_char (c);
}

/** One character inside a construct that ends at a fixed closing delimiter. */
void advance_xml_closer (char c, std::string_view closer, XmlScanState& state) {
    const std::string candidate = state.pending + c;
    if (candidate == closer) {
        state.position = XmlPosition::Text;
        state.pending.clear ();
        return;
    }
    state.pending = longest_partial_match (candidate, closer);
}

void advance_xml_state (std::string_view literal, XmlScanState& state) {
    for (const char c : literal) {
        if (const std::string_view closer = xml_closing_delimiter (state.position);
        !closer.empty ()) {
            advance_xml_closer (c, closer, state);
            continue;
        }

        switch (state.position) {
        case XmlPosition::AttributeDouble:
            if (c == '"') {
                state.position = XmlPosition::Markup;
            }
            continue;
        case XmlPosition::AttributeSingle:
            if (c == '\'') {
                state.position = XmlPosition::Markup;
            }
            continue;
        case XmlPosition::Markup:
            state.position = xml_position_after_markup_char (c);
            continue;
        default: break;
        }

        advance_xml_text (c, state);
    }
}

/// How a token sitting at @p position is written - or, for the two positions
/// that have no right answer, that it is not written at all.
DataValueEncoding xml_encoding_at (XmlPosition position) {
    switch (position) {
    case XmlPosition::Text: return DataValueEncoding::XmlText;
    case XmlPosition::AttributeDouble:
        return DataValueEncoding::XmlAttributeDouble;
    case XmlPosition::AttributeSingle:
        return DataValueEncoding::XmlAttributeSingle;
    case XmlPosition::Cdata: return DataValueEncoding::XmlCdata;
    case XmlPosition::Comment: return DataValueEncoding::XmlInComment;
    case XmlPosition::ProcessingInstruction:
        return DataValueEncoding::XmlInProcessingInstruction;
    case XmlPosition::Markup: break;
    }
    return DataValueEncoding::Verbatim;
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
        XmlScanState xml_state;
        for (size_t i = 0; i < split.names.size (); ++i) {
            entry.columns.push_back (
            split.names[i].substr (vayu::http::DATA_NAMESPACE_PREFIX.size ()));
            DataValueEncoding encoding = DataValueEncoding::Verbatim;
            if (context == FieldContext::JsonDocument) {
                in_string = advance_json_string_state (entry.literals[i], in_string);
                encoding = in_string ? DataValueEncoding::JsonString :
                                       DataValueEncoding::Verbatim;
            } else if (context == FieldContext::XmlDocument) {
                advance_xml_state (entry.literals[i], xml_state);
                encoding = xml_encoding_at (xml_state.position);
            }
            entry.encodings.push_back (encoding);
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
                constexpr std::string_view kHex = "0123456789abcdef";
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

/**
 * @p text as XML content, with @p attribute_quote - the delimiter of the
 * attribute the token sits in, or `'\0'` in character data - escaped too.
 *
 * `&` and `<` are the two characters XML forbids raw in both positions. `>` is
 * only forbidden as part of `]]>`, but escaping it always is conventional and
 * cannot change what the document says, so it is not worth tracking the one
 * sequence that needs it. A quote is legal in character data and inside the
 * attribute the *other* quote delimits, so only the delimiter actually in force
 * is rewritten - `it's` stays readable in a double-quoted attribute.
 */
std::string escape_xml_content (const std::string& text, char attribute_quote) {
    std::string out;
    out.reserve (text.size ());
    for (const char c : text) {
        switch (c) {
        case '&': out += "&amp;"; break;
        case '<': out += "&lt;"; break;
        case '>': out += "&gt;"; break;
        case '"': out += (attribute_quote == '"') ? "&quot;" : "\""; break;
        case '\'': out += (attribute_quote == '\'') ? "&apos;" : "'"; break;
        default: out += c;
        }
    }
    return out;
}

/**
 * @p text inside a `<![CDATA[…]]>` section: byte for byte, which is what the
 * section means and what an author picked it for, except for the one sequence
 * that would end it early.
 *
 * A `]]>` in the value is written `]]]]><![CDATA[>` - the section closes after
 * the `]]`, a new one opens, and the `>` sits inside it. A parser reads one
 * uninterrupted run of character data across the seam, so the value arrives
 * exactly as the cell wrote it and the document keeps the shape the author did.
 */
std::string escape_xml_cdata (const std::string& text) {
    constexpr std::string_view CLOSER = "]]>";
    constexpr std::string_view SPLIT  = "]]]]><![CDATA[>";
    std::string out;
    out.reserve (text.size ());
    size_t cursor = 0;
    for (size_t found = text.find (CLOSER); found != std::string::npos;
    found             = text.find (CLOSER, cursor)) {
        out.append (text, cursor, found - cursor);
        out += SPLIT;
        cursor = found + CLOSER.size ();
    }
    out.append (text, cursor);
    return out;
}

/// The rendered cell as it is written into the text around it.
std::string encode_data_value (const nlohmann::json& value, DataValueEncoding encoding) {
    std::string rendered = vayu::http::render_data_value (value);
    switch (encoding) {
    case DataValueEncoding::JsonString:
        return escape_json_string_content (rendered);
    case DataValueEncoding::XmlText: return escape_xml_content (rendered, '\0');
    case DataValueEncoding::XmlAttributeDouble:
        return escape_xml_content (rendered, '"');
    case DataValueEncoding::XmlAttributeSingle:
        return escape_xml_content (rendered, '\'');
    case DataValueEncoding::XmlCdata: return escape_xml_cdata (rendered);
    // The two unwritable placements never reach this: the join refuses the row
    // before it renders a value for them.
    case DataValueEncoding::XmlInComment:
    case DataValueEncoding::XmlInProcessingInstruction:
    case DataValueEncoding::Verbatim: break;
    }
    return rendered;
}

/**
 * The refusal a token placed where an XML body has no encoding for it reads as,
 * or `nullopt` for the placements that do have one.
 *
 * Both are markup addressed to something other than the server reading the
 * body: a comment is not sent as content at all, and a processing instruction
 * is an instruction to the parser. A value bound into either would either
 * vanish or, carrying `-->` or `?>`, end the construct and change the document
 * into one the author did not write - so the row is refused, in the same shape
 * as the missing-column and null-cell errors: the token's own text first.
 */
std::optional<std::string> describe_unwritable_placement (const std::string& column,
DataValueEncoding encoding) {
    if (encoding == DataValueEncoding::XmlInComment) {
        return token_for (column) +
        " sits inside an XML comment, where a bound value is not sent at all - "
        "and one "
        "carrying \"-->\" would end the comment and change the document "
        "instead, so the "
        "row is refused rather than bound somewhere it cannot be read";
    }
    if (encoding == DataValueEncoding::XmlInProcessingInstruction) {
        return token_for (column) +
        " sits inside an XML processing instruction, which is markup addressed "
        "to the "
        "parser rather than content - a bound value carrying \"?>\" would end "
        "it and "
        "change the document, so the row is refused rather than bound into "
        "markup";
    }
    return std::nullopt;
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

    void operator() (std::string& field, FieldContext context) {
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
            // Checked before the row is consulted: a placement no encoding fits
            // is the template's fault and fails identically for every row, so
            // naming a missing column instead would send the reader after the
            // file when the request is what needs moving.
            if (auto refusal = describe_unwritable_placement (
                entry.columns[i], entry.encodings[i])) {
                result_.ok    = false;
                result_.error = std::move (*refusal);
                return;
            }
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
            std::string encoded = encode_data_value (*cell, entry.encodings[i]);
            // Checked on the encoded text rather than the cell, because that is
            // what the field ends up holding - and only in a header, where a
            // line break is a line terminator. Everywhere else the same bytes
            // are ordinary content: a JSON body escapes them, and a URL, a form
            // field or a text body carries them as the cell wrote them.
            if (context == FieldContext::Header && vayu::http::ends_a_header_line (encoded)) {
                result_.ok = false;
                result_.error = describe_header_line_break (entry.columns[i], row_index_);
                return;
            }
            out += encoded;
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

StepDataTemplate tokenize_data_fields (const vayu::Request& request) {
    // Copied because the walk rewrites in place; nothing is actually rewritten
    // here, since a split substitutes no token. Sharing the walk is what the
    // copy buys - see the header for why a second field list would be the wrong
    // trade.
    vayu::Request scratch = request;
    FieldSplitter splitter;
    // The collision the walk can report is a bind-time fault only: a split
    // rewrites nothing, so the header map is rebuilt from its own unique keys.
    (void)walk_bindable_fields (
    scratch, [&splitter] (const std::string& field, FieldContext context) {
        splitter (field, context);
    });
    return splitter.take ();
}

StepDataTemplate tokenize_auth_fields (const vayu::http::Auth& auth) {
    FieldSplitter splitter;
    vayu::http::walk_auth_credentials (auth,
    [&splitter] (const std::string& field, vayu::http::CredentialDestination destination) {
        splitter (field, credential_context (destination));
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
    // A bearer token and an api key sent in a header are header text, so a line
    // break in the cell behind one forges a header exactly as it would in
    // `request.headers` - the walk says which credential is which so this does
    // not have to re-read the mode (issue #732).
    vayu::http::walk_auth_credentials (auth,
    [&joiner] (std::string& field, vayu::http::CredentialDestination destination) {
        joiner (field, credential_context (destination));
    });
    return joiner.result ();
}

DataBindResult bind_iteration_row (vayu::Request& request,
const StepDataTemplate& fields,
const vayu::http::Auth& auth,
const StepDataTemplate& credentials,
const nlohmann::json& row,
size_t row_index) {
    if (auto bound = apply_data_template (request, fields, row, row_index); !bound.ok) {
        return bound;
    }
    // The credentials second, which is the whole reason this order lives in one
    // place - see the header.
    return bind_auth_row (request, auth, credentials, row, row_index);
}

DataBindResult bind_auth_row (vayu::Request& request,
vayu::http::Auth auth,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index) {
    if (tmpl.empty ()) {
        return DataBindResult{ true, {} };
    }

    if (auto bound = apply_auth_data_template (auth, tmpl, row, row_index);
    !bound.ok) {
        return bound;
    }

    // No database handle: see the header - the one mode that would need it is
    // refused before a build is ever deferred.
    if (auto applied = vayu::http::apply_auth (request, auth, nullptr); !applied.ok) {
        return DataBindResult{ false, applied.message };
    }
    return DataBindResult{ true, {} };
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

std::optional<std::string> first_oauth2_data_token (const vayu::http::Auth& auth) {
    const auto* oauth2 = std::get_if<vayu::http::OAuth2Auth> (&auth);
    if (oauth2 == nullptr) {
        return std::nullopt;
    }
    return first_data_token_in (oauth2->config);
}

DataBindResult apply_data_template (vayu::Request& request,
const StepDataTemplate& tmpl,
const nlohmann::json& row,
size_t row_index) {
    if (tmpl.empty ()) {
        return DataBindResult{ true, {} };
    }
    TemplateJoiner joiner (tmpl, row, row_index);
    auto collision = walk_bindable_fields (
    request, [&joiner] (std::string& field, FieldContext context) {
        joiner (field, context);
    });
    DataBindResult result = joiner.result ();
    // A join failure is checked first because it is the earlier and more
    // specific fault: the joiner stops rewriting once it records one, so a
    // collision seen after it is an artefact of a half-bound walk rather than
    // anything the request actually says.
    if (!result.ok) {
        return result;
    }
    if (collision) {
        return DataBindResult{ false, describe_header_collision (*collision, row_index) };
    }
    return result;
}

DataBindResult bind_data_row (vayu::Request& request, const nlohmann::json& row, size_t row_index) {
    return apply_data_template (request, tokenize_data_fields (request), row, row_index);
}

} // namespace vayu::core
