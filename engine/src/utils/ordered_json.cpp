/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

// MSVC's /Od build (the Windows ASan leg alone; /O2 folds the code away) reports
// nlohmann's `binary_reader::byte_swap` as C4702, which /WX makes fatal. `sax_parse`
// instantiates every input format's reader, so the template is compiled here though
// no binary format is parsed. The warning is attributed to the line of the
// definition, so the suppression has to cover the include that holds it.
#ifdef _MSC_VER
#pragma warning(push)
#pragma warning(disable : 4702)
#endif
#include "vayu/utils/ordered_json.hpp"
#ifdef _MSC_VER
#pragma warning(pop)
#endif

#include <algorithm>
#include <functional>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace vayu::utils {

namespace {

using OrderedJson    = nlohmann::ordered_json;
using PendingMembers = std::vector<std::pair<std::string, OrderedJson>>;

/// Which member of an object being read holds a key: an open-addressing table
/// of positions into the members, so placing a member is one hash and a probe
/// whatever the object's width. It allocates only when it doubles, and keeps
/// its table when cleared, so the next object at the same depth reuses it. A
/// node-based map spent one allocation per key, which on a 100,000-member body
/// was a third of every allocation its read made.
///
/// It stores positions, never keys or pointers: the members vector moves its
/// strings when it grows, and the caller passes it in on every call.
class KeyIndex {
    public:
    [[nodiscard]] bool empty () const {
        return used_ == 0;
    }

    /// Empties the table and keeps its capacity. It does not refill the old
    /// table: a frame that once held a wide object is reused for every
    /// container opened at its depth, and refilling that table each time
    /// would cost the widest object's width per container. `grow` writes only
    /// the size the next object reaches.
    void clear () {
        slots_.clear ();
        used_ = 0;
    }

    /// The position of @p key among @p members, adding @p next as its
    /// position when it is not there yet. Every member before @p next is
    /// indexed already.
    size_t find_or_add (const PendingMembers& members, const std::string& key, size_t next) {
        if ((used_ + 1) * 2 > slots_.size ()) {
            grow (members, next);
        }
        const size_t mask = slots_.size () - 1;
        for (size_t slot = std::hash<std::string>{}(key)&mask;; slot = (slot + 1) & mask) {
            const size_t held = slots_.at (slot);
            if (held == EMPTY) {
                slots_.at (slot) = next;
                ++used_;
                return next;
            }
            if (members.at (held).first == key) {
                return held;
            }
        }
    }

    private:
    static constexpr size_t EMPTY = std::numeric_limits<size_t>::max ();

    /// Doubles the table (a power of two, at most half full) and re-places
    /// the first @p count members.
    void grow (const PendingMembers& members, size_t count) {
        slots_.assign (std::max<size_t> (slots_.size () * 2, 64), EMPTY);
        used_             = 0;
        const size_t mask = slots_.size () - 1;
        for (size_t i = 0; i < count; ++i) {
            size_t slot = std::hash<std::string>{}(members.at (i).first) & mask;
            while (slots_.at (slot) != EMPTY) {
                slot = (slot + 1) & mask;
            }
            slots_.at (slot) = i;
            ++used_;
        }
    }

    std::vector<size_t> slots_;
    size_t used_ = 0;
};

/// Builds an `OrderedJson` from the parser's events with an explicit stack,
/// one frame per open container, so nothing here recurses. An object frame
/// indexes its keys once it outgrows a short scan, which is what lets a member
/// be placed without `ordered_map::emplace`'s scan of every member before it.
///
/// An object's members are gathered in a vector of `std::pair<std::string,
/// OrderedJson>` and moved into the object once, at its closing brace, into a
/// vector sized for them. `ordered_map` itself keeps `std::pair<const
/// std::string, OrderedJson>`, which the `const` key makes not
/// nothrow-movable, so a vector of those copies every member - nested values
/// included, deep - each time it grows. Gathered that way, a 100,000-member
/// object spent most of its parse copying members it had already placed.
class OrderedTreeBuilder final : public nlohmann::json_sax<OrderedJson> {
    public:
    explicit OrderedTreeBuilder (size_t max_depth) : max_depth_ (max_depth) {
    }

    bool null () override {
        return place_leaf (nullptr);
    }
    bool boolean (bool val) override {
        return place_leaf (val);
    }
    bool number_integer (number_integer_t val) override {
        return place_leaf (val);
    }
    bool number_unsigned (number_unsigned_t val) override {
        return place_leaf (val);
    }
    bool number_float (number_float_t val, const string_t& /*raw*/) override {
        return place_leaf (val);
    }
    bool string (string_t& val) override {
        return place_leaf (std::move (val));
    }
    bool binary (binary_t& val) override {
        return place_leaf (OrderedJson::binary (std::move (val)));
    }
    // The element-count hints are always "unknown" for JSON text.
    bool start_object (size_t /*elements*/) override {
        return open (true);
    }
    bool start_array (size_t /*elements*/) override {
        return open (false);
    }
    bool key (string_t& val) override {
        top ().key = std::move (val);
        return true;
    }
    bool end_object () override {
        return close ();
    }
    bool end_array () override {
        return close ();
    }
    bool parse_error (size_t /*position*/,
    const std::string& /*last_token*/,
    const nlohmann::detail::exception& /*ex*/) override {
        return false;
    }

