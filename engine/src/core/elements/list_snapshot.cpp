/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/list_snapshot.hpp"

#include "vayu/core/constants.hpp"

#include <array>
#include <expected>
#include <format>
#include <map>
#include <vector>

namespace vayu::core {

namespace {

// The fields a client reads to use an item. Everything else (`_meta`, `icons`,
// a vendor's own members) is left out: a server may change it without changing
// what a client can call.
constexpr std::array<std::string_view, 6> TOOL_FIELDS{ "name", "title",
    "description", "inputSchema", "outputSchema", "annotations" };
constexpr std::array<std::string_view, 6> RESOURCE_FIELDS{ "uri", "name",
    "title", "description", "mimeType", "annotations" };
constexpr std::array<std::string_view, 4> PROMPT_FIELDS{ "name", "title",
    "description", "arguments" };

constexpr std::array<SnapshotList, 3> LISTS{
    SnapshotList{ "tools/list", "tools", "name", TOOL_FIELDS },
    SnapshotList{ "resources/list", "resources", "uri", RESOURCE_FIELDS },
    SnapshotList{ "prompts/list", "prompts", "name", PROMPT_FIELDS },
};

/// The items that survived indexing: identities in the order the list gave
/// them (so a message is deterministic) and each item's compared fields.
struct IndexedItems {
    std::vector<std::string> order;
    std::map<std::string, nlohmann::json, std::less<>> by_identity;
};

/// An item reduced to the compared fields. Converted to `nlohmann::json`
/// because `ordered_json` object equality is order-sensitive and a member
/// order is not a difference.
template <typename Json>
nlohmann::json project (const Json& item, const SnapshotList& list) {
    nlohmann::json projected = nlohmann::json::object ();
    for (const std::string_view field : list.fields) {
        const std::string name (field);
        const auto found = item.find (name);
        if (found != item.end ()) {
            projected[name] = nlohmann::json (*found);
        }
    }
    return projected;
}

/// The text @p item is identified by, or nothing when it is not an object
/// carrying one.
template <typename Json>
std::optional<std::string> identity_of (const Json& item, const SnapshotList& list) {
    if (!item.is_object ()) {
        return std::nullopt;
    }
    const auto found = item.find (std::string (list.identity_key));
    if (found == item.end () || !found->is_string ()) {
        return std::nullopt;
    }
    return found->template get<std::string> ();
}

/// @p items indexed by identity, or why they cannot be: an entry that is not
/// an object with a text identity, or an identity listed twice. @p subject
/// names the array in the reason.
template <typename Json>
std::expected<IndexedItems, std::string>
index_items (const Json& items, const SnapshotList& list, std::string_view subject) {
    IndexedItems indexed;
    size_t position = 0;
    for (const auto& item : items) {
        ++position;
        auto name = identity_of (item, list);
        if (!name) {
            return std::unexpected (
            std::format ("{} item {} must be an object with a text '{}'",
            subject, position, list.identity_key));
        }
        if (indexed.by_identity.contains (*name)) {
            return std::unexpected (
            std::format ("{} names '{}' more than once", subject, *name));
        }
        indexed.by_identity.emplace (*name, project (item, list));
        indexed.order.push_back (std::move (*name));
    }
    return indexed;
}

/// A message is one line of bounded length, and a name or a pointer is a
/// server's text: control characters show as `?` and past
/// `MAX_SNAPSHOT_FRAGMENT_CHARS` characters the rest is `...`. A character is
/// counted at its UTF-8 lead byte and the cut is made before one, so a
/// multi-byte sequence is never split.
std::string one_line (std::string_view text) {
    constexpr unsigned char CONTINUATION_MASK = 0xC0;
    constexpr unsigned char CONTINUATION      = 0x80;
    std::string line;
    size_t characters = 0;
    for (const char c : text) {
        const auto byte = static_cast<unsigned char> (c);
        if ((byte & CONTINUATION_MASK) != CONTINUATION) {
            if (characters == constants::elements::MAX_SNAPSHOT_FRAGMENT_CHARS) {
                line += "...";
                break;
            }
            ++characters;
        }
        line += (byte < 0x20 || byte == 0x7F) ? '?' : c;
    }
    return line;
}

/// The places two projected items differ, the first few kept as pointers and
/// the rest only counted.
class PointerDiff {
    public:
    void add (const nlohmann::json::json_pointer& at) {
        if (shown_.size () < constants::elements::MAX_SNAPSHOT_POINTERS) {
            shown_.push_back (one_line (at.to_string ()));
        }
        ++total_;
    }

    [[nodiscard]] bool empty () const {
        return total_ == 0;
    }

    /// `/a, /b, and 2 more`.
    [[nodiscard]] std::string text () const {
        std::string list;
        for (const auto& pointer : shown_) {
            list += (list.empty () ? "" : ", ") + pointer;
        }
        if (total_ > shown_.size ()) {
            list += std::format (", and {} more", total_ - shown_.size ());
        }
        return list;
    }

