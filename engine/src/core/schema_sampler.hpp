#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The stub a JSON Schema samples to: one walk, shared by every reader that has
 * to put a value where a schema describes one (#865, #3839).
 *
 * Internal to `src/core`, and a header for `openapi_walk.hpp`'s reason: it hands
 * out pointers into a caller-owned DOM. The OpenAPI drafts (`openapi_drafts.cpp`)
 * sample a request body or a response example with it; the MCP import samples a
 * tool's `inputSchema` into its arguments. Two copies would be two opinions on
 * what an unannotated schema samples to, and the drafts' copy is compared
 * against stored requests by the sync diff.
 *
 * A `$ref` is a JSON Pointer resolved against the **root** the sampler is
 * constructed with: an OpenAPI document for a body schema, the `inputSchema`
 * itself for a tool (its `#/$defs/x`). A default-constructed `SampleOptions`
 * is the OpenAPI importer's rule set, held byte-for-byte by
 * `tests/fixtures/spec-request-drafts-conformance.json`; the options are the
 * opt-ins a caller with a different notion of "the value to send" turns on.
 */

#include "js_json.hpp"
#include "openapi_walk.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <set>
#include <string>
#include <utility>

namespace vayu::core {

/// The sampler's depth cap. A deeper schema samples to `{}`: a stub the user
/// edits beats a walk that does not end.
constexpr int MAX_SAMPLE_DEPTH = 6;

/// A `$ref` chain already followed on this branch, copied per branch: two
/// sibling properties may each name the same shared schema without either being
/// a cycle.
using SeenRefs = std::set<std::string>;

/**
 * What a caller opts into beyond the OpenAPI importer's rules. Every flag
 * defaults off, which is the importer's exact behaviour.
 */
struct SampleOptions {
    /// A schema's `default` is a stated value, ranked after `const` and before
    /// `example` / `examples[0]`. OpenAPI documents a value to *show*, so the
    /// importer reads `example` alone; a tool call wants the value the server
    /// would use if the argument were absent.
    bool use_default = false;

    /// An object samples only the properties its `required` array names, in
    /// `required` order; no `required` samples to `{}`. A name `required` lists
    /// that `properties` does not declare has no schema to sample and is
    /// skipped.
    bool required_only = false;

    /// A non-empty `enum` samples to `enum[0]` for every scalar `type` and for
    /// no `type` at all. The importer takes it for `type: string` alone, so an
    /// `integer` enum there samples to `0`, a value the enum does not allow.
    bool enum_any_type = false;
};

class SchemaSampler {
    public:
    using json = nlohmann::ordered_json;

    /// @p root is what a `#/...` `$ref` resolves against; it must outlive the
    /// sampler and every pointer the sampler hands back.
    explicit SchemaSampler (const nlohmann::ordered_json& root, SampleOptions options = {})
    : root_ (root), options_ (options) {
    }

    /// The stub @p schema samples to: `{}` for no schema, a non-container, a
    /// cycle, an unresolved `$ref` or a schema past `MAX_SAMPLE_DEPTH`.
    [[nodiscard]] json sample (const json* schema) const {
        return walk (schema, 0, SeenRefs{});
    }

    /// The schema a node ultimately denotes, following `$ref` and the first
    /// `allOf` / `oneOf` / `anyOf` branch under the sampler's cap and guard, or
    /// `nullptr` when there is none. Separate because the walk returns a value
    /// and a caller asking about the declaration (a `format`, `properties`)
    /// needs the node.
    [[nodiscard]] const json*
    resolve_to_schema (const json* node, int depth, SeenRefs seen) const {
        if (depth > MAX_SAMPLE_DEPTH || node == nullptr || !node->is_structured ()) {
            return nullptr;
        }
        if (const std::string* ref = js::as_str (js::prop (node, "$ref"))) {
            if (seen.count (*ref) != 0) {
                return nullptr;
            }
            const json* resolved = walk::resolve_ref (root_, *ref);
            seen.insert (*ref);
            return resolve_to_schema (resolved, depth + 1, std::move (seen));
        }
        const json* branch = first_branch (node);
        if (branch != nullptr) {
            return resolve_to_schema (branch, depth + 1, std::move (seen));
        }
        return node;
    }

    private:
    const json& root_;
    SampleOptions options_;

    /// `schema.allOf ?? schema.oneOf ?? schema.anyOf`, and only when it is a
    /// non-empty array - the first entry of it, which is the whole of what the
    /// sampler reads from a composed schema.
    [[nodiscard]] static const json* first_branch (const json* schema) {
        for (const char* key : { "allOf", "oneOf", "anyOf" }) {
            const json* branch = js::prop (schema, key);
            if (branch == nullptr || branch->is_null ()) {
                continue; // `??` falls through `null` and `undefined` alone.
            }
            return branch->is_array () && !branch->empty () ? &(*branch)[0] : nullptr;
        }
        return nullptr;
    }

    /**
     * The value a schema states, whatever its type: a `const`, a `default` (when
     * `use_default`), an `example`, or the first of 3.1's `examples`. `const`
     * outranks the rest: JSON Schema says the value must be exactly this, where
     * `default` and `example` are annotations.
     */
    [[nodiscard]] const json* stated_value (const json* node) const {
        if (const json* constant = js::prop (node, "const")) {
            return constant;
        }
        if (options_.use_default) {
            if (const json* fallback = js::prop (node, "default")) {
                return fallback;
            }
        }
        if (const json* example = js::prop (node, "example")) {
            return example;
        }
        // 3.1 replaced the singular `example` with an `examples` array.
        if (const json* examples = js::prop (node, "examples");
        examples != nullptr && examples->is_array () && !examples->empty ()) {
            return &(*examples)[0];
        }
        return nullptr;
    }

    /**
     * The type this sampler stubs for. 3.1 writes a nullable field as a type
     * array (`["string", "null"]`) where 3.0 wrote `nullable: true`; the first
     * non-null member is sampled, since a typed stub is what the user edits and
     * only an all-`"null"` type has nothing else. A non-string member is still
     * the one found, and then matches no arm below.
     */
    [[nodiscard]] static std::string declared_type (const json* node) {
        const json* declared = js::prop (node, "type");
        if (declared == nullptr) {
            return {};
        }
        if (declared->is_string ()) {
            return declared->get<std::string> ();
        }
        if (!declared->is_array ()) {
            return {};
        }
        for (const json& member : *declared) {
            if (!(member.is_string () && member.get_ref<const std::string&> () == "null")) {
                return member.is_string () ? member.get<std::string> () : std::string ();
            }
        }
        return "null";
    }

    [[nodiscard]] static bool is_scalar_type (const std::string& type) {
        return type == "string" || type == "integer" || type == "number" ||
        type == "boolean" || type == "null";
    }

    /// `enum[0]` when @p node has a non-empty `enum`.
    [[nodiscard]] static const json* first_enum_value (const json* node) {
        const json* values = js::prop (node, "enum");
        return values != nullptr && values->is_array () && !values->empty () ?
        &(*values)[0] :
        nullptr;
    }

    /// Whether a non-empty `enum` stands in for a value of @p type: `string`
    /// always, every scalar type and no type under `enum_any_type`.
    [[nodiscard]] bool takes_first_enum (const std::string& type) const {
        return type == "string" ||
        (options_.enum_any_type && (type.empty () || is_scalar_type (type)));
    }

    /**
     * The stub a scalar type is sampled as, or nothing for a structured one.
     * `make_optional`, not a bare return: copy-initializing an `optional<json>`
     * from a `json` pits nlohmann's `operator ValueType()` against `optional`'s
     * converting constructor, which GCC reports as an ambiguity under
     * `-Werror`.
     */
    [[nodiscard]] std::optional<json>
    scalar_stub (const json* node, const std::string& type) const {
        if (const json* first_enum = first_enum_value (node);
        first_enum != nullptr && takes_first_enum (type)) {
            return std::make_optional (*first_enum);
        }
        if (type == "string") {
            return std::make_optional (json (""));
        }
        if (type == "integer" || type == "number") {
            return std::make_optional (json (0));
        }
        if (type == "boolean") {
            return std::make_optional (json (false));
        }
        if (type == "null") {
            return std::make_optional (json (nullptr));
        }
        return std::nullopt;
    }

    /// The members of an object schema, each sampled. With `required_only`,
    /// only those `required` names, in `required` order.
    [[nodiscard]] json
    sample_properties (const json* node, int depth, const SeenRefs& seen) const {
        const json* properties = js::as_record (js::prop (node, "properties"));
        json sampled           = json::object ();
        if (properties == nullptr) {
            return sampled;
        }
        if (!options_.required_only) {
            for (auto entry = properties->begin (); entry != properties->end (); ++entry) {
                sampled[entry.key ()] = walk (&entry.value (), depth + 1, seen);
            }
            return sampled;
        }
        const json* required = js::prop (node, "required");
        if (required == nullptr || !required->is_array ()) {
            return sampled;
        }
        for (const json& name : *required) {
            const std::string* key = js::as_str (&name);
            const json* member = key != nullptr ? js::prop (properties, *key) : nullptr;
            if (member != nullptr) {
                sampled[*key] = walk (member, depth + 1, seen);
            }
        }
        return sampled;
    }

    [[nodiscard]] json walk (const json* node, int depth, SeenRefs seen) const {
        // Any container passes, an array included, and an array falls through
        // every branch below to an empty object.
        if (depth > MAX_SAMPLE_DEPTH || node == nullptr || !node->is_structured ()) {
            return json::object ();
        }
        if (const std::string* ref = js::as_str (js::prop (node, "$ref"))) {
            if (seen.count (*ref) != 0) {
                return json::object (); // cycle guard
            }
            const json* resolved = walk::resolve_ref (root_, *ref);
            if (resolved == nullptr || resolved->is_null ()) {
                return json::object ();
            }
            seen.insert (*ref);
            return walk (resolved, depth + 1, std::move (seen));
        }

        if (const json* stated = stated_value (node)) {
            return *stated;
        }

        if (const json* branch = first_branch (node)) {
            return walk (branch, depth + 1, std::move (seen));
        }

        const std::string type = declared_type (node);
        if (auto stub = scalar_stub (node, type)) {
            return *stub;
        }
        if (type == "array") {
            const json* items = js::prop (node, "items");
            if (js::truthy (items)) {
                json sampled = json::array ();
                sampled.push_back (walk (items, depth + 1, std::move (seen)));
                return sampled;
            }
            // 3.1's JSON-Schema-2020-12 tuple form: `items` absent,
            // `prefixItems` naming each position's own schema instead.
            if (const json* tuple = js::prop (node, "prefixItems");
            tuple != nullptr && tuple->is_array () && !tuple->empty ()) {
                json sampled = json::array ();
                for (const json& position : *tuple) {
                    sampled.push_back (walk (&position, depth + 1, seen));
                }
                return sampled;
            }
            return json::array ();
        }
        // No type, or one this sampler has no stub for: fall back to walking the
        // properties, which is what a schema with only `properties` declares.
        return sample_properties (node, depth, seen);
    }
};

} // namespace vayu::core