    [[nodiscard]] OrderedJson take_root () {
        return std::move (root_);
    }

    private:
    using Members = OrderedJson::object_t::Container;

    /// Below this many members a scan beats hashing every key of the small
    /// objects most bodies are made of; past it the scan would be the O(n^2).
    static constexpr size_t SCANNED_MEMBERS = 16;

    struct Frame {
        bool is_object = false;
        /// An array's elements; `OrderedJson` moves without throwing, so this
        /// vector moves them when it grows.
        OrderedJson::array_t elements;
        /// An object's members, in the order first seen.
        PendingMembers members;
        /// Where each key sits in `members`, once an object has
        /// `SCANNED_MEMBERS`; empty before that and for an array.
        KeyIndex member_index;
        /// The key the next value is placed under; objects only.
        std::string key;
    };

    /// A value is placed at depth `depth_`.
    [[nodiscard]] bool too_deep () const {
        return depth_ > max_depth_;
    }

    Frame& top () {
        return frames_.at (depth_ - 1);
    }

    bool place_leaf (OrderedJson value) {
        return !too_deep () && place (std::move (value));
    }

    bool open (bool is_object) {
        if (too_deep ()) {
            return false;
        }
        if (depth_ == frames_.size ()) {
            frames_.emplace_back ();
        }
        Frame& frame    = frames_.at (depth_++);
        frame.is_object = is_object;
        frame.members.clear ();
        frame.elements.clear ();
        frame.member_index.clear ();
        frame.key.clear ();
        return true;
    }

    bool close () {
        Frame& frame = top ();
        OrderedJson done;
        if (frame.is_object) {
            done = OrderedJson::object ();
            auto& members =
            static_cast<Members&> (done.get_ref<OrderedJson::object_t&> ());
            members.reserve (frame.members.size ());
            for (auto& [name, value] : frame.members) {
                members.emplace_back (std::move (name), std::move (value));
            }
        } else {
            done = OrderedJson (std::move (frame.elements));
        }
        --depth_;
        return place (std::move (done));
    }

    bool place (OrderedJson value) {
        if (depth_ == 0) {
            root_ = std::move (value);
            return true;
        }
        Frame& frame = top ();
        if (!frame.is_object) {
            frame.elements.push_back (std::move (value));
            return true;
        }
        const size_t slot = member_slot (frame);
        if (slot == frame.members.size ()) {
            frame.members.emplace_back (std::move (frame.key), std::move (value));
        } else {
            frame.members.at (slot).second = std::move (value);
        }
        return true;
    }

    /// Where `top.key` already sits in `top.members`, or `top.members.size ()`.
    static size_t member_slot (Frame& top) {
        const PendingMembers& members = top.members;
        if (top.member_index.empty () && members.size () < SCANNED_MEMBERS) {
            const auto found =
            std::ranges::find (members, top.key, &PendingMembers::value_type::first);
            return static_cast<size_t> (found - members.begin ());
        }
        // The first call past the scan indexes every member placed so far,
        // through the table's growth.
        return top.member_index.find_or_add (members, top.key, members.size ());
    }

    size_t max_depth_;
    /// One frame per open container, `depth_` of them in use. A frame closed
    /// is kept and reused by the next container opened at its depth, so its
    /// buffers keep their capacity: a body of many small objects (a derived
    /// schema's `{"type": ...}` per member) opens one frame per object, and
    /// allocating each afresh was most of what reading one back cost. Frames
    /// move without throwing, so the vector moves rather than copies them
    /// when a deeper document makes it grow.
    std::vector<Frame> frames_;
    size_t depth_ = 0;
    OrderedJson root_;
};

} // namespace

std::optional<nlohmann::ordered_json>
parse_ordered_json (std::string_view text, size_t max_depth) {
    OrderedTreeBuilder builder (max_depth);
    if (!nlohmann::ordered_json::sax_parse (text, &builder)) {
        return std::nullopt;
    }
    // In place: a json converts to anything, `std::optional` included.
    return std::optional<nlohmann::ordered_json>{ std::in_place, builder.take_root () };
}

void append_unique_member (nlohmann::ordered_json& object,
std::string key,
nlohmann::ordered_json value) {
    using Members = OrderedJson::object_t::Container;
    static_cast<Members&> (object.get_ref<OrderedJson::object_t&> ())
    .emplace_back (std::move (key), std::move (value));
}

void reserve_members (nlohmann::ordered_json& object, size_t count) {
    using Members = OrderedJson::object_t::Container;
    auto& members = static_cast<Members&> (object.get_ref<OrderedJson::object_t&> ());
    members.reserve (members.size () + count);
}

} // namespace vayu::utils