    private:
    std::vector<std::string> shown_;
    size_t total_ = 0;
};

void diff_values (const nlohmann::json& before,
const nlohmann::json& after,
const nlohmann::json::json_pointer& at,
PointerDiff& out);

void diff_objects (const nlohmann::json& before,
const nlohmann::json& after,
const nlohmann::json::json_pointer& at,
PointerDiff& out) {
    for (const auto& [key, value] : before.items ()) {
        const auto counterpart = after.find (key);
        if (counterpart == after.end ()) {
            out.add (at / key);
        } else {
            diff_values (value, *counterpart, at / key, out);
        }
    }
    for (const auto& [key, value] : after.items ()) {
        if (!before.contains (key)) {
            out.add (at / key);
        }
    }
}

/// Elements compare in order. Past the shorter array one pointer names where
/// the longer one carries on, not one per surplus element.
void diff_arrays (const nlohmann::json& before,
const nlohmann::json& after,
const nlohmann::json::json_pointer& at,
PointerDiff& out) {
    const size_t shared = std::min (before.size (), after.size ());
    for (size_t i = 0; i < shared; ++i) {
        diff_values (before[i], after[i], at / i, out);
    }
    if (before.size () != after.size ()) {
        out.add (at / shared);
    }
}

void diff_values (const nlohmann::json& before,
const nlohmann::json& after,
const nlohmann::json::json_pointer& at,
PointerDiff& out) {
    if (before.is_object () && after.is_object ()) {
        diff_objects (before, after, at, out);
    } else if (before.is_array () && after.is_array ()) {
        diff_arrays (before, after, at, out);
    } else if (before != after) {
        out.add (at);
    }
}

/// The member @p key of @p parent when @p parent is an object holding it.
const nlohmann::ordered_json*
member_of (const nlohmann::ordered_json& parent, const std::string& key) {
    if (!parent.is_object ()) {
        return nullptr;
    }
    const auto found = parent.find (key);
    return found == parent.end () ? nullptr : &*found;
}

/// `result.<result_key>` of @p reply, or why the reply holds no list.
std::expected<const nlohmann::ordered_json*, std::string>
listed_items (const nlohmann::ordered_json& reply, const SnapshotList& list) {
    const auto* result = member_of (reply, "result");
    const auto* items =
    result == nullptr ? nullptr : member_of (*result, std::string (list.result_key));
    if (items == nullptr || !items->is_array ()) {
        return std::unexpected (std::format (
        "{} changed: the reply holds no 'result.{}' list", list.method, list.result_key));
    }
    return items;
}

/// Removed names, then added ones, then the changed items with where each
/// differs, each group in list order.
std::vector<std::string>
findings_between (const IndexedItems& baseline, const IndexedItems& live) {
    std::vector<std::string> findings;
    for (const auto& name : baseline.order) {
        if (!live.by_identity.contains (name)) {
            findings.push_back (std::format ("removed '{}'", one_line (name)));
        }
    }
    for (const auto& name : live.order) {
        if (!baseline.by_identity.contains (name)) {
            findings.push_back (std::format ("added '{}'", one_line (name)));
        }
    }
    for (const auto& name : baseline.order) {
        const auto counterpart = live.by_identity.find (name);
        if (counterpart == live.by_identity.end ()) {
            continue;
        }
        PointerDiff diff;
        diff_values (baseline.by_identity.at (name), counterpart->second,
        nlohmann::json::json_pointer{}, diff);
        if (!diff.empty ()) {
            findings.push_back (
            std::format ("'{}' differs at {}", one_line (name), diff.text ()));
        }
    }
    return findings;
}

/// The findings the message lists, then how many the cap left out.
std::string drift_message (const SnapshotList& list, const std::vector<std::string>& findings) {
    constexpr size_t KEPT = constants::elements::MAX_SNAPSHOT_FINDINGS;
    std::string joined;
    for (size_t i = 0; i < std::min (findings.size (), KEPT); ++i) {
        joined += (joined.empty () ? "" : "; ") + findings[i];
    }
    if (findings.size () > KEPT) {
        joined += std::format (" ({} more)", findings.size () - KEPT);
    }
    return std::format ("{} changed: {}", list.method, joined);
}

} // namespace

std::span<const SnapshotList> snapshot_lists () {
    return LISTS;
}

const SnapshotList* find_snapshot_list (std::string_view method) {
    for (const auto& list : LISTS) {
        if (list.method == method) {
            return &list;
        }
    }
    return nullptr;
}

std::optional<std::string> snapshot_baseline_problem (const nlohmann::json& baseline,
const SnapshotList& list) {
    if (!baseline.is_array ()) {
        return "'baseline' must be an array of the items " +
        std::string (list.method) + " answered";
    }
    const auto indexed = index_items (baseline, list, "'baseline'");
    if (!indexed) {
        return indexed.error ();
    }
    return std::nullopt;
}

std::optional<std::string> snapshot_drift (const SnapshotList& list,
const nlohmann::ordered_json& reply,
const nlohmann::json& baseline) {
    const auto items = listed_items (reply, list);
    if (!items) {
        return items.error ();
    }
    const auto subject = std::format ("the reply's 'result.{}'", list.result_key);
    const auto live = index_items (**items, list, subject);
    if (!live) {
        return std::format ("{} changed: {}", list.method, live.error ());
    }
    const auto recorded = index_items (baseline, list, "'baseline'");
    if (!recorded) {
        return std::format ("{} cannot be compared: {}", list.method, recorded.error ());
    }
    const auto findings = findings_between (*recorded, *live);
    if (findings.empty ()) {
        return std::nullopt;
    }
    return drift_message (list, findings);
}

} // namespace vayu::core
