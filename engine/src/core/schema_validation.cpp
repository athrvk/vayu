/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/// Response schema validation (#628); the header gives the storage shape and
/// the dialect-honesty rule.

#include "vayu/core/schema_validation.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/json_depth.hpp"
#include "vayu/core/schema_error_text.hpp"
#include "vayu/core/schema_format.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <format>
#include <map>
#include <optional>
#include <set>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <valijson/adapters/nlohmann_json_adapter.hpp>
#include <valijson/constraint_builder.hpp>
#include <valijson/constraints/concrete_constraints.hpp>
#include <valijson/schema.hpp>
#include <valijson/schema_parser.hpp>
#include <valijson/validation_results.hpp>
#include <valijson/validator.hpp>

namespace vayu::core {

namespace {

namespace limits = vayu::core::constants::schema_validation;

std::string trim (const std::string& value) {
    const auto first = value.find_first_not_of (" \t");
    if (first == std::string::npos) {
        return {};
    }
    const auto last = value.find_last_not_of (" \t");
    return value.substr (first, last - first + 1);
}

/// The media type of a `Content-Type` header (`application/json` out of
/// `application/json; charset=utf-8`), lower-cased: media types are
/// case-insensitive and the index stores them lower-cased, so both sides of the
/// comparison are normalised.
std::string media_type_of (const std::string& content_type) {
    return vayu::utils::ascii_lower (
    trim (content_type.substr (0, content_type.find (';'))));
}

/// `METHOD path`, the second identity key - the spelling `OperationIndex` uses,
/// because both resolve the same stamped `spec_operation` text.
std::string method_path_key (const std::string& method, const std::string& path) {
    return vayu::utils::ascii_upper (method) + " " + path;
}

/**
 * Keywords a draft-07 validator does not evaluate, and what each is from.
 *
 * The first group is JSON Schema 2019-09/2020-12: what an OpenAPI **3.1**
 * document may legally use and this validator has never heard of. The second is
 * OpenAPI's own vocabulary: the app normalises `nullable` and `discriminator`
 * away when it extracts a 3.0 schema, so one arriving here is a bug there, and
 * disclosing it surfaces the bug as a named gap rather than a body wrongly
 * reported clean (or, for `nullable`, wrongly broken).
 *
 * `propertyNames` is not here: it is draft-07, and valijson evaluates it only
 * at the schema's root, so whether it is a gap depends on where it sits
 * (`collect_unevaluated_keywords`).
 */
const std::unordered_set<std::string>& unevaluatable_keywords () {
    static const std::unordered_set<std::string> keywords = {
        // JSON Schema 2019-09 / 2020-12
        "unevaluatedProperties",
        "unevaluatedItems",
        "prefixItems",
        "dependentSchemas",
        "dependentRequired",
        "minContains",
        "maxContains",
        "$dynamicRef",
        "$dynamicAnchor",
        "$recursiveRef",
        "$recursiveAnchor",
        // OpenAPI's own, which should have been normalised app-side
        "nullable",
        "discriminator",
    };
    return keywords;
}

/// Where a schema keyword holds one subschema.
const std::vector<std::string>& subschema_keys () {
    static const std::vector<std::string> keys = { "not", "if", "then", "else",
        "contains", "additionalProperties", "propertyNames", "additionalItems",
        "unevaluatedItems", "unevaluatedProperties" };
    return keys;
}

/// Keywords holding a *map* of subschemas keyed by data, not keywords: walking
/// these keys as keywords would report a property legitimately called
/// "nullable" as a dialect gap. A draft-07 `dependencies` value is a subschema
/// or, as an array, a list of property names; `queue_subschemas` follows only
/// the object-valued ones.
const std::vector<std::string>& subschema_map_keys () {
    static const std::vector<std::string> keys = { "properties", "patternProperties",
        "definitions", "$defs", "dependentSchemas", "dependencies" };
    return keys;
}

/// Where a keyword holds a list of subschemas.
const std::vector<std::string>& subschema_list_keys () {
    static const std::vector<std::string> keys = { "allOf", "anyOf", "oneOf", "prefixItems" };
    return keys;
}

/// Resolves an in-document JSON Pointer (`#/components/schemas/Pet`) against
/// the merged validation root. Anything else (an external ref, a malformed
/// pointer) resolves to nothing, and the walk stops there rather than guessing.
const nlohmann::json* resolve_pointer (const nlohmann::json& root, const std::string& ref) {
    if (ref.empty () || ref.front () != '#') {
        return nullptr;
    }
    try {
        const nlohmann::json::json_pointer pointer (ref.substr (1));
        if (!root.contains (pointer)) {
            return nullptr;
        }
        return &root.at (pointer);
    } catch (const std::exception&) {
        return nullptr;
    }
}

/// The schema with the document's shared ref subtrees merged in beside it, so
/// `#/components/schemas/Pet` resolves. The schema's own keys win a collision:
/// a schema declaring its own `components` is not a shape OpenAPI produces, and
/// if one arrives its own value is the one it meant.
nlohmann::json validation_root (const nlohmann::json& schema, const nlohmann::json& ref_roots) {
    if (!schema.is_object () || !ref_roots.is_object () || ref_roots.empty ()) {
        return schema;
    }
    nlohmann::json root = ref_roots;
    for (const auto& [key, value] : schema.items ()) {
        root[key] = value;
    }
    return root;
}

/// valijson's context segments (`<root>`, `["child"]`, `[0]`) as a JSON
/// Pointer, the form of every other path here and what a reader can paste into
/// a body viewer: `<root>["child"]["name"]` becomes `/child/name`.
std::string pointer_of_context (const std::vector<std::string>& context) {
    std::string pointer;
    for (const auto& segment : context) {
        if (segment == "<root>") {
            continue;
        }
        std::string name = segment;
        if (name.size () >= 2 && name.front () == '[' && name.back () == ']') {
            name = name.substr (1, name.size () - 2);
        }
        if (name.size () >= 2 && name.front () == '"' && name.back () == '"') {
            name = name.substr (1, name.size () - 2);
        }
        pointer += "/" + name;
    }
    return pointer;
}

/// One property name as a pointer token (RFC 6901: `~` and `/` are escaped).
std::string json_pointer_token (const std::string& name) {
    std::string token;
    for (const char c : name) {
        if (c == '~') {
            token += "~0";
        } else if (c == '/') {
            token += "~1";
        } else {
            token += c;
        }
    }
    return token;
}

/**
 * The prefixes of valijson's *structural* errors: a parent failed because a
 * child did, once per level, beside the leaf error that names the problem.
 * Counting them would report one bad array item, `allOf` branch or additional
 * property as two problems (#3033). `anyOf`, `oneOf` and `if`/`then`/`else`
 * summaries are not listed: they are the only line naming the combinator that
 * refused the value.
 *
 * Dropping them is cosmetic and allowed to break: if an upstream release
 * rewords one, a verdict gains its wrapper lines back and reads noisier.
 * `StructuralWrapperTest` pins each against the vcpkg-pinned valijson. Matched
 * against `error.description`, never `SchemaFailure::message` (built by
 * `humanize_schema_error`, which can reword it): a wrapper's text matches no
 * keyword that function recognizes today, and matching the untranslated string
 * keeps that true by construction.
 */
constexpr auto STRUCTURAL_ERROR_PREFIXES = std::to_array<std::string_view> ({
"Failed to validate against schema associated with", // properties, patternProperties
"Failed to validate against additional properties schema.", // additionalProperties
"Failed to validate against dependent schema.",             // dependencies
"Failed to validate against child schema #",                // allOf
"Failed to validate item #", // items, additionalItems, tuple items
});

bool is_structural_error (std::string_view description) {
    return std::ranges::any_of (
    STRUCTURAL_ERROR_PREFIXES, [description] (std::string_view prefix) {
        return description.starts_with (prefix);
    });
}

} // namespace

std::string to_string (UncheckedReason reason) {
    switch (reason) {
    case UncheckedReason::NoOperation: return "no_operation";
    case UncheckedReason::NoIndex: return "no_index";
    case UncheckedReason::HashMismatch: return "hash_mismatch";
    case UncheckedReason::NeverStamped: return "never_stamped";
    case UncheckedReason::OperationNotDeclared: return "operation_not_declared";
    case UncheckedReason::NoSchemaForStatus: return "no_schema_for_status";
    case UncheckedReason::NoSchemaForContentType:
        return "no_schema_for_content_type";
    case UncheckedReason::NoResponse: return "no_response";
    case UncheckedReason::BodyNotJson: return "body_not_json";
    }
    return "no_index"; // unreachable; the enum is closed
}

nlohmann::json build_validation_payload (const ValidationVerdict& verdict) {
    nlohmann::json node;
    node["checked"] = verdict.checked;
    if (!verdict.checked) {
        // No `valid` key when nothing was checked: `valid: false` on an
        // unchecked response is the confusion this node exists to avoid, read
        // as a contract failure.
        node["reason"] = verdict.reason ? to_string (*verdict.reason) :
                                          to_string (UncheckedReason::NoIndex);
        return node;
    }

    node["valid"] = verdict.valid;
    if (!verdict.matched_status.empty ()) {
        node["matchedStatus"] = verdict.matched_status;
    }
    if (!verdict.matched_content_type.empty ()) {
        node["matchedContentType"] = verdict.matched_content_type;
    }

    nlohmann::json failures = nlohmann::json::array ();
    for (const auto& failure : verdict.failures) {
        failures.push_back ({ { "path", failure.path }, { "message", failure.message } });
    }
    node["failures"] = failures;
    // Always present, even when nothing was dropped: a reader comparing
    // `failures.size()` against it needs the number to be there to compare.
    node["failuresTotal"] = verdict.failures_total;

    if (!verdict.unevaluated_keywords.empty ()) {
        nlohmann::json unevaluated = nlohmann::json::array ();
        for (const auto& [keyword, count] : verdict.unevaluated_keywords) {
            unevaluated.push_back ({ { "keyword", keyword }, { "count", count } });
        }
        node["unevaluatedKeywords"] = unevaluated;
    }
    return node;
}

void SampledValidationTotals::record (const ValidationVerdict& verdict,
const std::string& step,
int status) {
    ++sampled;

    if (!verdict.checked) {
        // Counted by reason, not as a failure: a body a JSON Schema cannot
        // speak about did not break its contract, and folding the two would
        // make every HTML error page a schema failure.
        ++unchecked_reasons[to_string (verdict.reason.value_or (UncheckedReason::NoIndex))];
        return;
    }

    ++checked;
    if (verdict.valid) {
        ++valid;
    } else {
        ++failed;
    }

    if (!verdict.unevaluated_keywords.empty ()) {
        ++unevaluated;
        for (const auto& [keyword, count] : verdict.unevaluated_keywords) {
            unevaluated_keywords[keyword] += count;
        }
    }

    // The run-wide total counts every failure found, including those each
    // verdict's own cap hid, so "shown of found" is honest about both caps.
    failures_total += verdict.failures_total;
    for (const auto& failure : verdict.failures) {
        const bool step_represented = std::ranges::any_of (failure_examples,
        [&] (const FailureExample& held) { return held.step == step; });
        auto& destination = step_represented ? repeat_examples : failure_examples;
        if (destination.size () >= limits::MAX_FAILURES) {
            continue;
        }
        destination.push_back (
        FailureExample{ step, status, failure.path, failure.message });
    }
}

nlohmann::json build_sampled_validation_payload (const SampledValidationTotals& totals) {
    if (totals.sampled == 0) {
        return nlohmann::json::object ();
    }

    nlohmann::json node;
    // `sampled` first and always: it is the denominator that makes the rest
    // readable, and the one number that says these figures describe a sample.
    node["sampled"]     = totals.sampled;
    node["checked"]     = totals.checked;
    node["valid"]       = totals.valid;
    node["failed"]      = totals.failed;
    node["unevaluated"] = totals.unevaluated;

    if (!totals.unchecked_reasons.empty ()) {
        nlohmann::json reasons = nlohmann::json::object ();
        for (const auto& [reason, count] : totals.unchecked_reasons) {
            reasons[reason] = count;
        }
        node["uncheckedReasons"] = reasons;
    }

    if (!totals.unevaluated_keywords.empty ()) {
        nlohmann::json keywords = nlohmann::json::array ();
        for (const auto& [keyword, count] : totals.unevaluated_keywords) {
            keywords.push_back ({ { "keyword", keyword }, { "count", count } });
        }
        node["unevaluatedKeywords"] = keywords;
    }

    nlohmann::json failures = nlohmann::json::array ();
    const auto append_example = [&] (const SampledValidationTotals::FailureExample& example) {
        if (failures.size () >= limits::MAX_FAILURES) {
            return;
        }
        nlohmann::json entry = { { "status", example.status },
            { "path", example.path }, { "message", example.message } };
        if (!example.step.empty ()) {
            entry["step"] = example.step;
        }
        failures.push_back (std::move (entry));
    };
    // One example per failing step first, then repeats of a step, so a late
    // failing step is not crowded out by an early one (#3038).
    std::ranges::for_each (totals.failure_examples, append_example);
    std::ranges::for_each (totals.repeat_examples, append_example);
    node["failures"] = failures;
    // Always present, like the per-response verdict's own: a reader comparing
    // the list's length against it needs the number to be there to compare.
    node["failuresTotal"] = totals.failures_total;
    return node;
}

namespace {

/// A schema node and where it sits in the validation root.
struct SchemaNode {
    const nlohmann::json* schema;
    nlohmann::json::json_pointer pointer;
};

/// The object-valued entries of the map keyword @p key, queued for the walk.
/// A non-object entry (the array form of `dependencies`) holds no subschema.
void queue_map_subschemas (const SchemaNode& node,
const std::string& key,
std::vector<SchemaNode>& pending) {
    auto found = node.schema->find (key);
    if (found == node.schema->end () || !found->is_object ()) {
        return;
    }
    for (const auto& [name, child] : found->items ()) {
        if (child.is_object ()) {
            pending.push_back ({ &child, node.pointer / key / name });
        }
    }
}

/// Queues every subschema of @p node for the walk. `items` is a subschema in
/// draft-07 and a list in draft-04's tuple form; both reach schemas, so both
/// are followed.
void queue_subschemas (const SchemaNode& node, std::vector<SchemaNode>& pending) {
    for (const auto& key : subschema_keys ()) {
        if (auto found = node.schema->find (key);
        found != node.schema->end () && found->is_object ()) {
            pending.push_back ({ &*found, node.pointer / key });
        }
    }
    for (const auto& key : subschema_map_keys ()) {
        queue_map_subschemas (node, key, pending);
    }
    for (const auto& key : subschema_list_keys ()) {
        if (auto found = node.schema->find (key);
        found != node.schema->end () && found->is_array ()) {
            for (size_t index = 0; index < found->size (); ++index) {
                pending.push_back ({ &(*found)[index], node.pointer / key / index });
            }
        }
    }
    if (auto items = node.schema->find ("items"); items != node.schema->end ()) {
        if (items->is_object ()) {
            pending.push_back ({ &*items, node.pointer / "items" });
        } else if (items->is_array ()) {
            for (size_t index = 0; index < items->size (); ++index) {
                pending.push_back ({ &(*items)[index], node.pointer / "items" / index });
            }
        }
    }
}

/**
 * Calls @p visit (object subschema, its pointer in the validation root) for
 * every subschema reachable from @p schema, `$ref` targets included, each found
 * by @p resolve (ref text to node, or null).
 *
 * Iterative, not recursive: a schema arrives from outside the engine, and a
 * deeply nested one must not cost stack the process does not have. The visited
 * set covers `$ref` cycles; the node budget covers a schema that is merely
 * enormous.
 */
template <typename Resolve, typename Visit>
void walk_schema_with (const nlohmann::json& schema, Resolve&& resolve, Visit&& visit) {
    std::unordered_set<std::string> visited_refs;
    std::vector<SchemaNode> pending = { { &schema, nlohmann::json::json_pointer () } };
    size_t visited_nodes = 0;
    while (!pending.empty () && visited_nodes < limits::MAX_SCHEMA_NODES) {
        const SchemaNode node = std::move (pending.back ());
        pending.pop_back ();
        ++visited_nodes;
        if (!node.schema->is_object ()) {
            continue;
        }
        visit (*node.schema, node.pointer);

        if (auto ref = node.schema->find ("$ref");
        ref != node.schema->end () && ref->is_string ()) {
            const auto pointer = ref->get<std::string> ();
            if (visited_refs.insert (pointer).second) {
                if (const nlohmann::json* target = resolve (pointer)) {
                    // resolve_pointer already parsed this text as a pointer.
                    pending.push_back (
                    { target, nlohmann::json::json_pointer (pointer.substr (1)) });
                }
            }
        }
        queue_subschemas (node, pending);
    }
}

/// `walk_schema_with`, resolving every `$ref` against the one @p root.
template <typename Visit>
void walk_schema (const nlohmann::json& schema, const nlohmann::json& root, Visit&& visit) {
    walk_schema_with (
    schema,
    [&root] (const std::string& ref) { return resolve_pointer (root, ref); },
    std::forward<Visit> (visit));
}

/// Locations a loop's description names before it says "...".
constexpr size_t MAX_LOOP_LOCATIONS = 3;

/// A subschema that applies to the same value as the one that reaches it.
struct SameValueFrame {
    const nlohmann::json* schema;
    nlohmann::json::json_pointer pointer;
};

/// Where a keyword holds one subschema that applies to the value the keyword
/// sits on, not to a child of it.
const std::vector<std::string>& same_value_keys () {
    static const std::vector<std::string> keys = { "not", "if", "then", "else" };
    return keys;
}

/// The combinators: lists of subschemas that each apply to the same value.
/// `prefixItems` is not one, it steps into array items.
const std::vector<std::string>& same_value_list_keys () {
    static const std::vector<std::string> keys = { "allOf", "anyOf", "oneOf" };
    return keys;
}

/// Where a map of subschemas applies to the same value as the map's owner.
const std::vector<std::string>& same_value_map_keys () {
    static const std::vector<std::string> keys = { "dependencies", "dependentSchemas" };
    return keys;
}

/// A `$ref` target in the schema itself or, failing that, in the shared ref
/// roots: what `validation_root` would resolve, without copying the roots into
/// a merged document for every schema checked.
const nlohmann::json* resolve_in_either (const nlohmann::json& schema_root,
const nlohmann::json& ref_roots,
const std::string& ref) {
    if (const nlohmann::json* hit = resolve_pointer (schema_root, ref)) {
        return hit;
    }
    return resolve_pointer (ref_roots, ref);
}

void add_ref_edge (const nlohmann::json& schema,
const nlohmann::json& schema_root,
const nlohmann::json& ref_roots,
std::vector<SameValueFrame>& edges) {
    auto ref = schema.find ("$ref");
    if (ref == schema.end () || !ref->is_string ()) {
        return;
    }
    const auto text = ref->get<std::string> ();
    if (const nlohmann::json* target = resolve_in_either (schema_root, ref_roots, text)) {
        edges.push_back ({ target, nlohmann::json::json_pointer (text.substr (1)) });
    }
}

void add_list_edges (const nlohmann::json& schema,
const nlohmann::json::json_pointer& at,
std::vector<SameValueFrame>& edges) {
    for (const auto& key : same_value_list_keys ()) {
        auto found = schema.find (key);
        if (found == schema.end () || !found->is_array ()) {
            continue;
        }
        for (size_t index = 0; index < found->size (); ++index) {
            edges.push_back ({ &(*found)[index], at / key / index });
        }
    }
}

void add_map_edges (const nlohmann::json& schema,
const nlohmann::json::json_pointer& at,
std::vector<SameValueFrame>& edges) {
    for (const auto& key : same_value_map_keys ()) {
        auto found = schema.find (key);
        if (found == schema.end () || !found->is_object ()) {
            continue;
        }
        for (const auto& [name, child] : found->items ()) {
            if (child.is_object ()) {
                edges.push_back ({ &child, at / key / name });
            }
        }
    }
}

/// The subschemas that apply to the very same value as @p schema does: `$ref`
/// and the combinators, and not `properties`, `items` and the rest, which step
/// to a child value.
std::vector<SameValueFrame> same_value_edges (const nlohmann::json& schema,
const nlohmann::json::json_pointer& at,
const nlohmann::json& schema_root,
const nlohmann::json& ref_roots) {
    std::vector<SameValueFrame> edges;
    if (!schema.is_object ()) {
        return edges;
    }
    add_ref_edge (schema, schema_root, ref_roots, edges);
    for (const auto& key : same_value_keys ()) {
        if (auto found = schema.find (key); found != schema.end () && found->is_object ()) {
            edges.push_back ({ &*found, at / key });
        }
    }
    add_list_edges (schema, at, edges);
    add_map_edges (schema, at, edges);
    return edges;
}

/// A node on the search's current path, with the same-value edges still to try.
struct OpenNode {
    std::string at;
    std::vector<SameValueFrame> edges;
    size_t next = 0;
};

/// What the cycle search has learnt, kept across the nodes it starts from: a
/// node marked `Done` reaches no cycle, so no later start expands it again.
struct SameValueSearch {
    enum class Mark : std::uint8_t { OnPath, Done };
    std::unordered_map<std::string, Mark> marks;
    size_t expanded = 0;
};

/// The locations from where @p at sits on @p path round to @p at again.
std::vector<std::string>
cycle_back_to (const std::vector<OpenNode>& path, const std::string& at) {
    std::vector<std::string> loop;
    const auto start = std::ranges::find (path, at, &OpenNode::at);
    for (auto it = start; it != path.end (); ++it) {
        loop.push_back ("#" + it->at);
    }
    loop.push_back ("#" + at);
    return loop;
}

/// The same-value cycle reachable from @p start, or nothing. A depth-first
/// search with its path on the heap, so the check cannot overflow on the schema
/// it guards against; every node it expands counts against the one
/// `MAX_SCHEMA_NODES` budget in @p search.
std::optional<std::vector<std::string>> same_value_cycle_from (const SameValueFrame& start,
const nlohmann::json& schema_root,
const nlohmann::json& ref_roots,
SameValueSearch& search) {
    using Mark = SameValueSearch::Mark;
    std::vector<OpenNode> path;
    const auto open = [&] (const SameValueFrame& frame, std::string at) {
        ++search.expanded;
        path.push_back ({ std::move (at),
        same_value_edges (*frame.schema, frame.pointer, schema_root, ref_roots), 0 });
    };

    if (search.expanded >= limits::MAX_SCHEMA_NODES) {
        return std::nullopt;
    }
    std::string start_at = start.pointer.to_string ();
    if (!search.marks.try_emplace (start_at, Mark::OnPath).second) {
        return std::nullopt;
    }
    open (start, std::move (start_at));

    while (!path.empty () && search.expanded < limits::MAX_SCHEMA_NODES) {
        OpenNode& top = path.back ();
        if (top.next == top.edges.size ()) {
            search.marks[top.at] = Mark::Done;
            path.pop_back ();
            continue;
        }
        const SameValueFrame edge = std::move (top.edges[top.next++]);
        std::string at            = edge.pointer.to_string ();
        const auto [entry, inserted] = search.marks.try_emplace (at, Mark::OnPath);
        if (inserted) {
            open (edge, std::move (at));
        } else if (entry->second == Mark::OnPath) {
            return cycle_back_to (path, at);
        }
    }
    return std::nullopt;
}

/**
 * The locations of a cycle in which every step applies to the same value, or
 * nothing.
 *
 * Following one never reaches a value, so valijson recurses until the stack
 * runs out and the engine dies, which no `catch` stops. A cycle through a
 * keyword that steps into a child (a tree node's `properties`) is a legitimate
 * recursive schema and not one of these.
 *
 * The search starts from every subschema, not only the root, so a cycle only a
 * child step reaches (`properties/a` `$ref`-ing into a loop, #3810) is found.
 * The marks are shared across starts, so the whole search expands each node
 * once.
 */
std::optional<std::vector<std::string>>
find_same_value_cycle (const nlohmann::json& root, const nlohmann::json& ref_roots) {
    const auto resolve = [&] (const std::string& ref) {
        return resolve_in_either (root, ref_roots, ref);
    };
    SameValueSearch search;
    std::optional<std::vector<std::string>> cycle;
    walk_schema_with (root, resolve,
    [&] (const nlohmann::json& node, const nlohmann::json::json_pointer& at) {
        if (!cycle) {
            cycle = same_value_cycle_from ({ &node, at }, root, ref_roots, search);
        }
    });
    return cycle;
}

} // namespace

std::optional<std::string> find_schema_loop (const nlohmann::json& schema,
const nlohmann::json& ref_roots) {
    const auto loop = find_same_value_cycle (schema, ref_roots);
    if (!loop) {
        return std::nullopt;
    }
    std::string named;
    for (size_t i = 0; i < std::min (loop->size (), MAX_LOOP_LOCATIONS); ++i) {
        named += (i == 0 ? "" : " -> ") + (*loop)[i];
    }
    if (loop->size () > MAX_LOOP_LOCATIONS) {
        named += " -> ...";
    }
    return named;
}

std::vector<std::pair<std::string, size_t>>
collect_unevaluated_keywords (const nlohmann::json& schema, const nlohmann::json& ref_roots) {
    std::map<std::string, size_t> counts;
    // A `$ref` target is reached once through the ref and once in place, so the
    // nested `propertyNames` are kept by pointer and counted once each.
    std::set<std::string> nested_property_names;
    size_t root_visits = 0;
    walk_schema (schema, validation_root (schema, ref_roots),
    [&] (const nlohmann::json& node, const nlohmann::json::json_pointer& at) {
        for (const auto& [key, value] : node.items ()) {
            if (unevaluatable_keywords ().contains (key)) {
                ++counts[key];
            }
        }
        // valijson builds a `propertyNames` subschema from its parent's node
        // path (`makePropertyNamesConstraint` is handed `nodePath`, not
        // `nodePath + "/propertyNames"`) and so reuses the parent's subschema.
        // That holds at the root (#2719) and passes every body below it: in
        // `properties`, `items`, an `allOf` member or a `$ref` target (#2729).
        // The root is the empty pointer, which a `$ref` back to `#` shares: the
        // first visit is the root itself, a later one is the keyword reached
        // from below, ignored too.
        const bool is_root = at.empty ();
        root_visits += is_root ? 1 : 0;
        if (node.contains ("propertyNames") && (!is_root || root_visits > 1)) {
            nested_property_names.insert (at.to_string ());
        }
    });
    if (!nested_property_names.empty ()) {
        counts["propertyNames"] = nested_property_names.size ();
    }
    return { counts.begin (), counts.end () };
}

namespace {

/**
 * Asserts a `format` valijson only annotates (#2581): the extra constraint it
 * accepts for a custom keyword, added beside valijson's own `format` one.
 * @p checker is null for a name that stays an annotation, because a builder
 * must return a constraint and cannot decline the keyword.
 */
class FormatCheckConstraint final : public valijson::constraints::PolyConstraint {
    public:
    explicit FormatCheckConstraint (const FormatChecker* checker)
    : checker_ (checker) {
    }

