/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/spec_binding.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <unordered_set>
#include <utility>

namespace vayu::core {

std::optional<std::string> stamp_spec_binding (const std::string& openapi,
const std::function<std::optional<SpecStamp> (const std::string& spec_id)>& stamp_of) {
    nlohmann::json binding;
    try {
        binding = nlohmann::json::parse (openapi);
    } catch (const std::exception&) {
        return std::nullopt; // Not a binding; unbound is how every reader takes it.
    }
    if (!binding.is_object () || binding.empty ()) {
        return std::nullopt;
    }
    const auto spec_id = binding.value ("specId", std::string ());
    if (spec_id.empty ()) {
        return std::nullopt; // Names nothing; the write cores refuse it.
    }

    const bool has_hash = binding.contains ("specHash") &&
    binding["specHash"].is_string () &&
    !binding["specHash"].get<std::string> ().empty ();
    const bool has_time =
    binding.contains ("syncedAt") && binding["syncedAt"].is_number ();
    if (has_hash && has_time) {
        return std::nullopt;
    }

    const auto stamp = stamp_of (spec_id);
    if (!stamp) {
        return std::nullopt;
    }
    if (!has_hash) {
        binding["specHash"] = stamp->hash;
    }
    if (!has_time) {
        binding["syncedAt"] = stamp->synced_at;
    }
    return binding.dump ();
}

namespace {

/// A binding field, or `""` for one that is absent or not a string. Typed
/// rather than `value()`d because a column edited from outside the engine can
/// hold anything, and `value()` throws on a type it did not expect.
std::string string_field (const nlohmann::json& binding, const char* key) {
    const auto field = binding.find (key);
    return field != binding.end () && field->is_string () ?
    field->get<std::string> () :
    std::string ();
}

} // namespace

std::optional<BoundSpec>
nearest_spec_binding (vayu::db::Database& db, const std::string& collection_id) {
    return nearest_spec_binding (
    [&db] (const std::string& id) { return db.get_collection (id); }, collection_id);
}

std::optional<BoundSpec> nearest_spec_binding (const CollectionLookup& lookup,
const std::string& collection_id) {
    // Leaf upwards, so the first bound collection met is the *nearest* one.
    std::unordered_set<std::string> seen;
    std::string current = collection_id;
    while (!current.empty () && seen.insert (current).second) {
        const auto collection = lookup (current);
        if (!collection) {
            break;
        }
        current                      = collection->parent_id.value_or ("");
        const nlohmann::json binding = nlohmann::json::parse (
        collection->openapi, nullptr, /*allow_exceptions=*/false);
        if (!binding.is_object ()) {
            continue; // an unparseable column binds nothing, as everywhere else
        }
        auto spec_id = string_field (binding, "specId");
        if (spec_id.empty ()) {
            continue;
        }
        return BoundSpec{ collection->id, std::move (spec_id),
            string_field (binding, "specHash") };
    }
    return std::nullopt;
}

std::optional<std::string> declined_by_move (const vayu::db::Request& stored,
const std::optional<BoundSpec>& before,
const std::optional<BoundSpec>& after) {
    if (!stored.spec_operation || !before) {
        return std::nullopt;
    }
    if (after && after->spec_id == before->spec_id) {
        return std::nullopt;
    }
    return before->collection_id;
}

} // namespace vayu::core
