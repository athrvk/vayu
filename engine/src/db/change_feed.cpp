/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db/change_feed.cpp
 * @brief The change feed's ring and wire spellings (issue #3420).
 */

#include "vayu/db/change_feed.hpp"

#include <chrono>
#include <stdexcept>
#include <utility>

namespace vayu::db {

const char* to_string (ChangeKind kind) {
    switch (kind) {
    case ChangeKind::Collection: return "collection";
    case ChangeKind::Request: return "request";
    case ChangeKind::Example: return "example";
    case ChangeKind::Environment: return "environment";
    case ChangeKind::Globals: return "globals";
    case ChangeKind::ClientCertificate: return "clientCertificate";
    }
    return "unknown";
}

const char* to_string (ChangeOp op) {
    switch (op) {
    case ChangeOp::Create: return "create";
    case ChangeOp::Update: return "update";
    case ChangeOp::Delete: return "delete";
    case ChangeOp::Restore: return "restore";
    case ChangeOp::Purge: return "purge";
    }
    return "unknown";
}

ChangeKind change_kind_of_trash_entry (std::string_view trash_kind) {
    for (const auto kind : { ChangeKind::Collection, ChangeKind::Request,
         ChangeKind::Example, ChangeKind::Environment, ChangeKind::ClientCertificate }) {
        if (trash_kind == to_string (kind)) {
            return kind;
        }
    }
    throw std::logic_error (
    "Trash entry kind '" + std::string (trash_kind) + "' names no change kind");
}

nlohmann::json change_json (const Change& change) {
    nlohmann::json out{ { "kind", to_string (change.kind) },
        { "id", change.id }, { "op", to_string (change.op) } };
    if (change.collection_id) {
        out["collectionId"] = *change.collection_id;
    }
    if (change.request_id) {
        out["requestId"] = *change.request_id;
    }
    return out;
}

ChangeFeed::ChangeFeed (int64_t id_base, std::size_t capacity)
: capacity_ (capacity), last_id_ (id_base) {
    if (capacity_ == 0) {
        throw std::invalid_argument (
        "A change feed retains at least one event");
    }
}

void ChangeFeed::append_locked (Change change) {
    ring_.push_back (ChangeEvent{ ++last_id_, std::move (change) });
    if (ring_.size () > capacity_) {
        ring_.pop_front ();
    }
}

void ChangeFeed::publish (Change change) {
    std::lock_guard<std::mutex> lock (mutex_);
    append_locked (std::move (change));
}

void ChangeFeed::publish (std::vector<Change> changes) {
    std::lock_guard<std::mutex> lock (mutex_);
    for (auto& change : changes) {
        append_locked (std::move (change));
    }
}

ChangeFeed::Read ChangeFeed::since (int64_t after_id) const {
    std::lock_guard<std::mutex> lock (mutex_);
    Read read;
    read.last_id = last_id_;
    if (after_id == last_id_) {
        return read;
    }
    // Ids are contiguous, so the oldest retained one fixes every slot. An
    // empty ring has retained nothing after the base.
    const int64_t oldest = ring_.empty () ? last_id_ + 1 : ring_.front ().id;
    if (after_id > last_id_ || after_id < oldest - 1) {
        read.reset = true;
        return read;
    }
    const auto first = static_cast<std::size_t> (after_id + 1 - oldest);
    read.events.assign (
    ring_.begin () + static_cast<std::ptrdiff_t> (first), ring_.end ());
    return read;
}

int64_t ChangeFeed::last_id () const {
    std::lock_guard<std::mutex> lock (mutex_);
    return last_id_;
}

bool ChangeFeed::try_add_reader () {
    int held = readers_.load ();
    while (held < vayu::core::constants::change_feed::MAX_READERS) {
        if (readers_.compare_exchange_weak (held, held + 1)) {
            return true;
        }
    }
    return false;
}

void ChangeFeed::remove_reader () {
    readers_.fetch_sub (1);
}

int64_t change_feed_id_base_now () {
    return std::chrono::duration_cast<std::chrono::microseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

} // namespace vayu::db