    bool validate (const valijson::adapters::Adapter& target,
    const valijson::ValidationResults::Path& path,
    valijson::ValidationResults* results) const override {
        // `format` applies to strings only; any other type passes, as valijson's does.
        if (checker_ == nullptr || !target.isString () ||
        checker_->accepts (target.getString ())) {
            return true;
        }
        if (results != nullptr) {
            results->pushError (
            path, std::format ("String should be a valid {}", checker_->noun));
        }
        return false;
    }

    private:
    valijson::constraints::Constraint* cloneInto (void* where) const override {
        // NOLINTNEXTLINE(cppcoreguidelines-owning-memory): placement into valijson's storage.
        return new (where) FormatCheckConstraint (*this);
    }

    size_t sizeOf () const override {
        return sizeof (*this);
    }

    const FormatChecker* checker_;
};

class FormatCheckBuilder final : public valijson::ConstraintBuilder {
    public:
    valijson::constraints::Constraint* make (
    const valijson::adapters::Adapter& node) const override {
        // A non-string `format` was already refused by valijson's own parse.
        const FormatChecker* checker =
        node.isString () ? find_format_checker (node.getString ()) : nullptr;
        // NOLINTNEXTLINE(cppcoreguidelines-owning-memory): valijson deletes what make returns.
        return new FormatCheckConstraint (checker);
    }
};

/// Makes @p parser assert the formats in `schema_format.hpp`.
void assert_extra_formats (valijson::SchemaParser& parser) {
    // NOLINTNEXTLINE(cppcoreguidelines-owning-memory): the parser owns its builders.
    parser.addConstraintBuilder ("format", new FormatCheckBuilder);
}

/// How many schema paths an unrecorded failure lists before "and N more".
constexpr size_t MAX_NAMED_SCHEMA_PATHS = 3;

/// Every `propertyNames` keyword in @p schema, as a pointer into @p root, sorted.
std::vector<std::string> property_names_pointers (const nlohmann::json& schema,
const nlohmann::json& root) {
    std::vector<std::string> pointers;
    walk_schema (schema, root,
    [&pointers] (const nlohmann::json& node, const nlohmann::json::json_pointer& at) {
        if (node.contains ("propertyNames")) {
            pointers.push_back ((at / "propertyNames").to_string ());
        }
    });
    // A `$ref` target is reached once through the ref and once in place.
    std::ranges::sort (pointers);
    pointers.erase (std::ranges::unique (pointers).begin (), pointers.end ());
    return pointers;
}

/**
 * The failure for a body the validator refused without recording why. Its data
 * path is the body itself: a constraint that records nothing leaves no context
 * to point at. The schema can still be named, and `propertyNames` is the
 * keyword valijson refuses silently, so its occurrences are listed. A `false`
 * schema, or a `$ref` into a document the walk cannot read, has none; the
 * message then claims no keyword.
 */
SchemaFailure unrecorded_failure (const nlohmann::json& schema, const nlohmann::json& root) {
    SchemaFailure failure;
    const auto pointers = property_names_pointers (schema, root);
    if (pointers.empty ()) {
        failure.message = "Couldn't validate against a schema constraint that "
                          "reports no detail.";
        return failure;
    }
    std::string named;
    for (size_t i = 0; i < std::min (pointers.size (), MAX_NAMED_SCHEMA_PATHS); ++i) {
        named += (i == 0 ? "" : ", ") + pointers[i];
    }
    if (pointers.size () > MAX_NAMED_SCHEMA_PATHS) {
        named += std::format (" and {} more", pointers.size () - MAX_NAMED_SCHEMA_PATHS);
    }
    failure.message = std::format ("Couldn't validate against 'propertyNames' "
                                   "at {}, which reports no detail.",
    named);
    return failure;
}

/// One validator run for both public entry points: the verdict, or the
/// validator's reason for refusing the schema (at parse time, or at validation
/// time for a constraint it reads only then, such as a `pattern`). What a
/// refusal means is each caller's to decide.
std::expected<ValidationVerdict, std::string> run_validator (const nlohmann::json& schema,
const nlohmann::json& ref_roots,
const nlohmann::json& body) {
    ValidationVerdict verdict;
    verdict.unevaluated_keywords = collect_unevaluated_keywords (schema, ref_roots);

    if (const auto loop = find_schema_loop (schema, ref_roots)) {
        return std::unexpected (std::format (
        "the schema refers to itself without describing any value ({})", *loop));
    }
    const nlohmann::json root = validation_root (schema, ref_roots);
    valijson::Schema parsed;
    valijson::ValidationResults results;
    bool accepted = false;
    try {
        valijson::SchemaParser parser;
        assert_extra_formats (parser);
        const valijson::adapters::NlohmannJsonAdapter adapter (root);
        parser.populateSchema (adapter, parsed);
        valijson::Validator validator;
        const valijson::adapters::NlohmannJsonAdapter target (body);
        accepted = validator.validate (parsed, target, &results);
    } catch (const std::exception& e) {
        return std::unexpected (std::string (e.what ()));
    }

    std::vector<SchemaFailure> structural;
    valijson::ValidationResults::Error error;
    while (results.popError (error)) {
        SchemaFailure failure;
        failure.path = pointer_of_context (error.context);
        if (const auto extra = vayu::core::unexpected_property_name (error.description)) {
            failure.path += "/" + json_pointer_token (*extra);
        }
        const std::string humanized = vayu::core::humanize_schema_error (root,
        error.description, error.jsonPointer, vayu::core::SchemaErrorContext::ResponseBody);
        failure.message = humanized.size () > limits::MAX_FAILURE_MESSAGE_BYTES ?
        humanized.substr (0, limits::MAX_FAILURE_MESSAGE_BYTES) + "..." :
        humanized;

        if (is_structural_error (error.description)) {
            structural.push_back (std::move (failure));
            continue;
        }
        ++verdict.failures_total;
        if (verdict.failures.size () < limits::MAX_FAILURES) {
            verdict.failures.push_back (std::move (failure));
        }
    }

    // Every error was a structural wrapper: report them rather than a failed
    // body with nothing to show, so the cosmetic filter above never costs a
    // reader the reason.
    if (verdict.failures_total == 0 && !structural.empty ()) {
        verdict.failures_total = structural.size ();
        structural.resize (std::min (structural.size (), limits::MAX_FAILURES));
        verdict.failures = std::move (structural);
    }

    // Validity is the validator's verdict, not the errors it recorded: a
    // constraint can refuse and record nothing (#2719, valijson's
    // `propertyNames`), and a verdict read from the errors would pass it. A
    // refusal therefore always leaves a failure, so the count below is the
    // whole rule.
    if (!accepted && verdict.failures_total == 0) {
        verdict.failures_total = 1;
        verdict.failures.push_back (unrecorded_failure (schema, root));
    }

    verdict.checked = true;
    verdict.valid   = verdict.failures_total == 0;
    return verdict;
}

} // namespace

ValidationVerdict validate_body_against_schema (const nlohmann::json& schema,
const nlohmann::json& ref_roots,
const nlohmann::json& body) {
    auto verdict = run_validator (schema, ref_roots, body);
    if (verdict) {
        return std::move (*verdict);
    }
    // A schema the validator refuses is not a failed body: the contract could
    // not be read, so nothing was checked. Reported as `no_index` (the index is
    // there but unusable) with the reason in the log, since the fix belongs to
    // whoever wrote the index.
    vayu::utils::log_warning (
    "http", "Response schema rejected by the validator: " + verdict.error ());
    ValidationVerdict unchecked;
    unchecked.reason = UncheckedReason::NoIndex;
    return unchecked;
}

std::expected<ValidationVerdict, std::string>
validate_document_against_schema (const nlohmann::json& schema, const nlohmann::json& document) {
    return run_validator (schema, nlohmann::json::object (), document);
}

std::string unevaluated_keywords_disclosure (const ValidationVerdict& verdict) {
    std::string list;
    for (const auto& [keyword, count] : verdict.unevaluated_keywords) {
        list += (list.empty () ? "" : ", ") + std::format ("{} ({})", keyword, count);
    }
    return "uses keywords the draft-07 validator does not evaluate, so they "
           "were not checked: " +
    list;
}

/**
 * The responses one indexed operation declares. A row with a status and a media
 * type but no schema is the status-only row `response_schemas_of` writes for a
 * status with nothing to check (#3028): the status is a candidate, no body is
 * judged against it. Any other row missing a status, media type or schema
 * declares nothing and is skipped, not costing the document its index.
 */
void ResponseSchemaIndex::read_declared_responses (const nlohmann::json& row,
IndexedOperation& operation) {
    auto responses = row.find ("responses");
    if (responses == row.end () || !responses->is_array ()) {
        return;
    }
    for (const auto& response : *responses) {
        if (!response.is_object ()) {
            continue;
        }
        DeclaredSchema declared;
        declared.status = response.value ("status", std::string ());
        declared.content_type =
        vayu::utils::ascii_lower (response.value ("contentType", std::string ()));
        const auto schema     = response.find ("schema");
        const bool has_schema = schema != response.end ();
        if (declared.status.empty () || declared.content_type.empty () == has_schema) {
            continue; // no status, or a media type and a schema that are not both there
        }
        if (std::find (operation.statuses.begin (), operation.statuses.end (),
            declared.status) == operation.statuses.end ()) {
            operation.statuses.push_back (declared.status);
        }
        if (has_schema) {
            declared.schema = *schema;
            operation.responses.push_back (std::move (declared));
        }
    }
}

std::optional<ResponseSchemaIndex> ResponseSchemaIndex::parse (const std::string& stored) {
    if (stored.empty ()) {
        return std::nullopt;
    }
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (stored);
    } catch (const std::exception&) {
        return std::nullopt;
    }
    if (!parsed.is_object ()) {
        return std::nullopt;
    }
    auto operations = parsed.find ("operations");
    if (operations == parsed.end () || !operations->is_array ()) {
        return std::nullopt;
    }

