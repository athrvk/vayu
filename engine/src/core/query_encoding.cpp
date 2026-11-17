/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/query_encoding.hpp"

#include "js_json.hpp"

#include "vayu/core/path_template.hpp"
#include "vayu/core/postman_encode_sets.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <deque>
#include <optional>
#include <unordered_map>
#include <utility>

namespace vayu::core {

namespace {

bool in_query_value_set (unsigned char byte) {
    return byte == '&' || in_postman_query_encode_set (byte);
}

bool in_query_key_set (unsigned char byte) {
    return byte == '=' || in_query_value_set (byte);
}

} // namespace

std::string encode_query_component (std::string_view text, QueryPart part) {
    return encode_outside_tokens (
    text, part == QueryPart::Key ? in_query_key_set : in_query_value_set);
}

namespace {

/// The pairs of @p query, its separators found in @p masked: @p query with its
/// `{{...}}` tokens masked (`mask_template_tokens`), or @p query itself where
/// a token is not kept whole.
std::vector<QueryPair> split_masked_pairs (std::string_view query, std::string_view masked) {
    std::vector<QueryPair> pairs;
    std::size_t start = 0;
    while (start <= masked.size ()) {
        const std::size_t amp = masked.find ('&', start);
        const std::size_t end = amp == std::string_view::npos ? masked.size () : amp;
        const std::string_view pair        = query.substr (start, end - start);
        const std::string_view masked_pair = masked.substr (start, end - start);
        start                              = end + 1;
        if (pair.empty ()) {
            continue;
        }
        const std::size_t equals = masked_pair.find ('=');
        QueryPair split;
        split.key       = std::string (pair.substr (0, equals));
        split.valueless = equals == std::string_view::npos;
        if (!split.valueless) {
            split.value = std::string (pair.substr (equals + 1));
        }
        pairs.push_back (std::move (split));
    }
    return pairs;
}

} // namespace

std::vector<QueryPair> split_query_pairs (std::string_view query) {
    return split_masked_pairs (query, query);
}

std::vector<QueryPair> url_query_pairs (std::string_view url) {
    const std::string masked_url = mask_template_tokens (url);
    const std::string_view masked =
    std::string_view (masked_url).substr (0, masked_url.find ('#'));
    const std::size_t question_mark = masked.find ('?');
    if (question_mark == std::string_view::npos) {
        return {};
    }
    const std::size_t start = question_mark + 1;
    return split_masked_pairs (
    url.substr (start, masked.size () - start), masked.substr (start));
}

namespace {

/// Where reading @p c at @p where moves the URL.
UrlComponent after_url_byte (char c, UrlComponent where) {
    if (c == '#') {
        return UrlComponent::Fragment;
    }
    if (where == UrlComponent::Query || where == UrlComponent::Fragment) {
        return where;
    }
    if (c == '?') {
        return UrlComponent::Query;
    }
    if (where == UrlComponent::Path) {
        return where;
    }
    if (c == ':') {
        return UrlComponent::HeadSeparator;
    }
    if (c == '/') {
        return where == UrlComponent::HeadSeparator ? where : UrlComponent::Path;
    }
    return UrlComponent::Head;
}

/// A kept `{{...}}` token reads as head text, a scheme or a host: a `/` after
/// `http://{{host}}` opens the path.
UrlComponent after_url_token (UrlComponent where) {
    return where == UrlComponent::HeadSeparator ? UrlComponent::Head : where;
}

bool in_substituted_set (unsigned char byte, UrlComponent where) {
    switch (where) {
    case UrlComponent::Path: return in_postman_path_encode_set (byte);
    case UrlComponent::Query: return in_postman_query_encode_set (byte);
    case UrlComponent::Fragment: return in_postman_fragment_encode_set (byte);
    case UrlComponent::Head:
    case UrlComponent::HeadSeparator: return false;
    }
    return false;
}

} // namespace

UrlComponent advance_url_component (std::string_view text, UrlComponent from) {
    UrlComponent where = from;
    for (std::size_t at = 0; at < text.size () && where != UrlComponent::Fragment;) {
        if (const std::size_t end = template_token_end (text, at);
        end != std::string_view::npos) {
            where = after_url_token (where);
            at    = end;
            continue;
        }
        where = after_url_byte (text[at++], where);
    }
    return where;
}

// The component moves *before* a byte is judged, so a `?` or `#` is always
// structure, never encoded.
std::string encode_at_url_component (std::string_view value, UrlComponent& where) {
    static constexpr std::string_view hex = "0123456789ABCDEF";
    std::string out;
    out.reserve (value.size ());
    for (std::size_t at = 0; at < value.size ();) {
        if (const std::size_t end = template_token_end (value, at);
        end != std::string_view::npos) {
            out += value.substr (at, end - at);
            where = after_url_token (where);
            at    = end;
            continue;
        }
        const char ch   = value[at++];
        where           = after_url_byte (ch, where);
        const auto byte = static_cast<unsigned char> (ch);
        if (in_substituted_set (byte, where)) {
            out += '%';
            out += hex[byte >> 4U];
            out += hex[byte & 0x0FU];
        } else {
            out += ch;
        }
    }
    return out;
}

namespace {

using nlohmann::json;

constexpr auto ROW_ENCODINGS = std::to_array (
{ QueryEncoding::Postman, QueryEncoding::UriComponent, QueryEncoding::AsTyped });

/// A string member of @p row, or "" when absent or not a string.
std::string row_text (const json& row, const char* member) {
    const auto found = row.find (member);
    return found != row.end () && found->is_string () ? found->get<std::string> () :
                                                        std::string ();
}

/// Only `enabled: true` is enabled, as the app's `row.enabled` reads it; a
/// row that is not an object is never one.
bool row_enabled (const json& row) {
    if (!row.is_object ()) {
        return false;
    }
    const auto found = row.find ("enabled");
    return found != row.end () && found->is_boolean () && found->get<bool> ();
}

bool row_valueless (const json& row) {
    const auto found = row.find ("valueless");
    return found != row.end () && found->is_boolean () && found->get<bool> ();
}

/// Whether @p row, joined under some encoding, writes @p pair exactly: its
/// key, its value, and a bare `key` where the join writes one
/// (`js::query_string`'s rule).
bool writes_pair (const json& row, const QueryPair& pair) {
    const std::string key   = row_text (row, "key");
    const std::string value = row_text (row, "value");
    const bool valueless    = row_valueless (row);
    return std::ranges::any_of (ROW_ENCODINGS, [&] (QueryEncoding encoding) {
        const bool bare =
        value.empty () && (valueless || encoding == QueryEncoding::UriComponent);
        if (bare != pair.valueless ||
        js::query_part (key, QueryPart::Key, encoding) != pair.key) {
            return false;
        }
        return bare ||
        js::query_part (value, QueryPart::Value, encoding) == pair.value;
    });
}

/// @p row stating @p pair: kept whole when it already writes it, else given
/// the pair's text with every other member kept.
json row_for_pair (const json& row, const QueryPair& pair) {
    if (writes_pair (row, pair)) {
        return row;
    }
    json updated     = row;
    updated["key"]   = pair.key;
    updated["value"] = pair.value;
    if (pair.valueless) {
        updated["valueless"] = true;
    } else {
        updated.erase ("valueless");
    }
    return updated;
}

json fresh_row (const QueryPair& pair) {
    json row{ { "key", pair.key }, { "value", pair.value }, { "enabled", true } };
    if (pair.valueless) {
        row["valueless"] = true;
    }
    return row;
}

/// For each pair of the URL, the index in @p params of the enabled query row
/// that claims it: rows in order, each taking the first unclaimed pair that its
/// key writes under some encoding, so a repeated key (`tag=a&tag=b`) pairs off
/// in order.
std::vector<std::optional<std::size_t>> claim_pairs (const json& params,
const std::vector<std::size_t>& query_rows,
const std::vector<QueryPair>& pairs) {
    // Each key's unclaimed pairs, first first: a row only ever takes a front,
    // so claiming is linear in rows and pairs however many share a key.
    std::unordered_map<std::string_view, std::deque<std::size_t>> unclaimed;
    for (std::size_t at = 0; at < pairs.size (); ++at) {
        unclaimed[pairs.at (at).key].push_back (at);
    }
    std::vector<std::optional<std::size_t>> claimed_by (pairs.size ());
    for (const std::size_t row : query_rows) {
        if (!row_enabled (params.at (row))) {
            continue;
        }
        const std::string key          = row_text (params.at (row), "key");
        std::deque<std::size_t>* first = nullptr;
        for (const QueryEncoding encoding : ROW_ENCODINGS) {
            const auto found =
            unclaimed.find (js::query_part (key, QueryPart::Key, encoding));
            if (found != unclaimed.end () && !found->second.empty () &&
            (first == nullptr || found->second.front () < first->front ())) {
                first = &found->second;
            }
        }
        if (first != nullptr) {
            claimed_by.at (first->front ()) = row;
            first->pop_front ();
        }
    }
    return claimed_by;
}

/// Each disabled query row grouped under the nearest enabled row before it
/// that still claims a pair: group `i + 1` follows row `i`, and group 0, for a
/// row with no such anchor, leads. Order within a group is stored order.
std::vector<std::vector<std::size_t>> disabled_rows_by_anchor (const json& params,
const std::vector<std::size_t>& query_rows,
const std::vector<bool>& surviving) {
    std::vector<std::vector<std::size_t>> groups (params.size () + 1);
    std::size_t anchor = 0;
    for (const std::size_t row : query_rows) {
        if (!row_enabled (params.at (row))) {
            groups.at (anchor).push_back (row);
        } else if (surviving.at (row)) {
            anchor = row + 1;
        }
    }
    return groups;
}

} // namespace

json reconcile_query_rows (const json& params, std::string_view url) {
    const json rows = params.is_array () ? params : json::array ();
    std::vector<std::size_t> query_rows;
    json path_rows = json::array ();
    json stored    = json::array ();
    for (std::size_t at = 0; at < rows.size (); ++at) {
        if (is_path_variable_row (rows.at (at))) {
            path_rows.push_back (rows.at (at));
        } else {
            query_rows.push_back (at);
            stored.push_back (rows.at (at));
        }
    }

    const std::vector<QueryPair> pairs = url_query_pairs (url);
    const auto claimed_by              = claim_pairs (rows, query_rows, pairs);
    std::vector<bool> surviving (rows.size (), false);
    for (const auto& row : claimed_by) {
        if (row) {
            surviving.at (*row) = true;
        }
    }
    const auto disabled_after = disabled_rows_by_anchor (rows, query_rows, surviving);

    json merged = json::array ();
    for (const std::size_t row : disabled_after.front ()) {
        merged.push_back (rows.at (row));
    }
    for (std::size_t at = 0; at < pairs.size (); ++at) {
        const auto& claimant = claimed_by.at (at);
        if (!claimant) {
            merged.push_back (fresh_row (pairs.at (at)));
            continue;
        }
        merged.push_back (row_for_pair (rows.at (*claimant), pairs.at (at)));
        for (const std::size_t row : disabled_after.at (*claimant + 1)) {
            merged.push_back (rows.at (row));
        }
    }

    // A query that already agrees keeps the path rows where they stood.
    if (merged == stored) {
        return params;
    }
    for (json& row : path_rows) {
        merged.push_back (std::move (row));
    }
    return merged;
}

} // namespace vayu::core
