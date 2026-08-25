/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/operation_match.hpp"

#include <cctype>
#include <unordered_map>

namespace vayu::core {

namespace {

constexpr size_t NPOS = std::string_view::npos;

bool is_alpha (char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/** The characters a URL scheme may carry after its first - `[\w+.-]`. */
bool is_scheme_char (char c) {
    return is_alpha (c) || (c >= '0' && c <= '9') || c == '_' || c == '+' ||
    c == '.' || c == '-';
}

std::string_view trim (std::string_view text) {
    size_t begin = 0;
    while (begin < text.size () &&
    std::isspace (static_cast<unsigned char> (text[begin]))) {
        ++begin;
    }
    size_t end = text.size ();
    while (end > begin && std::isspace (static_cast<unsigned char> (text[end - 1]))) {
        --end;
    }
    return text.substr (begin, end - begin);
}

/// True when the whole of @p text is a single `{{name}}` token. The shape rule
/// itself is `variable_token_name`, so the origin scan and the export's path
/// template cannot disagree about what one token is.
bool is_variable_token (std::string_view text) {
    return variable_token_name (text).has_value ();
}

/**
 * The length of the `scheme://host[:port]` @p rest begins with, or `0` when it
 * begins with none.
 *
 * The host part may be empty (`http://` is still an origin), and it ends at the
 * first `/` - the query and the fragment are gone by the time this is asked.
 */
size_t origin_prefix_length (std::string_view rest) {
    if (rest.empty () || !is_alpha (rest[0])) {
        return 0;
    }
    size_t cursor = 1;
    while (cursor < rest.size () && is_scheme_char (rest[cursor])) {
        ++cursor;
    }
    if (rest.substr (cursor, 3) != "://") {
        return 0;
    }
    cursor += 3;
    while (cursor < rest.size () && rest[cursor] != '/') {
        ++cursor;
    }
    return cursor;
}

/**
 * Every template placeholder in @p path replaced by a single `{}` - Vayu's
 * `{{petId}}` and OpenAPI's `{petId}` alike.
 *
 * One left-to-right scan where the app runs two regex passes (`{{name}}` first,
 * then `{name}`), which is the same reduction: the variable form is checked
 * first at each position, so a `{{...}}` is never read as a `{` followed by a
 * `{...}`.
 */
std::string flatten_placeholders (std::string_view path) {
    std::string out;
    out.reserve (path.size ());
    size_t cursor = 0;
    while (cursor < path.size ()) {
        if (path[cursor] == '{') {
            // `\{\{[^{}]+\}\}` - a Vayu variable token.
            if (cursor + 1 < path.size () && path[cursor + 1] == '{') {
                size_t scan = cursor + 2;
                while (scan < path.size () && path[scan] != '{' && path[scan] != '}') {
                    ++scan;
                }
                if (scan > cursor + 2 && scan + 1 < path.size () &&
                path[scan] == '}' && path[scan + 1] == '}') {
                    out += "{}";
                    cursor = scan + 2;
                    continue;
                }
            }
            // `\{[^{}]*\}` - the single-brace syntax only OpenAPI writes.
            size_t scan = cursor + 1;
            while (scan < path.size () && path[scan] != '{' && path[scan] != '}') {
                ++scan;
            }
            if (scan < path.size () && path[scan] == '}') {
                out += "{}";
                cursor = scan + 1;
                continue;
            }
        }
        out += path[cursor];
        ++cursor;
    }
    return out;
}

std::string normalize_path_shape (std::string_view path) {
    std::string flattened = flatten_placeholders (path);
    // A trailing slash is not a different endpoint, and importers disagree
    // about whether to keep one. The root stays `/`.
    if (flattened.size () > 1) {
        const size_t last = flattened.find_last_not_of ('/');
        flattened.erase (last == std::string::npos ? 0 : last + 1);
    }
    return flattened;
}

std::string upper (std::string_view text) {
    std::string out (text);
    for (char& c : out) {
        c = static_cast<char> (std::toupper (static_cast<unsigned char> (c)));
    }
    return out;
}

/**
 * Whether a concrete path could be this template with its placeholders filled:
 * the same number of segments, and every non-placeholder segment equal.
 *
 * A placeholder matches one segment and never a `/`, which is what the OpenAPI
 * path-templating rules say - so `/pets/42/toys` is not `/pets/{petId}`.
 */
bool fills_template (std::string_view path_shape, std::string_view template_shape) {
    size_t path_cursor     = 0;
    size_t template_cursor = 0;
    while (path_cursor <= path_shape.size () &&
    template_cursor <= template_shape.size ()) {
        const size_t path_end     = path_shape.find ('/', path_cursor);
        const size_t template_end = template_shape.find ('/', template_cursor);
        const std::string_view path_segment = path_shape.substr (
        path_cursor, path_end == NPOS ? NPOS : path_end - path_cursor);
        const std::string_view template_segment = template_shape.substr (
        template_cursor, template_end == NPOS ? NPOS : template_end - template_cursor);
        if (template_segment != "{}" && template_segment != path_segment) {
            return false;
        }
        // Both must run out together: a differing segment count is a different
        // endpoint, however well the segments before it lined up.
        if (path_end == NPOS || template_end == NPOS) {
            return path_end == NPOS && template_end == NPOS;
        }
        path_cursor     = path_end + 1;
        template_cursor = template_end + 1;
    }
    return false;
}

} // namespace

std::optional<std::string> variable_token_name (std::string_view text) {
    if (text.size () < 5 || text.substr (0, 2) != "{{" ||
    text.substr (text.size () - 2) != "}}") {
        return std::nullopt;
    }
    const std::string_view name = text.substr (2, text.size () - 4);
    if (name.empty () || name.find_first_of ("{}") != std::string_view::npos) {
        return std::nullopt;
    }
    return std::string (name);
}

RequestUrlParts split_request_url (std::string_view url) {
    RequestUrlParts parts;
    std::string_view rest = trim (url);
    if (rest.empty ()) {
        return parts;
    }

    // Query and fragment first: the origin scan must not have to skip them, and
    // a `?` inside a path is not a thing.
    rest = rest.substr (0, std::min (rest.find ('#'), rest.size ()));
    rest = rest.substr (0, std::min (rest.find ('?'), rest.size ()));

    // A leading `{{baseUrl}}` - what every OpenAPI import writes - stands in
    // for the whole origin, so the segment before the first slash is dropped
    // when it is exactly one variable token.
    const size_t first_slash = rest.find ('/');
    const std::string_view head = first_slash == NPOS ? rest : rest.substr (0, first_slash);
    if (is_variable_token (head)) {
        parts.origin = std::string (head);
        rest.remove_prefix (head.size ());
    } else if (const size_t origin_length = origin_prefix_length (rest); origin_length > 0) {
        parts.origin = std::string (rest.substr (0, origin_length));
        rest.remove_prefix (origin_length);
    } else if (!rest.starts_with ('/')) {
        // A schemeless URL (`api.example.com/pets`): the first segment is a
        // host when it looks like one, and a path when it does not.
        if (head.find ('.') != NPOS || head.find (':') != NPOS) {
            parts.origin = std::string (head);
            rest = first_slash == NPOS ? std::string_view () : rest.substr (first_slash);
        }
    }

    if (rest.empty ()) {
        return parts;
    }
    parts.path = rest.starts_with ('/') ? std::string (rest) : "/" + std::string (rest);
    return parts;
}

std::optional<std::string> request_path_shape (std::string_view url) {
    const auto parts = split_request_url (url);
    if (!parts.path) {
        return std::nullopt;
    }
    return normalize_path_shape (*parts.path);
}

std::string spec_path_shape (std::string_view path) {
    return normalize_path_shape (path);
}

std::string operation_shape_key (std::string_view method, std::string_view path_shape) {
    return upper (method) + " " + std::string (path_shape);
}

MatchResult match_operations (const std::vector<MatchableRequest>& requests,
const std::vector<MatchableOperation>& operations) {
    // Both sides' shapes once, not once per comparison: the second pass is a
    // cross product over what the first left open, and a document declaring
    // hundreds of operations would otherwise re-flatten every path per request.
    std::vector<std::optional<std::string>> request_shapes;
    request_shapes.reserve (requests.size ());
    for (const auto& request : requests) {
        request_shapes.push_back (request_path_shape (request.url));
    }
    std::vector<std::string> operation_shapes;
    operation_shapes.reserve (operations.size ());
    for (const auto& operation : operations) {
        operation_shapes.push_back (spec_path_shape (operation.path));
    }

    // Insertion-ordered buckets, so `matched` comes back in the order the caller
    // offered its requests rather than in a hash order that could change under
    // it. A request that states no path is in no bucket and stays unmatched.
    std::vector<std::string> request_keys;
    std::unordered_map<std::string, std::vector<size_t>> requests_by_key;
    for (size_t i = 0; i < requests.size (); ++i) {
        const std::optional<std::string>& shape = request_shapes[i];
        if (!shape) {
            continue;
        }
        const std::string key = operation_shape_key (requests[i].method, *shape);
        auto [entry, inserted] = requests_by_key.try_emplace (key);
        if (inserted) {
            request_keys.push_back (key);
        }
        entry->second.push_back (i);
    }
    std::unordered_map<std::string, std::vector<size_t>> operations_by_key;
    for (size_t j = 0; j < operations.size (); ++j) {
        operations_by_key[operation_shape_key (operations[j].method, operation_shapes[j])]
        .push_back (j);
    }

    MatchResult result;
    std::vector<bool> request_claimed (requests.size (), false);
    std::vector<bool> operation_claimed (operations.size (), false);

    for (const auto& key : request_keys) {
        const auto& candidates          = requests_by_key[key];
        const auto operation_candidates = operations_by_key.find (key);
        // Exactly one on each side, or neither is claimed - see the ambiguity
        // rule in the file header.
        if (candidates.size () != 1 || operation_candidates == operations_by_key.end () ||
        operation_candidates->second.size () != 1) {
            continue;
        }
        result.matched.push_back ({ candidates[0], operation_candidates->second[0] });
        request_claimed[candidates[0]]                     = true;
        operation_claimed[operation_candidates->second[0]] = true;
    }

    /*
     * Second pass, for the requests a hand-built collection is full of: a URL
     * with the id filled in (`/pets/42`) is the same operation as
     * `/pets/{petId}`, and refusing to see that would leave bind-from-here
     * matching almost nothing outside a collection that was itself imported
     * from a document.
     *
     * It runs only over what pass one did not claim, so a literal path in the
     * document always wins over a placeholder it could also have filled - which
     * is the precedence OpenAPI itself gives (`/pets/mine` before
     * `/pets/{petId}`). The uniqueness rule is unchanged and applies in both
     * directions: a request with two candidate operations, or an operation two
     * requests could fill, is left alone.
     */
    std::vector<size_t> open_requests;
    std::unordered_map<size_t, std::vector<size_t>> candidates_for;
    std::unordered_map<size_t, std::vector<size_t>> claimants_of;
    for (size_t i = 0; i < requests.size (); ++i) {
        const std::optional<std::string>& shape = request_shapes[i];
        if (request_claimed[i] || !shape) {
            continue;
        }
        const std::string method = upper (requests[i].method);
        for (size_t j = 0; j < operations.size (); ++j) {
            if (operation_claimed[j] || upper (operations[j].method) != method) {
                continue;
            }
            if (!fills_template (*shape, operation_shapes[j])) {
                continue;
            }
            auto [entry, inserted] = candidates_for.try_emplace (i);
            if (inserted) {
                open_requests.push_back (i);
            }
            entry->second.push_back (j);
            claimants_of[j].push_back (i);
        }
    }
    for (const size_t i : open_requests) {
        const auto& candidates = candidates_for[i];
        if (candidates.size () != 1) {
            continue;
        }
        const size_t operation = candidates[0];
        if (claimants_of[operation].size () != 1) {
            continue;
        }
        result.matched.push_back ({ i, operation });
        request_claimed[i]           = true;
        operation_claimed[operation] = true;
    }

    for (size_t i = 0; i < requests.size (); ++i) {
        if (!request_claimed[i]) {
            result.unmatched_requests.push_back (i);
        }
    }
    for (size_t j = 0; j < operations.size (); ++j) {
        if (!operation_claimed[j]) {
            result.unmatched_operations.push_back (j);
        }
    }
    return result;
}

} // namespace vayu::core