    ResponseSchemaIndex index;
    if (auto roots = parsed.find ("refRoots");
    roots != parsed.end () && roots->is_object ()) {
        index.ref_roots_ = *roots;
    }

    for (const auto& row : *operations) {
        if (index.operations_.size () >= constants::spec_document::MAX_OPERATIONS) {
            break;
        }
        if (!row.is_object ()) {
            continue;
        }
        const auto method =
        vayu::utils::ascii_upper (row.value ("method", std::string ()));
        const auto path = row.value ("path", std::string ());
        if (method.empty () || path.empty ()) {
            continue; // one unusable row must not cost the document its index
        }

        IndexedOperation operation;
        read_declared_responses (row, operation);

        const size_t at = index.operations_.size ();
        // First writer wins in both maps, `OperationIndex`'s rule: a document
        // declaring one identity twice is malformed, and taking the last row
        // would make a verdict depend on write order.
        if (auto id = row.find ("operationId"); id != row.end () &&
        id->is_string () && !id->get<std::string> ().empty ()) {
            index.by_operation_id_.emplace (id->get<std::string> (), at);
        }
        index.by_method_path_.emplace (method_path_key (method, path), at);
        index.operations_.push_back (std::move (operation));
    }

    return index;
}

/// Which indexed operation a stamp names: `operationId` first, `METHOD path`
/// second, the rule `core/operation_match.hpp` binds by and `OperationIndex`
/// counts coverage by. All three must answer a rename the same way.
std::optional<size_t> resolve_stamped_operation (const std::string& spec_operation,
const std::unordered_map<std::string, size_t>& by_operation_id,
const std::unordered_map<std::string, size_t>& by_method_path) {
    std::optional<size_t> at;
    try {
        const auto stamped = nlohmann::json::parse (spec_operation);
        if (stamped.is_object ()) {
            if (auto id = stamped.find ("operationId"); id != stamped.end () &&
            id->is_string () && !id->get<std::string> ().empty ()) {
                if (auto found = by_operation_id.find (id->get<std::string> ());
                found != by_operation_id.end ()) {
                    at = found->second;
                }
            }
            if (!at) {
                const auto method = stamped.value ("method", std::string ());
                const auto path   = stamped.value ("path", std::string ());
                if (!method.empty () && !path.empty ()) {
                    if (auto found = by_method_path.find (method_path_key (method, path));
                    found != by_method_path.end ()) {
                        at = found->second;
                    }
                }
            }
        }
    } catch (const std::exception&) {
        // @deliberate: an unparseable stamp names no operation, which is
        // what the absent-identity branch below already answers.
    }
    return at;
}

