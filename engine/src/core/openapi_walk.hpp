#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/openapi_walk.hpp
 * @brief The one walk over a document's operations, shared by everything that
 *        reads one (issues #853, #865).
 *
 * Internal to `src/core` - it hands out pointers into a caller-owned DOM, so it
 * is not a shape the public header should offer. It is a header rather than a
 * static in one translation unit because three answers are derived from the
 * same operations and must not disagree about which ones exist: the `operations`
 * index and the `responseSchemas` index (`openapi_document.cpp`) and the request
 * drafts an import would build (`openapi_drafts.cpp`). Two walks would be two
 * opinions about which of two operations kept a repeated `operationId`, and the
 * failure that produces is silent - a stamp resolving to the wrong operation.
 */

#include "vayu/core/spec_coverage.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <nlohmann/json.hpp>
#include <string>
#include <unordered_set>
#include <vector>

namespace vayu::core::walk {

/// The seven methods Vayu executes, in the order the import parsers walk them,
/// which is therefore the order the index writes rows in. `trace` is not one:
/// no request can carry an identity Vayu has no verb for.
constexpr std::array<const char*, 7> HTTP_METHODS = { "get", "post", "put", "patch", "delete",
    "head", "options" };

inline const nlohmann::ordered_json* find_object (const nlohmann::ordered_json& node, const char* key) {
    if (!node.is_object ()) {
        return nullptr;
    }
    const auto found = node.find (key);
    if (found == node.end () || !found->is_object ()) {
        return nullptr;
    }
    return &(*found);
}

inline std::string upper (std::string value) {
    std::transform (value.begin (), value.end (), value.begin (),
    [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
    return value;
}

inline std::string lower (std::string value) {
    std::transform (value.begin (), value.end (), value.begin (),
    [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
    return value;
}

/// Which of the two formats Vayu imports a document claims to be. `None` is
/// not an error - the document may be a perfectly good file that simply is not
/// a contract, which is `NotASpecError` on the renderer side.
enum class Dialect { None, V2, V3 };

/**
 * @brief The dialect @p document declares, by the renderer's detection order.
 *
 * v3 is asked first and v2 second, exactly as `PARSERS` in
 * `app/src/services/importers/factory.ts` orders them - a document carrying
 * both keys is claimed by the same parser on both sides. The parameter and body
 * rules differ between the two (2.0 states a value as `default` and puts the
 * body in a parameter; 3.x has `example`/`examples` and a `requestBody`), so
 * every reader of an operation needs this answer, not just a yes/no.
 */
inline Dialect spec_dialect (const nlohmann::ordered_json& document) {
    if (!document.is_object ()) {
        return Dialect::None;
    }
    if (const auto version = document.find ("openapi");
        version != document.end () && version->is_string ()) {
        return version->get<std::string> ().rfind ("3.", 0) == 0 ? Dialect::V3 : Dialect::None;
    }
    const auto swagger = document.find ("swagger");
    if (swagger == document.end ()) {
        return Dialect::None;
    }
    // `2.0` unquoted is a number in YAML and in JSON alike, and generated
    // documents write it both ways - the renderer's detector accepts both.
    const bool claimed = (swagger->is_string () && swagger->get<std::string> () == "2.0") ||
    (swagger->is_number () && swagger->get<double> () == 2.0);
    return claimed ? Dialect::V2 : Dialect::None;
}

/// Whether the document claims to be one of the two formats Vayu imports.
inline bool is_openapi (const nlohmann::ordered_json& document) {
    return spec_dialect (document) != Dialect::None;
}

/**
 * A JSON Pointer into the document, for the one `$ref` hop a path item may be.
 *
 * In-document only, exactly as `createRefResolver` is: a ref naming another
 * file has no `#/` to strip, so every segment names a key no document has and
 * the walk lands on nothing. External refs are inlined before a document is
 * stored (the renderer's ref bundler), and one still external by now is one the
 * user has already been told about.
 */
inline const nlohmann::ordered_json*
resolve_ref (const nlohmann::ordered_json& document, const std::string& ref) {
    std::string_view pointer (ref);
    if (pointer.rfind ("#/", 0) == 0) {
        pointer.remove_prefix (2);
    } else if (pointer == "#") {
        return &document;
    }
    const nlohmann::ordered_json* node = &document;
    size_t start                       = 0;
    while (start <= pointer.size ()) {
        const size_t slash = pointer.find ('/', start);
        std::string segment (pointer.substr (start,
        slash == std::string_view::npos ? std::string_view::npos : slash - start));
        // JSON Pointer's two escapes, `~1` before `~0` so an escaped tilde in a
        // path key does not turn into a slash.
        for (size_t at = segment.find ("~1"); at != std::string::npos; at = segment.find ("~1", at)) {
            segment.replace (at, 2, "/");
            at += 1;
        }
        for (size_t at = segment.find ("~0"); at != std::string::npos; at = segment.find ("~0", at)) {
            segment.replace (at, 2, "~");
            at += 1;
        }
        if (!node->is_object ()) {
            return nullptr;
        }
        const auto found = node->find (segment);
        if (found == node->end ()) {
            return nullptr;
        }
        node = &(*found);
        if (slash == std::string_view::npos) {
            break;
        }
        start = slash + 1;
    }
    return node;
}

/**
 * A node that may be `{"$ref": ...}` standing in for the real one, resolved one
 * hop. `nullptr` when there is nothing behind it, which drops what was being
 * read rather than walking a `$ref` node as though it were the thing it names.
 *
 * Both places a document writes this shape: a Path Item Object hoisted into
 * `components.pathItems` by a bundler, whose absence drops every operation under
 * that path, and a Response Object hoisted into `components.responses` (issue
 * #714) - the form GitHub's public spec uses for nearly every response.
 *
 * Single-hop, like every ref the import parsers follow: a ref to a ref is not a
 * shape generators emit, and chasing one needs a cycle guard.
 */
inline const nlohmann::ordered_json*
resolve_single_hop (const nlohmann::ordered_json& document, const nlohmann::ordered_json& item) {
    if (!item.is_object ()) {
        return nullptr;
    }
    const auto ref = item.find ("$ref");
    if (ref == item.end () || !ref->is_string ()) {
        return &item;
    }
    const nlohmann::ordered_json* resolved = resolve_ref (document, ref->get<std::string> ());
    return resolved != nullptr && resolved->is_object () ? resolved : nullptr;
}

/// The status patterns an operation's `responses` map declares, verbatim and in
/// document order. A `$ref`-ed response object still writes its status *key*
/// here, so nothing needs resolving to read them.
inline std::vector<std::string> declared_responses_of (const nlohmann::ordered_json& operation) {
    std::vector<std::string> patterns;
    const nlohmann::ordered_json* responses = find_object (operation, "responses");
    if (responses == nullptr) {
        return patterns;
    }
    for (auto entry = responses->begin (); entry != responses->end (); ++entry) {
        if (!entry.key ().empty ()) {
            patterns.push_back (entry.key ());
        }
    }
    return patterns;
}

/// One operation the document declares, as every reader of one sees it: the
/// identity the operation index stores, the node the schema index reads, and
/// the Path Item Object it hangs off - which the request drafts need for the
/// `parameters` a path declares once for all of its operations. Produced by one
/// walk so no two readers can disagree about which operations exist, which of
/// them owns an `operationId`, or which statuses one declares.
struct WalkedOperation {
    DeclaredOperation identity;
    const nlohmann::ordered_json* node;
    /// Never null; the walk resolves the single `$ref` hop a path item may be.
    const nlohmann::ordered_json* path_item;
};

inline std::vector<WalkedOperation> walk_operations (const nlohmann::ordered_json& document) {
    std::vector<WalkedOperation> walked;
    if (!is_openapi (document)) {
        return walked;
    }
    const nlohmann::ordered_json* paths = find_object (document, "paths");
    if (paths == nullptr) {
        return walked;
    }

    /// Every `operationId` already stamped, so a repeated one is kept on its
    /// first declaration only (issue #715).
    std::unordered_set<std::string> claimed_ids;

    for (auto entry = paths->begin (); entry != paths->end (); ++entry) {
        const std::string& path             = entry.key ();
        const nlohmann::ordered_json* item = resolve_single_hop (document, entry.value ());
        if (item == nullptr) {
            continue;
        }
        for (const char* method : HTTP_METHODS) {
            const nlohmann::ordered_json* operation = find_object (*item, method);
            if (operation == nullptr) {
                continue;
            }
            if (path.empty () || path[0] != '/') {
                // A `paths` key that is not a path: the request an import builds
                // for it carries no identity either, so neither does this index.
                continue;
            }
            DeclaredOperation row;
            row.method = upper (method);
            row.path   = path;
            if (const auto id = operation->find ("operationId");
                id != operation->end () && id->is_string () && !id->get<std::string> ().empty ()) {
                const std::string operation_id = id->get<std::string> ();
                if (claimed_ids.insert (operation_id).second) {
                    row.operation_id = operation_id;
                }
            }
            row.responses = declared_responses_of (*operation);
            walked.push_back ({ std::move (row), operation, item });
        }
    }
    return walked;
}

} // namespace vayu::core::walk
