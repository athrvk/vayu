/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_requests.cpp
 * @brief Requests and their saved examples (issue #481), plus bulk import
 * (issue #96) (issue #1614).
 */

#include "database_impl.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <expected>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/utils/logger.hpp"

using namespace sqlite_orm;

namespace vayu::db {

void Database::purge_request_locked (const std::string& id) {
    impl_->storage.transaction ([&] {
        impl_->storage.remove_all<RequestExample> (
        where (c (&RequestExample::request_id) == id));
        impl_->storage.remove_all<Request> (where (c (&Request::id) == id));
        return true; // Commit
    });
}

// ============================================================================
// Requests - HTTP request definitions with pre/post scripts
// ============================================================================

void Database::save_request (const Request& r) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug (
    "db", "Saving request", { { "id", r.id }, { "name", r.name } });
    impl_->storage.replace (r);
}

std::optional<Request> Database::get_request (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto requests = impl_->storage.get_all<Request> (
    where (c (&Request::id) == id && is_null (&Request::deleted_at)));
    if (requests.empty ())
        return std::nullopt;
    return requests.front ();
}

std::vector<Request> Database::get_requests_in_collection (const std::string& collection_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // Same three-key tie rule as get_collections - see the comment there for why
    // the implicit rowid cannot be the tiebreak. Deleted rows are excluded on
    // the same reasoning too (issue #988); a deleted *collection* answers with
    // nothing at all, because every caller reaches this through a
    // `get_collection` that already refused.
    return impl_->storage.get_all<Request> (
    where (c (&Request::collection_id) == collection_id && is_null (&Request::deleted_at)),
    multi_order_by (order_by (&Request::order), order_by (&Request::created_at),
    order_by (&Request::id)));
}

// Soft delete (issue #988): the row is stamped, not removed. Its examples stay
// where they are - every read of them is by request id and goes through a
// request this stamp has made unreadable, so they are as gone as the request
// is, and a restore that had to re-create them could not.
void Database::delete_request (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting request (soft)", { { "id", id } });
    const int64_t stamp = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                          .count ();
    impl_->storage.transaction ([&] {
        for (auto& request : impl_->storage.get_all<Request> (
             where (c (&Request::id) == id && is_null (&Request::deleted_at)))) {
            request.deleted_at = stamp;
            impl_->storage.update (request);
        }
        return true; // Commit
    });
}

// ============================================================================
// Request examples - saved example responses owned by a request (issue #481)
// ============================================================================

void Database::save_request_example (const RequestExample& e) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving request example",
    { { "id", e.id }, { "requestId", e.request_id } });
    impl_->storage.replace (e);
}

/**
 * One example by id - a tombstoned row reads as gone (issue #722).
 *
 * The filter is here rather than in each caller because this is what the
 * owner check of every `/requests/:id/examples/:exampleId` route reads: a
 * suppressed row answering 200 would let a `PUT` bring a deleted example back
 * by writing over its tombstone.
 */
std::optional<RequestExample> Database::get_request_example (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<RequestExample> (where (
    c (&RequestExample::id) == id and c (&RequestExample::suppressed) == false));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

std::vector<RequestExample> Database::get_request_examples (const std::string& request_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // The same three-key tie rule the other list reads use (see
    // get_collections), and here it is a contract rather than a display
    // preference: a mock server serves the *first* matching example. `order`
    // has to lead, because a bulk import writes every example of one request in
    // the same millisecond - on `created_at` alone they all tie and the id
    // tiebreak returns the author's list shuffled.
    // Tombstoned rows are excluded here and not by the callers, so a deleted
    // imported example is invisible to the list route, the mock server and the
    // export alike (issue #722).
    return impl_->storage.get_all<RequestExample> (
    where (c (&RequestExample::request_id) == request_id and
    c (&RequestExample::suppressed) == false),
    multi_order_by (order_by (&RequestExample::order),
    order_by (&RequestExample::created_at), order_by (&RequestExample::id)));
}

/**
 * The request's tombstones - deleted imported examples (issue #722).
 *
 * The one read that sees suppressed rows, and it exists for one caller: the
 * spec sync's `refresh_examples`, which has to know which statuses the user
 * removed before writing the document's examples back.
 */
std::vector<RequestExample> Database::get_suppressed_request_examples (
const std::string& request_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<RequestExample> (
    where (c (&RequestExample::request_id) == request_id and
    c (&RequestExample::suppressed) == true));
}

int64_t Database::count_request_examples (const std::string& request_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    // Tombstones do not count against `MAX_PER_REQUEST`: a user who deletes an
    // imported example has fewer examples, not the same number with one hidden.
    return impl_->storage.count<RequestExample> (
    where (c (&RequestExample::request_id) == request_id and
    c (&RequestExample::suppressed) == false));
}

void Database::delete_request_example (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting request example", { { "id", id } });
    impl_->storage.remove_all<RequestExample> (where (c (&RequestExample::id) == id));
}

/**
 * Turns an imported example into a tombstone (issue #722).
 *
 * The row stays so a later sync knows the status was removed on purpose; what
 * it held does not, because nothing reads a suppressed row's body.
 */
void Database::suppress_request_example (const std::string& id, int64_t now) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Suppressing imported request example", { { "id", id } });
    auto rows =
    impl_->storage.get_all<RequestExample> (where (c (&RequestExample::id) == id));
    if (rows.empty ()) {
        return;
    }
    RequestExample row = rows.front ();
    row.suppressed     = true;
    row.body           = "";
    row.headers        = "";
    row.content_type   = "";
    row.body_truncated = false;
    row.updated_at     = now;
    impl_->storage.replace (row);
}

// ============================================================================
// Bulk import - collections + requests + environments in one transaction
// ============================================================================

// A payload that fails to write leaves nothing behind (issue #96). Same shape as
// add_results_batch: retry_on_busy holds the recursive mutex while the lambda
// runs, and the lambda only touches the same storage handle.
void Database::import_apply (const std::vector<Collection>& collections,
const std::vector<Request>& requests,
const std::vector<Environment>& environments,
const std::vector<RequestExample>& examples,
const std::vector<SpecDocument>& specs) {
    if (collections.empty () && requests.empty () && environments.empty () &&
    examples.empty () && specs.empty ()) {
        return;
    }

    vayu::utils::log_debug ("db",
    "Applying import: " + std::to_string (collections.size ()) +
    " collections, " + std::to_string (requests.size ()) + " requests, " +
    std::to_string (environments.size ()) + " environments, " +
    std::to_string (examples.size ()) + " examples, " +
    std::to_string (specs.size ()) + " specs");

    retry_on_busy ("apply import", 5, std::chrono::milliseconds (100), [&] {
        impl_->storage.transaction ([&] {
            // Ahead of the collections, which may bind them - the same
            // owner-before-referrer order the rest of this transaction keeps.
            for (const auto& s : specs) {
                impl_->storage.replace (s);
            }
            for (const auto& c : collections) {
                impl_->storage.replace (c);
            }
            for (const auto& r : requests) {
                impl_->storage.replace (r);
            }
            // After the requests they belong to, so the rows land in owner
            // order like everything else here.
            for (const auto& x : examples) {
                impl_->storage.replace (x);
            }
            for (const auto& e : environments) {
                // Same at-most-one-active rule as save_environment, applied per
                // row: an import that carries an active environment deactivates
                // the one already stored, and if the payload somehow carries
                // two the last one wins rather than both surviving.
                if (e.is_active) {
                    deactivate_other_environments_locked (e.id);
                }
                impl_->storage.replace (e);
            }
            return true; // Commit
        });
    });
}

} // namespace vayu::db