/// The declaration that answers for @p media under @p status. A wildcard ("any
/// media type", or "any subtype of this type"), which OpenAPI allows and
/// generators emit, is tried only after every exact match, so a document
/// declaring both keeps the specific one.
const ResponseSchemaIndex::DeclaredSchema* ResponseSchemaIndex::select_declared_schema (
const std::vector<DeclaredSchema>& responses,
const std::string& status,
const std::string& media) {
    for (const auto& declared : responses) {
        if (declared.status == status && declared.content_type == media) {
            return &declared;
        }
    }
    for (const auto& declared : responses) {
        if (declared.status != status) {
            continue;
        }
        const auto slash    = declared.content_type.find ('/');
        const bool wildcard = declared.content_type == "*/*" ||
        (slash != std::string::npos && declared.content_type.substr (slash) == "/*" &&
        media.rfind (declared.content_type.substr (0, slash + 1), 0) == 0);
        if (wildcard) {
            return &declared;
        }
    }
    return nullptr;
}

ValidationVerdict ResponseSchemaIndex::check (const std::string& spec_operation,
int status_code,
const std::string& content_type,
const std::string& body) const {
    ValidationVerdict verdict;

    if (status_code <= 0) {
        verdict.reason = UncheckedReason::NoResponse;
        return verdict;
    }

    // `resolve_stamped_operation`'s order, `operationId` first.
    const std::optional<size_t> at =
    resolve_stamped_operation (spec_operation, by_operation_id_, by_method_path_);
    if (spec_operation.empty ()) {
        verdict.reason = UncheckedReason::NoOperation;
        return verdict;
    }
    if (!at) {
        verdict.reason = UncheckedReason::OperationNotDeclared;
        return verdict;
    }

    const auto& operation = operations_[*at];

    // The status pattern that answers, by the function coverage counts with,
    // over every declared status (schema-less ones included), so a wildcard
    // cannot judge a body the spec names an exact status for.
    const auto matched = match_status_pattern (operation.statuses, status_code);
    if (!matched) {
        verdict.reason = UncheckedReason::NoSchemaForStatus;
        return verdict;
    }
    const std::string& status = operation.statuses[*matched];

    const auto declares_schema = [&status] (const DeclaredSchema& declared) {
        return declared.status == status;
    };
    if (std::none_of (operation.responses.begin (), operation.responses.end (), declares_schema)) {
        verdict.reason = UncheckedReason::NoSchemaForStatus;
        return verdict;
    }

    const DeclaredSchema* selected = select_declared_schema (
    operation.responses, status, media_type_of (content_type));
    if (!selected) {
        verdict.reason = UncheckedReason::NoSchemaForContentType;
        return verdict;
    }

    nlohmann::json parsed_body;
    try {
        parsed_body = nlohmann::json::parse (body);
    } catch (const std::exception&) {
        // The contract declares a JSON schema and the server sent something
        // else: a finding, but not one a JSON Schema can state, so it is
        // unchecked with the reason rather than a schema failure invented here.
        verdict.reason = UncheckedReason::BodyNotJson;
        return verdict;
    }
    // nlohmann parses any depth iteratively, but valijson validates
    // recursively: a deep enough body overflows the worker's stack (#2413).
    // Past the bound it is not JSON, as in the element pipeline.
    if (!json_within_depth (parsed_body, constants::elements::MAX_BODY_DEPTH)) {
        verdict.reason = UncheckedReason::BodyNotJson;
        return verdict;
    }

    verdict = validate_body_against_schema (selected->schema, ref_roots_, parsed_body);
    verdict.matched_status       = selected->status;
    verdict.matched_content_type = selected->content_type;
    return verdict;
}

} // namespace vayu::core
