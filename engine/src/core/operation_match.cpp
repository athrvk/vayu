/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/operation_match.hpp"

#include "vayu/core/path_template.hpp"
#include "vayu/utils/ascii_case.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <unordered_map>
#include <utility>

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

/// @p path with each Postman `:name` path variable (issue #1764) already
/// flattened to `{}` - a request stored as `/pets/:petId` is the operation
/// `/pets/{petId}` exactly as `/pets/{{petId}}` is. A `.suffix` after the name
/// stays, as it does after a `{{name}}`.
std::string flatten_colon_variables (std::string_view path) {
    std::string out;
    size_t copied = 0;
    for (const auto& segment : vayu::core::path_variable_segments (path)) {
        out.append (path.substr (copied, segment.offset - copied));
        out += "{}";
        copied = segment.offset + segment.length;
    }
    out.append (path.substr (copied));
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

/**
 * Whether @p segment is @p pattern, one path segment of a flattened template,
 * with each `{}` filled.
 *
 * A segment of only `{}` takes anything. One mixing literal text with
 * placeholders (`{}.json`, `{}:cancel`, `meta-{}`, #3085) takes a segment that
 * starts with the text before the first `{}`, ends with the text after the
 * last, and holds the text between them in order. A placeholder inside such a
 * segment is never empty, so `meta-` does not fill `meta-{}`.
 */
bool segment_fills_template (std::string_view segment, std::string_view pattern) {
    constexpr std::string_view PLACEHOLDER = "{}";
    if (pattern == PLACEHOLDER) {
        return true;
    }
    const size_t first = pattern.find (PLACEHOLDER);
    if (first == NPOS) {
        return segment == pattern;
    }
    size_t placeholder          = first;
    const size_t last           = pattern.rfind (PLACEHOLDER);
    const std::string_view head = pattern.substr (0, first);
    const std::string_view tail = pattern.substr (last + PLACEHOLDER.size ());
    if (segment.size () < head.size () + tail.size () ||
    !segment.starts_with (head) || !segment.ends_with (tail)) {
        return false;
    }
    // The leftmost fit of each literal between two placeholders leaves the most
    // room for the rest, so one greedy pass decides.
    size_t cursor = head.size ();
    while (placeholder != last) {
        const size_t literal_begin = placeholder + PLACEHOLDER.size ();
        const size_t next          = pattern.find (PLACEHOLDER, literal_begin);
        const std::string_view literal =
        pattern.substr (literal_begin, next - literal_begin);
        const size_t found = segment.find (literal, cursor + 1);
        if (found == NPOS) {
            return false;
        }
        cursor      = found + literal.size ();
        placeholder = next;
    }
    return cursor < segment.size () - tail.size ();
}

/**
 * Whether a concrete path could be this template with its placeholders filled:
 * the same number of segments, and every segment filling its template segment.
 *
 * A placeholder matches within one segment and never a `/`, which is what the
 * OpenAPI path-templating rules say - so `/pets/42/toys` is not `/pets/{petId}`.
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
        if (!segment_fills_template (path_segment, template_segment)) {
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
    return normalize_path_shape (flatten_colon_variables (*parts.path));
}

std::string spec_path_shape (std::string_view path) {
    // OpenAPI has no `:name` spelling, but an Express-style `/users/:id` is a
    // common invalid path the importer keeps verbatim (`openapi_drafts.cpp`),
    // and a request drafted from it keeps `:id`: flattened on one side only,
    // that request would no longer match the operation it was drafted from.
    return normalize_path_shape (flatten_colon_variables (path));
}

std::string operation_shape_key (std::string_view method, std::string_view path_shape) {
    return vayu::utils::ascii_upper (method) + " " + std::string (path_shape);
}

namespace {

/// The path shapes each request is offered under, by request index: none for a
/// request that states no path, its own shape in the first two passes, and one
/// per base path it sits under in the third.
using RequestShapes = std::vector<std::vector<std::string>>;

/** What every pass reads and extends: the pairs so far, and who is taken. */
struct MatchState {
    MatchResult result;
    std::vector<bool> request_claimed;
    std::vector<bool> operation_claimed;
};

/**
 * The pairings one pass found possible, before the ambiguity rule decides which
 * it may make - the one place that rule is written, for every pass.
 *
 * A pass adds each (request, operation) pair at most once; a request offered
 * under several shapes is still one claimant.
 */
class CandidatePairs {
    public:
    void add (size_t request, size_t operation) {
        auto [entry, inserted] = candidates_for_.try_emplace (request);
        if (inserted) {
            open_requests_.push_back (request);
        }
        entry->second.push_back (operation);
        claimants_of_[operation].push_back (request);
    }

    /**
     * Pair every request that has exactly one candidate, where that operation
     * has exactly one claimant - see the ambiguity rule in the file header.
     * Requests are visited in the order they were offered, so `matched` does
     * not follow a hash order that could change under the caller.
     */
    void claim_unambiguous (MatchState& state) const {
        for (const size_t request : open_requests_) {
            const auto& candidates = candidates_for_.at (request);
            if (candidates.size () != 1) {
                continue;
            }
            const size_t operation = candidates[0];
            if (claimants_of_.at (operation).size () != 1) {
                continue;
            }
            state.result.matched.push_back ({ request, operation });
            state.request_claimed[request]     = true;
            state.operation_claimed[operation] = true;
        }
    }

    private:
    std::vector<size_t> open_requests_;
    std::unordered_map<size_t, std::vector<size_t>> candidates_for_;
    std::unordered_map<size_t, std::vector<size_t>> claimants_of_;
};

/**
 * A request and an operation whose method and path *shape* are equal, and which
 * are the only ones with that shape on their side. A request that states no
 * path has no shape and stays unmatched.
 */
void match_exact_shapes (const std::vector<MatchableRequest>& requests,
const std::vector<MatchableOperation>& operations,
const RequestShapes& request_shapes,
const std::vector<std::string>& operation_shapes,
MatchState& state) {
    std::unordered_map<std::string, std::vector<size_t>> operations_by_key;
    for (size_t j = 0; j < operations.size (); ++j) {
        if (!state.operation_claimed[j]) {
            operations_by_key[operation_shape_key (operations[j].method, operation_shapes[j])]
            .push_back (j);
        }
    }

    CandidatePairs pairs;
    for (size_t i = 0; i < requests.size (); ++i) {
        if (state.request_claimed[i]) {
            continue;
        }
        // One request's shapes are distinct, so their keys are too and no
        // operation is added twice for it.
        for (const std::string& shape : request_shapes[i]) {
            const auto found =
            operations_by_key.find (operation_shape_key (requests[i].method, shape));
            if (found == operations_by_key.end ()) {
                continue;
            }
            for (const size_t j : found->second) {
                pairs.add (i, j);
            }
        }
    }
    pairs.claim_unambiguous (state);
}

/**
 * For the requests a hand-built collection is full of: a URL with the id filled
 * in (`/pets/42`) is the same operation as `/pets/{petId}`, and refusing to see
 * that would leave bind-from-here matching almost nothing outside a collection
 * that was itself imported from a document.
 *
 * It runs only over what the exact comparison did not claim, so a literal path
 * in the document always wins over a placeholder it could also have filled -
 * which is the precedence OpenAPI itself gives (`/pets/mine` before
 * `/pets/{petId}`).
 */
void match_filled_templates (const std::vector<MatchableRequest>& requests,
const std::vector<MatchableOperation>& operations,
const RequestShapes& request_shapes,
const std::vector<std::string>& operation_shapes,
MatchState& state) {
    CandidatePairs pairs;
    for (size_t i = 0; i < requests.size (); ++i) {
        const std::vector<std::string>& shapes = request_shapes[i];
        if (state.request_claimed[i] || shapes.empty ()) {
            continue;
        }
        const std::string method = vayu::utils::ascii_upper (requests[i].method);
        for (size_t j = 0; j < operations.size (); ++j) {
            if (state.operation_claimed[j] ||
            vayu::utils::ascii_upper (operations[j].method) != method) {
                continue;
            }
            const std::string& template_shape = operation_shapes[j];
            if (std::ranges::any_of (shapes, [&] (const std::string& shape) {
                    return fills_template (shape, template_shape);
                })) {
                pairs.add (i, j);
            }
        }
    }
    pairs.claim_unambiguous (state);
}

/**
 * The base paths a caller named, reduced the way a spec path is and with the
 * ones that name nothing to strip dropped: an entry that is not absolute, the
 * root, and a repeat.
 */
std::vector<std::string> base_path_shapes (const std::vector<std::string>& base_paths) {
    std::vector<std::string> shapes;
    for (const std::string& base_path : base_paths) {
        const std::string_view written = trim (base_path);
        if (!written.starts_with ('/')) {
            continue;
        }
        std::string shape = spec_path_shape (written);
        if (shape.size () <= 1 || std::ranges::find (shapes, shape) != shapes.end ()) {
            continue;
        }
        shapes.push_back (std::move (shape));
    }
    return shapes;
}

/**
 * @p shape with @p base taken off its front, or nothing when @p shape does not
 * sit under it.
 *
 * Whole segments only: `/v1` is a prefix of `/v1/pets` and not of `/v10/pets`.
 * A placeholder segment of the base (`{}`, from a templated `/{version}`)
 * stands for any one non-empty segment, and one mixing text with a placeholder
 * (`api-{}`) fills the way a template segment does. A request that is exactly
 * the base path is the root operation, `/`.
 */
std::optional<std::string> strip_base_path (std::string_view shape, std::string_view base) {
    // Both start with `/`; each round compares the segment after a cursor.
    size_t shape_cursor = 0;
    size_t base_cursor  = 0;
    while (base_cursor < base.size ()) {
        if (shape_cursor >= shape.size ()) {
            return std::nullopt; // the request ends inside the base path
        }
        const size_t base_end =
        std::min (base.find ('/', base_cursor + 1), base.size ());
        const size_t shape_end =
        std::min (shape.find ('/', shape_cursor + 1), shape.size ());
        const std::string_view base_segment =
        base.substr (base_cursor + 1, base_end - base_cursor - 1);
        const std::string_view shape_segment =
        shape.substr (shape_cursor + 1, shape_end - shape_cursor - 1);
        const bool same = base_segment == "{}" ?
        !shape_segment.empty () :
        segment_fills_template (shape_segment, base_segment);
        if (!same) {
            return std::nullopt;
        }
        base_cursor  = base_end;
        shape_cursor = shape_end;
    }
    return shape_cursor == shape.size () ? std::string ("/") :
                                           std::string (shape.substr (shape_cursor));
}

/**
 * Each still-open request's shape with every base path it sits under taken off,
 * computed once for both comparisons of the third pass. Two base paths can
 * leave the same shape behind (`/v1` and `/{version}` both make `/v1/pets`
 * `/pets`), which is one shape, not two.
 */
RequestShapes shapes_under_base_paths (const RequestShapes& request_shapes,
const std::vector<std::string>& base_shapes,
const std::vector<bool>& request_claimed) {
    RequestShapes stripped (request_shapes.size ());
    for (size_t i = 0; i < request_shapes.size (); ++i) {
        if (request_claimed[i]) {
            continue;
        }
        for (const std::string& shape : request_shapes[i]) {
            for (const std::string& base : base_shapes) {
                std::optional<std::string> rest = strip_base_path (shape, base);
                if (rest &&
                std::ranges::find (stripped[i], *rest) == stripped[i].end ()) {
                    stripped[i].push_back (std::move (*rest));
                }
            }
        }
    }
    return stripped;
}

} // namespace

