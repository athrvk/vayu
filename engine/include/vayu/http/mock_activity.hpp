#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstdint>
#include <deque>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace vayu::http {

/** One request a mock server answered, or failed to match (issue #481 phase 3). */
struct MockActivityEntry {
    std::int64_t at_ms = 0;
    std::string method;
    std::string path;
    /// Unset when nothing in the route table matched this path/method at all.
    std::optional<std::string> request_id;
    std::optional<std::string> request_name;
    /// Unset alongside `request_id`, and also when the matched route had no
    /// example to serve (a 501).
    std::optional<std::string> example_id;
    std::optional<std::string> example_name;
    int status          = 0;
    bool injected_error = false;
};

/**
 * A bounded, mutex-guarded record of what one running mock has served (issue
 * #481 phase 3).
 *
 * Unlike the route table, which is an immutable start-time snapshot read
 * lock-free from every listener thread, this is written from every listener
 * thread on every single request - so it needs a lock the route table does
 * not.
 */
class MockActivityLog {
    public:
    explicit MockActivityLog (std::size_t capacity) : capacity_ (capacity) {
    }

    /// Appends @p entry, dropping the oldest past capacity.
    void record (MockActivityEntry entry);

    /// At most @p limit entries, newest first.
    std::vector<MockActivityEntry> snapshot (std::size_t limit) const;

    private:
    std::size_t capacity_;
    mutable std::mutex mutex_;
    std::deque<MockActivityEntry> entries_; // oldest at front, newest at back
};

/** The wire shape of one entry, for `GET /mock/:id/activity`. */
nlohmann::json mock_activity_entry_json (const MockActivityEntry& entry);

} // namespace vayu::http
