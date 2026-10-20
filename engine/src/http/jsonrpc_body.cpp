/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file http/jsonrpc_body.cpp
 * @brief The JSON-RPC 2.0 call envelope. See `vayu/http/jsonrpc_body.hpp` for
 *        why the engine completes it rather than each client.
 */

#include "vayu/http/jsonrpc_body.hpp"

#include <nlohmann/json.hpp>
#include <optional>

#include "vayu/utils/ordered_json.hpp"

namespace vayu::http {

namespace {

/// The only value the spec accepts, and a string rather than the number it
/// reads as.
constexpr const char* kVersion = "2.0";

/// The id a bare call is stamped with when it names none. Constant on purpose -
/// see the header: a replay has to send the bytes it replays.
constexpr int kDefaultId = 1;

bool is_full_envelope (const nlohmann::ordered_json& call) {
    const auto version = call.find ("jsonrpc");
    return version != call.end () && version->is_string ();
}

} // namespace

std::string jsonrpc_wire_body (const std::string& content) {
    if (content.empty ()) {
        return content;
    }

    // Non-throwing, linear parse, and `ordered_json` rather than `json`: a body
    // arrives from a user, being unreadable is an expected answer here, and the
    // members they wrote must come back out in the order they wrote them. A body
    // with a hundred thousand members is still one call to complete.
    auto parsed = utils::parse_ordered_json (content, utils::ORDERED_JSON_UNBOUNDED);

    // Three of the four inputs leave by this door, and one test covers all
    // three because they are one question - is there a single call object here
    // to complete? A parse failure is no value at all; a batch array is not an
    // object; and an object that already declares its version is finished.
    if (!parsed || !parsed->is_object () || is_full_envelope (*parsed)) {
        return content;
    }

    nlohmann::ordered_json& call = *parsed;
    call["jsonrpc"]              = kVersion;
    if (!call.contains ("id")) {
        call["id"] = kDefaultId;
    }
    return call.dump ();
}

} // namespace vayu::http