MatchResult match_operations (const std::vector<MatchableRequest>& requests,
const std::vector<MatchableOperation>& operations,
const std::vector<std::string>& base_paths) {
    // Both sides' shapes once, not once per comparison: the template comparison
    // is a cross product over what the exact one left open, and a document
    // declaring hundreds of operations would otherwise re-flatten every path
    // per request.
    RequestShapes request_shapes (requests.size ());
    for (size_t i = 0; i < requests.size (); ++i) {
        if (std::optional<std::string> shape = request_path_shape (requests[i].url)) {
            request_shapes[i].push_back (std::move (*shape));
        }
    }
    std::vector<std::string> operation_shapes;
    operation_shapes.reserve (operations.size ());
    for (const auto& operation : operations) {
        operation_shapes.push_back (spec_path_shape (operation.path));
    }

    MatchState state{ {}, std::vector<bool> (requests.size (), false),
        std::vector<bool> (operations.size (), false) };
    match_exact_shapes (requests, operations, request_shapes, operation_shapes, state);
    match_filled_templates (requests, operations, request_shapes, operation_shapes, state);

    // The third pass, over what the first two left open (see the file header).
    if (const std::vector<std::string> bases = base_path_shapes (base_paths);
    !bases.empty ()) {
        const RequestShapes stripped =
        shapes_under_base_paths (request_shapes, bases, state.request_claimed);
        match_exact_shapes (requests, operations, stripped, operation_shapes, state);
        match_filled_templates (requests, operations, stripped, operation_shapes, state);
    }

    for (size_t i = 0; i < requests.size (); ++i) {
        if (!state.request_claimed[i]) {
            state.result.unmatched_requests.push_back (i);
        }
    }
    for (size_t j = 0; j < operations.size (); ++j) {
        if (!state.operation_claimed[j]) {
            state.result.unmatched_operations.push_back (j);
        }
    }
    return std::move (state.result);
}

} // namespace vayu::core
