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
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace vayu::utils {

namespace {

using OrderedJson = nlohmann::ordered_json;

/// Builds an `OrderedJson` from the parser's events with an explicit stack,
/// one frame per open container, so nothing here recurses. An object frame
/// indexes its keys once it outgrows a short scan, which is what lets a member
/// be placed without `ordered_map::emplace`'s scan of every member before it.
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
        return open (OrderedJson::object ());
    }
    bool start_array (size_t /*elements*/) override {
        return open (OrderedJson::array ());
    }
    bool key (string_t& val) override {
        frames_.back ().key = std::move (val);
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
        OrderedJson container;
        /// Key -> index into `container`'s members, once an object has
        /// `SCANNED_MEMBERS`; empty before that and for an array.
        std::unordered_map<std::string, size_t> member_index;
        /// The key the next value is placed under; objects only.
        std::string key;
    };

    /// A value is placed at depth `frames_.size ()`.
    [[nodiscard]] bool too_deep () const {
        return frames_.size () > max_depth_;
    }

    bool place_leaf (OrderedJson value) {
        return !too_deep () && place (std::move (value));
    }

    bool open (OrderedJson container) {
        if (too_deep ()) {
            return false;
        }
        frames_.push_back (Frame{ std::move (container), {}, {} });
        return true;
    }

    bool close () {
        OrderedJson done = std::move (frames_.back ().container);
        frames_.pop_back ();
        return place (std::move (done));
    }

    bool place (OrderedJson value) {
        if (frames_.empty ()) {
            root_ = std::move (value);
            return true;
        }
        Frame& top = frames_.back ();
        if (top.container.is_array ()) {
            top.container.get_ref<OrderedJson::array_t&> ().push_back (std::move (value));
            return true;
        }
        // The vector underneath: `ordered_map` hides `operator[] (size_t)`
        // and its `emplace` is the unbounded scan this class exists to avoid.
        auto& members =
        static_cast<Members&> (top.container.get_ref<OrderedJson::object_t&> ());
        const size_t slot = member_slot (top, members);
        if (slot == members.size ()) {
            members.emplace_back (std::move (top.key), std::move (value));
        } else {
            members.at (slot).second = std::move (value);
        }
        return true;
    }

    /// Where `top.key` already sits in @p members, or `members.size ()`.
    static size_t member_slot (Frame& top, const Members& members) {
        if (top.member_index.empty () && members.size () < SCANNED_MEMBERS) {
            const auto found =
            std::ranges::find (members, top.key, &Members::value_type::first);
            return static_cast<size_t> (found - members.begin ());
        }
        if (top.member_index.empty ()) {
            for (size_t i = 0; i < members.size (); ++i) {
                top.member_index.emplace (members.at (i).first, i);
            }
        }
        return top.member_index.try_emplace (top.key, members.size ()).first->second;
    }

    size_t max_depth_;
    std::vector<Frame> frames_;
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

} // namespace vayu::utils
