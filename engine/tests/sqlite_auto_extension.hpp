#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file tests/sqlite_auto_extension.hpp
 * @brief `ScopedAutoExtension`: a hook installed on every SQLite connection
 *        opened while it lives.
 *
 * A test cannot reach the connection a `Database` holds, so it reopens the
 * database inside one of these and the hook lands on the storage's own
 * connection as it opens. Shared by `runs_route_test.cpp` (stand-in SQL
 * functions that count predicate calls) and `trash_listing_cost_test.cpp`
 * (a statement trace and a column-read authorizer).
 */

#include <sqlite3.h>

namespace vayu::tests {

/// What `sqlite3_auto_extension` calls on each new connection, as SQLite
/// declares it (`sqlite3_loadext_entry`).
using AutoExtensionInit = int (*) (sqlite3*, char**, const sqlite3_api_routines*);

/// Registers @p init for every connection opened while this lives. Cancelled
/// on scope exit because a direct run of the binary (no ctest) keeps one
/// process for every test after this one. A hook already installed on a
/// connection stays there until that connection closes.
class ScopedAutoExtension {
    public:
    explicit ScopedAutoExtension (AutoExtensionInit init)
    : registered (sqlite3_auto_extension (type_erased (init))),
      entry_ (type_erased (init)) {
    }
    ~ScopedAutoExtension () {
        sqlite3_cancel_auto_extension (entry_);
    }
    ScopedAutoExtension (const ScopedAutoExtension&)            = delete;
    ScopedAutoExtension& operator= (const ScopedAutoExtension&) = delete;
    ScopedAutoExtension (ScopedAutoExtension&&)                 = delete;
    ScopedAutoExtension& operator= (ScopedAutoExtension&&)      = delete;

    /// `SQLITE_OK` when the hook was registered.
    const int registered;

    private:
    // sqlite3_auto_extension takes its entry point type-erased and casts it
    // back to `sqlite3_loadext_entry` before calling it.
    static void (*type_erased (AutoExtensionInit init)) () {
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast)
        return reinterpret_cast<void (*) ()> (init);
    }

    void (*entry_) ();
};

} // namespace vayu::tests
