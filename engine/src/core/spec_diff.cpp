/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/spec_diff.cpp
 * @brief The sync comparison (issue #654, moved engine-side by #854). See the
 *        header for the four rules this must not lose.
 *
 * A port of `app/src/services/openapi/spec-diff.ts`, kept to the same answers
 * rather than to the same code, for the reason `openapi_drafts.cpp` states about
 * the drafts it compares: the two halves have to agree about what a document
 * produces, or a field reads as changed on a document nobody edited. The
 * renderer's copy is deleted with this file's arrival, so there is one answer
 * again rather than two that agree today.
 */

#include "vayu/core/spec_diff.hpp"

#include "vayu/core/operation_match.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace vayu::core {

namespace {

/// Field order for display - the request builder's own top-to-bottom order.
constexpr std::array<SpecField, 7> FIELDS = { SpecField::Name, SpecField::Description,
    SpecField::Method, SpecField::Url, SpecField::Params, SpecField::Headers, SpecField::Body };

/// Long enough to recognise a value by, short enough to sit in a list row.
constexpr size_t DISPLAY_MAX = 120;

/// The one value each field is compared by, and the one shown for it.
struct FieldValue {
    std::string compare;
    std::string display;
};

std::string upper (std::string_view text) {
    std::string out (text);
    std::transform (out.begin (), out.end (), out.begin (), [] (unsigned char c) {
        return static_cast<char> (std::toupper (c));
    });
    return out;
}

/**
 * `value.replace(/\s+/g, " ").trim()`, cut to `DISPLAY_MAX`.
 *
 * Two deliberate readings of the JavaScript this mirrors, both of which only a
 * *displayed* string can reach - the compared value is never truncated:
 *
 * - The collapsed set is ASCII whitespace, where JavaScript's `\s` also covers
 *   NBSP and the Unicode spaces. A document written with those keeps them in the
 *   row it is shown in, which is a cosmetic difference and not a comparison one.
 * - The cut counts UTF-16 code units, as `slice` does, but never lands inside a
 *   character: an astral character straddling the boundary is dropped whole
 *   rather than halved, because half of a surrogate pair is not text this can
 *   put in a JSON response.
 */
std::string truncate (const std::string& value) {
    std::string collapsed;
    collapsed.reserve (value.size ());
    bool in_space = false;
    for (const char c : value) {
        const bool space = c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
        if (space) {
            in_space = true;
            continue;
        }
        if (in_space && !collapsed.empty ()) {
            collapsed.push_back (' ');
        }
        in_space = false;
        collapsed.push_back (c);
    }

    size_t units = 0;
    size_t cut   = 0;
    for (size_t i = 0; i < collapsed.size ();) {
        const auto lead = static_cast<unsigned char> (collapsed[i]);
        size_t width    = 1;
        if ((lead & 0xE0U) == 0xC0U) {
            width = 2;
        } else if ((lead & 0xF0U) == 0xE0U) {
            width = 3;
        } else if ((lead & 0xF8U) == 0xF0U) {
            width = 4;
        }
        // A character outside the BMP is two UTF-16 units, which is what
        // JavaScript counts.
        units += width == 4 ? 2 : 1;
        if (units > DISPLAY_MAX) {
            return collapsed.substr (0, cut) + "\xE2\x80\xA6"; // U+2026 HORIZONTAL ELLIPSIS
        }
        i += width;
        cut = i;
    }
    return collapsed;
}

FieldValue text_value (const std::string& value) {
    return { value, truncate (value) };
}

/**
 * Key/value rows, compared and shown as one line.
 *
 * The row count leads so that two lists of different lengths can never render to
 * the same string however their values are punctuated - a collision here would
 * be a change the comparison failed to see, which is the one failure this must
 * not have. `description` is part of it because a document that re-words what a
 * parameter means has changed the row Vayu shows.
 */
FieldValue rows_value (const std::vector<DraftField>& entries) {
    std::string joined;
    for (const DraftField& entry : entries) {
        if (!joined.empty ()) {
            joined += ", ";
        }
        std::string row = entry.value.empty () ? entry.key : entry.key + "=" + entry.value;
        if (!entry.description.empty ()) {
            row += " (" + entry.description + ")";
        }
        // A multipart part the document declares as an upload is a different row
        // from a text one even when both are empty, which is exactly the state an
        // imported file part is in (issue #425).
        if (entry.file) {
            row += " [file]";
        }
        if (!entry.enabled) {
            row += " [off]";
        }
        joined += row;
    }
    const std::string full = std::to_string (entries.size ()) + ": " + joined;
    return { full, entries.empty () ? std::string ("none") : truncate (full) };
}

FieldValue body_value (const DraftBody& body) {
    if (body.mode.empty () || body.mode == "none") {
        return { "none", "none" };
    }
    if (body.mode == "form-data" || body.mode == "x-www-form-urlencoded") {
        const FieldValue fields = rows_value (body.fields);
        return { body.mode + " " + fields.compare, body.mode + ": " + fields.display };
    }
    return { body.mode + " " + body.content,
        // The mode leads because a body's first 120 characters are frequently
        // identical between two different stubs (`{`, two keys, a newline).
        body.mode + ": " + truncate (body.content) };
}

/// The spec-derived half of one side, field by field, in `FIELDS` order.
using FieldValues = std::array<FieldValue, FIELDS.size ()>;

FieldValues field_values (const std::string& name,
const std::string& description,
const std::string& method,
const std::string& url,
const std::vector<DraftField>& params,
const std::vector<DraftField>& headers,
const DraftBody& body) {
    return { text_value (name), text_value (description),
        // Compared as written, unlike `same_operation`'s uppercasing of the
        // identity: both sides are a stored method, which the engine parses
        // case-sensitively and serialises from an enum, so a lower-case verb is
        // a state no write can reach and normalising for it would guard nothing.
        text_value (method), text_value (url), rows_value (params), rows_value (headers),
        body_value (body) };
}

FieldValues field_values_of (const ComparableRequest& request) {
    return field_values (request.name, request.description, request.method, request.url,
    request.params, request.headers, request.body);
}

FieldValues field_values_of (const DraftRequest& draft) {
    return field_values (draft.name, draft.description, draft.method, draft.url, draft.params,
    draft.headers, draft.body);
}

/** `GET /pets/{}` - the key an identity is followed by when its id cannot be. */
std::string path_key (const DeclaredOperation& operation) {
    return operation_shape_key (operation.method, spec_path_shape (operation.path));
}

/**
 * Whether the recorded identity is still exactly what the document declares.
 *
 * Compared as *written*, not as shaped: `{petId}` -> `{id}` is the same endpoint
 * to `lookup` - which is what keeps the request attached to its operation - but
 * it is a different `spec_operation` to store, and reporting the identity as
 * unchanged would leave the collection recording a path the document no longer
 * uses.
 */
bool same_operation (const DeclaredOperation& a, const DeclaredOperation& b) {
    return a.operation_id == b.operation_id && upper (a.method) == upper (b.method) &&
    a.path == b.path;
}

/**
 * Both keys for every operation, first declaration winning.
 *
 * First rather than last because a document that declares one `operationId`
 * twice is already invalid, and the duplicate then falls out as an `added`
 * operation - visible, rather than silently displacing the one a request is
 * bound to. The reader drops a repeated id from the *identity* rather than
 * stamping it twice (issue #715), so the second declaration arrives here with a
 * method-and-path identity and is indexed by path alone.
 */
class DraftIndex {
    public:
    explicit DraftIndex (const std::vector<SpecRequestDraft>& entries) {
        for (size_t i = 0; i < entries.size (); ++i) {
            const DeclaredOperation& operation = entries[i].operation;
            if (!operation.operation_id.empty ()) {
                by_operation_id_.try_emplace (operation.operation_id, i);
            }
            by_path_.try_emplace (path_key (operation), i);
        }
    }

    /**
     * The document's entry for one recorded identity, and how it was found.
     *
     * The `operationId` leads - that is what follows an operation whose path
     * moved - with two limits, both of them cases where following it would pair
     * a request with an operation that contradicts what the request says it is
     * (issue #715):
     *
     * - an id **two requests claim** identifies neither, so it is skipped;
     * - an id whose entry has a different method + path shape loses to an
     *   **exact match on the request's own** method + path, because a document
     *   still declaring the endpoint the request records is a stronger statement
     *   about which operation this is than an id pointing somewhere else. With
     *   no exact match the id is still followed: that is the ordinary rename,
     *   where the document moved the path and the id is all there is left.
     */
    [[nodiscard]] std::optional<std::pair<size_t, IdentityMatch>>
    lookup (const DeclaredOperation& operation,
    const std::unordered_set<std::string>& ambiguous_ids,
    const std::vector<SpecRequestDraft>& entries) const {
        const std::string key       = path_key (operation);
        const auto by_path          = by_path_.find (key);
        const bool has_path         = by_path != by_path_.end ();
        if (!operation.operation_id.empty () && ambiguous_ids.count (operation.operation_id) == 0) {
            const auto by_id = by_operation_id_.find (operation.operation_id);
            if (by_id != by_operation_id_.end () &&
            (!has_path || path_key (entries[by_id->second].operation) == key)) {
                return std::pair{ by_id->second, IdentityMatch::OperationId };
            }
        }
        if (has_path) {
            return std::pair{ by_path->second, IdentityMatch::Path };
        }
        return std::nullopt;
    }

    private:
    std::unordered_map<std::string, size_t> by_operation_id_;
    std::unordered_map<std::string, size_t> by_path_;
};

/**
 * The `operationId`s more than one request in this collection records - the
 * shape a document that declared one id twice left behind (issue #715).
 *
 * An import no longer stamps a repeated id at all, but a collection imported
 * before that fix still holds two requests claiming one id, and an id two
 * requests claim identifies neither of them. They are followed by path here,
 * which is the same refusal-to-guess the matcher binds by.
 */
std::unordered_set<std::string> ids_more_than_one_request_claims (const std::vector<ComparableRequest>& requests) {
    std::unordered_set<std::string> seen;
    std::unordered_set<std::string> repeated;
    for (const ComparableRequest& request : requests) {
        if (!request.operation || request.operation->operation_id.empty ()) {
            continue;
        }
        const std::string& id = request.operation->operation_id;
        if (!seen.insert (id).second) {
            repeated.insert (id);
        }
    }
    return repeated;
}

/**
 * Everything the request holds that the document no longer produces.
 *
 * A field is reported when the request does not match the new document -
 * "differs from what a fresh import would produce" - and flagged when it does
 * not match the bound document either. Those two questions are separate on
 * purpose: the first is what a sync would change, the second is whether changing
 * it would destroy somebody's work.
 */
std::vector<SpecFieldDiff> diff_fields (const ComparableRequest& request,
const DraftRequest& next,
const DraftRequest* previous) {
    const FieldValues current = field_values_of (request);
    const FieldValues fetched = field_values_of (next);
    const std::optional<FieldValues> bound =
    previous == nullptr ? std::nullopt : std::optional<FieldValues> (field_values_of (*previous));

    std::vector<SpecFieldDiff> out;
    for (size_t i = 0; i < FIELDS.size (); ++i) {
        if (current[i].compare == fetched[i].compare) {
            continue;
        }
        SpecFieldDiff field;
        field.field        = FIELDS[i];
        field.current      = current[i].display;
        field.next         = fetched[i].display;
        field.user_touched = bound.has_value () && current[i].compare != (*bound)[i].compare;
        out.push_back (std::move (field));
    }
    return out;
}

} // namespace

std::string_view spec_field_name (SpecField field) {
    switch (field) {
    case SpecField::Name: return "name";
    case SpecField::Description: return "description";
    case SpecField::Method: return "method";
    case SpecField::Url: return "url";
    case SpecField::Params: return "params";
    case SpecField::Headers: return "headers";
    case SpecField::Body: return "body";
    }
    return "name";
}

SpecDiff diff_spec (const std::vector<SpecRequestDraft>& fetched,
const std::vector<SpecRequestDraft>* bound,
const std::vector<ComparableRequest>& requests) {
    const DraftIndex fetched_index (fetched);
    const std::optional<DraftIndex> bound_index =
    bound == nullptr ? std::nullopt : std::optional<DraftIndex> (*bound);
    const std::unordered_set<std::string> ambiguous_ids = ids_more_than_one_request_claims (requests);

    SpecDiff diff;
    std::vector<bool> claimed (fetched.size (), false);

    for (size_t i = 0; i < requests.size (); ++i) {
        const ComparableRequest& request = requests[i];
        if (!request.operation) {
            diff.unmapped += 1;
            continue;
        }
        const DeclaredOperation& bound_operation = *request.operation;

        const auto found = fetched_index.lookup (bound_operation, ambiguous_ids, fetched);
        if (!found) {
            diff.removed.push_back (i);
            continue;
        }
        claimed[found->first] = true;

        const DraftRequest* previous = nullptr;
        if (bound_index) {
            if (const auto entry = bound_index->lookup (bound_operation, ambiguous_ids, *bound)) {
                previous = &(*bound)[entry->first].draft;
            }
        }

        const SpecRequestDraft& entry = fetched[found->first];
        std::vector<SpecFieldDiff> fields = diff_fields (request, entry.draft, previous);
        const bool renamed = !same_operation (bound_operation, entry.operation);
        if (fields.empty () && !renamed) {
            diff.unchanged += 1;
            continue;
        }

        ChangedRequest changed;
        changed.request          = i;
        changed.draft            = found->first;
        changed.bound_operation  = bound_operation;
        changed.matched_by       = found->second;
        changed.renamed          = renamed;
        changed.previous_unknown = previous == nullptr;
        changed.fields           = std::move (fields);
        diff.changed.push_back (std::move (changed));
    }

    for (size_t i = 0; i < fetched.size (); ++i) {
        if (!claimed[i]) {
            diff.added.push_back (i);
        }
    }
    return diff;
}

} // namespace vayu::core
