/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file db_credentials.cpp
 * @brief Client-certificate registry (issue #707) and the OAuth token cache
 * (issue #1614).
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

std::vector<ClientCertificate> Database::get_client_certificates () {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    return impl_->storage.get_all<ClientCertificate> ();
}

std::optional<ClientCertificate> Database::get_client_certificate (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    auto rows = impl_->storage.get_all<ClientCertificate> (
    where (c (&ClientCertificate::id) == id));
    if (rows.empty ())
        return std::nullopt;
    return rows.front ();
}

void Database::delete_client_certificate (const std::string& id) {
    std::lock_guard<std::recursive_mutex> lock (impl_->mutex);
    vayu::utils::log_debug ("db", "Deleting client certificate", { { "id", id } });
    impl_->storage.remove_all<ClientCertificate> (where (c (&ClientCertificate::id) == id));
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
