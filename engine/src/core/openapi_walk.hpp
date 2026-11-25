#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The one walk over a document's operations, shared by every reader (#853,
 * #865).
 *
 * Internal to `src/core`: it hands out pointers into a caller-owned DOM, no
 * shape for the public header. A header, not a static in one translation unit,
 * because three answers come from the same operations and must agree on which
 * exist: the `operations` and `responseSchemas` indexes
 * (`openapi_document.cpp`) and an import's request drafts
 * (`openapi_drafts.cpp`). Two walks would be two opinions on which of two
 * operations kept a repeated `operationId`, and that failure is silent: a stamp
 * resolving to the wrong operation.
 */

#include "js_json.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/utils/ascii_case.hpp"

#include <array>
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

namespace vayu::core::walk {

/// The seven methods Vayu executes, in the order the import parsers walk them,
/// which is therefore the order the index writes rows in. `trace` is not one:
/// no request can carry an identity Vayu has no verb for.
constexpr std::array<const char*, 7> HTTP_METHODS = { "get", "post", "put",
    "patch", "delete", "head", "options" };

inline const nlohmann::ordered_json*
find_object (const nlohmann::ordered_json& node, const char* key) {
    if (!node.is_object ()) {
        return nullptr;
    }
    const auto found = node.find (key);
    if (found == node.end () || !found->is_object ()) {
        return nullptr;
    }
    return &(*found);
}

/// Which of the two formats Vayu imports a document claims to be. `None` is no
/// error: the document may be a good file that is not a contract
/// (`NotASpecError` on the renderer side).
enum class Dialect : std::uint8_t { None, V2, V3 };

/**
 * The dialect @p document declares, in the renderer's detection order: v3
 * first, then v2, as `PARSERS` in `app/src/services/importers/factory.ts`, so a
 * document carrying both keys is claimed by the same parser on both sides. The
 * parameter and body rules differ (2.0 states a value as `default` and puts the
 * body in a parameter; 3.x has `example` / `examples` and a `requestBody`), so
 * every reader of an operation needs this answer, not a yes/no.
 */
inline Dialect spec_dialect (const nlohmann::ordered_json& document) {
    if (!document.is_object ()) {
        return Dialect::None;
    }
    if (const auto version = document.find ("openapi");
    version != document.end () && version->is_string ()) {
        return version->get<std::string> ().rfind ("3.", 0) == 0 ? Dialect::V3 :
                                                                   Dialect::None;
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

/**
 * The `format` a document's dialect is reported as, telling 3.1 from 3.0
 * (#1444); @ref spec_dialect folds both into `V3` for readers needing only "is
 * this 3.x". `None` reports empty, every caller's "readable, not a contract".
 */
inline std::string
dialect_format_name (const nlohmann::ordered_json& document, Dialect dialect) {
    switch (dialect) {
    case Dialect::V3: {
        const auto version = document.find ("openapi");
        const bool is_31 = version != document.end () && version->is_string () &&
        version->get_ref<const std::string&> ().rfind ("3.1", 0) == 0;
        return is_31 ? "OpenAPI 3.1" : "OpenAPI 3.0";
    }
    case Dialect::V2: return "OpenAPI 2.0 (Swagger)";
    case Dialect::None: return {};
    }
    return {};
}

/// Whether the document claims to be one of the two formats Vayu imports.
inline bool is_openapi (const nlohmann::ordered_json& document) {
    return spec_dialect (document) != Dialect::None;
}

/**
 * A 3.x Server Object's `url` with each `{name}` that `variables` gives a
 * scalar `default` substituted (#719), or nothing when @p server names no URL
 * (not an object, no or an empty `url`). A `{name}` with no usable default is
 * kept as written. Shared by the import, which makes `servers[0]`
 * `{{baseUrl}}`, and `base_paths_of`, which reads every server's path, so the
 * two cannot disagree.
 */
inline std::optional<std::string> server_url_with_defaults (
const nlohmann::ordered_json* server) {
    const std::string* declared = js::as_str (js::prop (server, "url"));
    if (declared == nullptr || declared->empty ()) {
        return std::nullopt;
    }
    const nlohmann::ordered_json* variables =
    js::as_record (js::prop (server, "variables"));

    std::string substituted;
    for (size_t at = 0; at < declared->size ();) {
        if ((*declared)[at] != '{') {
            substituted += (*declared)[at];
            ++at;
            continue;
        }
        const size_t close = declared->find_first_of ("{}/", at + 1);
        if (close == std::string::npos || (*declared)[close] != '}' || close == at + 1) {
            substituted += (*declared)[at];
            ++at;
            continue;
        }
        const std::string name = declared->substr (at + 1, close - at - 1);
        const nlohmann::ordered_json* value =
        js::prop (js::as_record (js::prop (variables, name)), "default");
        // A default is `string` per the specification; a number or boolean is
        // what a hand-written document produces and reads the same on the wire.
        if (value == nullptr || value->is_structured () || value->is_null ()) {
            substituted += declared->substr (at, close - at + 1);
        } else {
            substituted += value->is_string () ? value->get<std::string> () :
                                                 js::js_string_of (*value);
        }
        at = close + 1;
    }
    return substituted;
}

/**
 * A JSON Pointer into the document, for the one `$ref` hop a path item may be.
 * In-document only, as `createRefResolver` is: a ref naming another file has no
 * `#/` to strip, so the walk lands on nothing. External refs are inlined before
 * storage (the renderer's ref bundler), and one still external has already been
 * reported to the user.
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
        for (size_t at = segment.find ("~1"); at != std::string::npos;
        at             = segment.find ("~1", at)) {
            segment.replace (at, 2, "/");
            at += 1;
        }
        for (size_t at = segment.find ("~0"); at != std::string::npos;
        at             = segment.find ("~0", at)) {
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
 * hop; `nullptr` when nothing is behind it, which drops what was being read
 * rather than walk a `$ref` node as the thing it names.
 *
 * Both places a document writes this: a Path Item Object a bundler hoisted into
 * `components.pathItems` (whose absence drops every operation under that path),
 * and a Response Object hoisted into `components.responses` (#714), the form
 * GitHub's public spec uses for nearly every response.
 *
 * Single-hop, like every ref the import parsers follow: generators emit no ref
 * to a ref, and chasing one needs a cycle guard.
 */
inline const nlohmann::ordered_json* resolve_single_hop (const nlohmann::ordered_json& document,
const nlohmann::ordered_json& item) {
    if (!item.is_object ()) {
        return nullptr;
    }
    const auto ref = item.find ("$ref");
    if (ref == item.end () || !ref->is_string ()) {
        return &item;
    }
    const nlohmann::ordered_json* resolved =
    resolve_ref (document, ref->get<std::string> ());
    return resolved != nullptr && resolved->is_object () ? resolved : nullptr;
}

/// Whether a key of an operation's `responses` map names a status: every key
/// but an empty one and a specification extension (`x-`, the Responses Object's
/// one non-status member). Not a digit test: `default`, `2XX` and a
/// hand-written pattern are statuses kept verbatim (#3084). Every reader of
/// `responses` asks it, so the indexes agree.
inline bool is_declared_status_key (const std::string& key) {
    return !key.empty () && !key.starts_with ("x-");
}

/// The status patterns an operation's `responses` declares, verbatim, in
/// document order. A `$ref`-ed response still writes its status key here, so
/// nothing needs resolving. Extensions are not statuses
/// (`is_declared_status_key`).
inline std::vector<std::string> declared_responses_of (const nlohmann::ordered_json& operation) {
    std::vector<std::string> patterns;
    const nlohmann::ordered_json* responses = find_object (operation, "responses");
    if (responses == nullptr) {
        return patterns;
    }
    for (auto entry = responses->begin (); entry != responses->end (); ++entry) {
        if (is_declared_status_key (entry.key ())) {
            patterns.push_back (entry.key ());
        }
    }
    return patterns;
}

/**
 * What a walk stepped over on the way to the operations (#877). Counts, not
 * positions: an import reports them as `meta.skipped` counters. Filled only
 * when a caller asks; the three index readers do not, as a malformed member
 * does not change what the document declares.
 */
struct WalkNotes {
    /// A `paths` entry that is not a readable Path Item Object, and a
    /// `parameters` member of one that is not an array (the missing `-` in
    /// hand-written YAML). Both are `malformed_spec` to a caller.
    int malformed_spec = 0;
    /// A 3.x path item's `trace`, the one method Vayu has no verb for.
    int unsupported_method = 0;
    /**
     * An `operationId` a previous operation already claimed (#715). The
     * operation imports whole, only the repeated id dropped from its identity;
     * it is counted because a sync follows the identity a request records, so
     * which request kept the id must not be found out from a diff.
     */
    int duplicate_operation_id = 0;
    /**
     * A 3.1 top-level `webhooks` entry's operation (#1444). A webhook describes
     * what the API sends to a callback URL the user registers elsewhere, not a
     * request Vayu can send, so it is counted, not walked into a sendable
     * request.
     */
    int webhook_operations = 0;
};

/// One declared operation as every reader sees it: the identity the operation
/// index stores, the node the schema index reads, and its Path Item Object (the
/// drafts need the `parameters` a path declares once for its operations). One
/// walk produces them, so no two readers disagree about which operations exist,
/// which owns an `operationId`, or which statuses one declares.
struct WalkedOperation {
    DeclaredOperation identity;
    const nlohmann::ordered_json* node;
    /// Never null; the walk resolves the single `$ref` hop a path item may be.
    const nlohmann::ordered_json* path_item;
    /**
     * Whether the `paths` key this hangs off is a path at all. A key not
     * starting with `/` is a malformed entry, and @ref identity says nothing an
     * index or a sync may follow, so every reader of identities skips these
     * rows. The import does not (#877): the renderer's parsers build and count
     * a request for such an operation, stamped with no `specOperation`, and
     * dropping it would lose a request the user sees in their file.
     *
     * Carried on the walk, not re-derived per reader, because `identity`
     * already answered it: no id is claimed for one of these either, so which
     * of two operations keeps a repeated `operationId` stays one walk's answer.
     */
    bool identified = true;
};

/// The skipped members one path item hides from the walk (#877), counted once
/// per item before its methods, where the renderer's parsers count them. A
/// non-array `parameters` is the missing `-` in hand-written YAML; `trace` is a
/// Path Item Object member in 3.x only, and only a present object is a dropped
/// operation.
inline void note_skipped_members (Dialect dialect,
const nlohmann::ordered_json& item,
WalkNotes& notes) {
    if (const auto parameters = item.find ("parameters"); parameters != item.end () &&
    !parameters->is_null () && !parameters->is_array ()) {
        notes.malformed_spec += 1;
    }
    if (dialect == Dialect::V3) {
        const auto trace = item.find ("trace");
        if (trace != item.end () && trace->is_structured ()) {
            notes.unsupported_method += 1;
        }
    }
}

/// The `operationId` @p operation keeps: its declared id, or ""
/// (`DeclaredOperation`'s no-id spelling) when it declares none, a non-string
/// or empty one, or one a previous operation claimed (#715). Only the repeat is
/// counted on @p notes, for the reason `WalkNotes::duplicate_operation_id`
/// gives.
inline std::string claim_operation_id (const nlohmann::ordered_json& operation,
std::unordered_set<std::string>& claimed_ids,
WalkNotes* notes) {
    const auto id = operation.find ("operationId");
    if (id == operation.end () || !id->is_string ()) {
        return "";
    }
    std::string operation_id = id->get<std::string> ();
    if (operation_id.empty ()) {
        return "";
    }
    if (claimed_ids.insert (operation_id).second) {
        return operation_id;
    }
    if (notes != nullptr) {
        notes->duplicate_operation_id += 1;
    }
    return "";
}

/// Every operation one resolved Path Item Object declares, appended to
/// @p walked in `HTTP_METHODS` order. `claimed_ids` is document-wide (a
/// repeated `operationId` spans path items), so the set outlives each call.
inline void walk_path_item (const std::string& path,
const nlohmann::ordered_json& item,
std::unordered_set<std::string>& claimed_ids,
WalkNotes* notes,
std::vector<WalkedOperation>& walked) {
    // A `paths` key that is not a path declares no operation
    // (`WalkedOperation::identified`). The row is still walked, since the
    // import builds a request for it, but claims no `operationId`: the identity
    // it would sit on does not exist.
    const bool identified = !path.empty () && path[0] == '/';
    for (const char* method : HTTP_METHODS) {
        const nlohmann::ordered_json* operation = find_object (item, method);
        if (operation == nullptr) {
            continue;
        }
        DeclaredOperation row;
        row.method = vayu::utils::ascii_upper (method);
        row.path   = path;
        if (identified) {
            row.operation_id = claim_operation_id (*operation, claimed_ids, notes);
        }
        row.responses = declared_responses_of (*operation);
        walked.push_back ({ std::move (row), operation, &item, identified });
    }
}

/// Every HTTP-method key a 3.1 `webhooks` entry's Path Item Object declares,
/// counted rather than walked - see `WalkNotes::webhook_operations`.
inline void note_webhook_operations (const nlohmann::ordered_json& document, WalkNotes& notes) {
    const nlohmann::ordered_json* webhooks = find_object (document, "webhooks");
    if (webhooks == nullptr) {
        return;
    }
    for (auto entry = webhooks->begin (); entry != webhooks->end (); ++entry) {
        const nlohmann::ordered_json* item =
        resolve_single_hop (document, entry.value ());
        if (item == nullptr) {
            continue;
        }
        for (const char* method : HTTP_METHODS) {
            if (const auto found = item->find (method);
            found != item->end () && found->is_object ()) {
                notes.webhook_operations += 1;
            }
        }
    }
}

inline std::vector<WalkedOperation>
walk_operations (const nlohmann::ordered_json& document, WalkNotes* notes = nullptr) {
    std::vector<WalkedOperation> walked;
    const Dialect dialect = spec_dialect (document);
    if (dialect == Dialect::None) {
        return walked;
    }
    if (notes != nullptr) {
        note_webhook_operations (document, *notes);
    }
    const nlohmann::ordered_json* paths = find_object (document, "paths");
    if (paths == nullptr) {
        return walked;
    }

    /// Every `operationId` already stamped, so a repeated one is kept on its
    /// first declaration only (issue #715).
    std::unordered_set<std::string> claimed_ids;

    for (auto entry = paths->begin (); entry != paths->end (); ++entry) {
        const nlohmann::ordered_json* item =
        resolve_single_hop (document, entry.value ());
        if (item == nullptr) {
            // An unresolved path item drops every operation under that path,
            // which is a loss an import has to be able to name.
            if (notes != nullptr) {
                notes->malformed_spec += 1;
            }
            continue;
        }
        if (notes != nullptr) {
            note_skipped_members (dialect, *item, *notes);
        }
        walk_path_item (entry.key (), *item, claimed_ids, notes, walked);
    }
    return walked;
}

} // namespace vayu::core::walk
