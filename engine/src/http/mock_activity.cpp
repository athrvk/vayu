/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/http/mock_activity.hpp"

#include <algorithm>
#include <iterator>

namespace vayu::http {

void MockActivityLog::record (MockActivityEntry entry) {
    std::scoped_lock lock (mutex_);
    entries_.push_back (std::move (entry));
    while (entries_.size () > capacity_) {
        entries_.pop_front ();
    }
}

std::vector<MockActivityEntry> MockActivityLog::snapshot (std::size_t limit) const {
    std::scoped_lock lock (mutex_);
    const std::size_t take = std::min (limit, entries_.size ());
    std::vector<MockActivityEntry> out;
    out.reserve (take);
    auto it = entries_.rbegin ();
    std::advance (it, static_cast<std::ptrdiff_t> (take));
    std::copy (entries_.rbegin (), it, std::back_inserter (out));
    return out;
}

nlohmann::json mock_activity_entry_json (const MockActivityEntry& entry) {
    nlohmann::json out;
    out["at"]            = entry.at_ms;
    out["method"]        = entry.method;
    out["path"]          = entry.path;
    out["requestId"]     = entry.request_id.has_value () ?
        nlohmann::json (*entry.request_id) :
        nlohmann::json (nullptr);
    out["requestName"]   = entry.request_name.has_value () ?
      nlohmann::json (*entry.request_name) :
      nlohmann::json (nullptr);
    out["exampleId"]     = entry.example_id.has_value () ?
        nlohmann::json (*entry.example_id) :
        nlohmann::json (nullptr);
    out["exampleName"]   = entry.example_name.has_value () ?
      nlohmann::json (*entry.example_name) :
      nlohmann::json (nullptr);
    out["status"]        = entry.status;
    out["injectedError"] = entry.injected_error;
    return out;
}

} // namespace vayu::http
