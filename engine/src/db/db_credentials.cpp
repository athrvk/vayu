/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_credentials.cpp
 * @brief Client-certificate registry (issue #707) and its trash (#2973), the
 * allowed folders and picked files for request bodies (`file_roots`,
 * `file_grants`) and the OAuth token cache (issue #1614).
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
#include <utility>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/utils/invariant.hpp"
#include "vayu/utils/logger.hpp"

using namespace sqlite_orm;

namespace vayu::db {

// ---------------------------------------------------------------------------
// Client certificates (issue #707)
// ---------------------------------------------------------------------------
//
// Nothing here logs a path, let alone a passphrase: the registry is credential
// material and the log file is not, which is why the debug lines below name the
// row and its host and stop there.

void Database::save_client_certificate (const ClientCertificate& c) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug (
    "db", "Saving client certificate", { { "id", c.id }, { "host", c.host } });
    impl_->storage.replace (c);
}

// Deleted rows are excluded here rather than at each caller (#2973): the
// transport policy every driver applies is built from this list, so a trashed
// entry that slipped through would be presented to its host on the next send.
std::vector<ClientCertificate> Database::get_client_certificates () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<ClientCertificate> (
    where (is_null (&ClientCertificate::deleted_at)));
}

std::optional<ClientCertificate> Database::get_client_certificate (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<ClientCertificate> (where (
    c (&ClientCertificate::id) == id && is_null (&ClientCertificate::deleted_at)));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

std::optional<ClientCertificate> Database::client_certificate_for_target (
const std::string& host,
const std::optional<int>& port,
const std::string& except_id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    for (auto& row : impl_->storage.get_all<ClientCertificate> (where (
         c (&ClientCertificate::host) == host && c (&ClientCertificate::id) != except_id &&
         is_null (&ClientCertificate::deleted_at)))) {
        // Compared here rather than in SQL, where `port = NULL` is never true
        // and "every port" is a target like any other.
        if (row.port == port) {
            return std::move (row);
        }
    }
    return std::nullopt;
}

// Soft delete (#2973): the row is stamped, not removed, and leaves the policy
// with the stamp - `get_client_certificates` is what the policy reads.
void Database::delete_client_certificate (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting client certificate (soft)", { { "id", id } });
    const int64_t stamp = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
                          .count ();
    impl_->storage.transaction ([&] {
        for (auto& certificate : impl_->storage.get_all<ClientCertificate> (where (
             c (&ClientCertificate::id) == id && is_null (&ClientCertificate::deleted_at)))) {
            certificate.deleted_at = stamp;
            impl_->storage.update (certificate);
        }
        return true; // Commit
    });
}

std::expected<TrashOutcome, RestoreFailure>
Database::restore_client_certificate_locked (const TrashEntry& entry) {
    // The registry's one-entry-per-target rule, which only code enforces: a
    // live entry registered for the same host and port since the delete keeps
    // it, and the way forward is named.
    auto certificate = vayu::utils::invariant_value (
    impl_->storage.get_optional<ClientCertificate> (entry.id),
    "a client certificate's trash entry names a stored row");
    if (const auto holder = client_certificate_for_target (
        certificate.host, certificate.port, certificate.id)) {
        return std::unexpected (RestoreFailure{ RestoreRefusal::TargetTaken,
        "Client certificate '" + entry.id + "' cannot be restored - '" +
        entry.name + "' is already registered to client certificate '" +
        holder->id + "', so delete that entry first" });
    }

    // Clears the stamp and nothing else, so the row comes back as it went in.
    certificate.deleted_at.reset ();
    impl_->storage.update (certificate);
    vayu::utils::log_info (
    "db", "Restored client certificate from trash", { { "id", entry.id } });
    return TrashOutcome{ entry, false };
}

void Database::purge_client_certificate_locked (const std::string& id) {
    impl_->storage.remove_all<ClientCertificate> (where (c (&ClientCertificate::id) == id));
}

// ---------------------------------------------------------------------------
// Allowed folders for request-body files (`file_roots`, schema version 3)
// ---------------------------------------------------------------------------

void Database::save_file_root (const FileRoot& root) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving allowed folder", { { "id", root.id } });
    impl_->storage.replace (root);
}

std::vector<FileRoot> Database::get_file_roots () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<FileRoot> (order_by (&FileRoot::path));
}

std::optional<FileRoot> Database::get_file_root (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<FileRoot> (where (c (&FileRoot::id) == id));
    if (rows.empty ()) {
        return std::nullopt;
    }
    return rows.front ();
}

void Database::delete_file_root (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting allowed folder", { { "id", id } });
    impl_->storage.remove_all<FileRoot> (where (c (&FileRoot::id) == id));
}

// ---------------------------------------------------------------------------
// Files a person picked (`file_grants`, schema version 6, #2356)
// ---------------------------------------------------------------------------

void Database::save_file_grant (const FileGrant& grant) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Saving file grant", { { "id", grant.id } });
    impl_->storage.replace (grant);
}

std::vector<FileGrant> Database::get_file_grants () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<FileGrant> (order_by (&FileGrant::path));
}

std::optional<FileGrant> Database::get_file_grant (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<FileGrant> (where (c (&FileGrant::id) == id));
    if (rows.empty ()) {
        return std::nullopt;
    }
    return rows.front ();
}

void Database::delete_file_grant (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting file grant", { { "id", id } });
    impl_->storage.remove_all<FileGrant> (where (c (&FileGrant::id) == id));
}

// ============================================================================
// OAuth token cache
// ============================================================================

void Database::save_oauth_token (const OAuthToken& t) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    impl_->storage.replace (t);
}

std::optional<OAuthToken> Database::get_oauth_token (const std::string& cache_key) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<OAuthToken> (
    where (c (&OAuthToken::cache_key) == cache_key));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

void Database::delete_oauth_token (const std::string& cache_key) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    impl_->storage.remove_all<OAuthToken> (where (c (&OAuthToken::cache_key) == cache_key));
}

} // namespace vayu::db
