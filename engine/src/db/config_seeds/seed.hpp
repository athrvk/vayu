/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

/**
 * @file seed.hpp
 * @brief What every category file under `config_seeds/` shares (issue #1611).
 *
 * `Database::seed_default_config` used to be one 990-line function; this
 * header carries what it factored out so a category file needs nothing but
 * this include and `vayu/types.hpp`'s `ConfigEntry`. See `ConfigSeeder` below
 * for how it reaches back into `Database`'s private storage without exposing
 * `Database::Impl` (that split is #1614's, over the table-family members).
 */

#include "vayu/types.hpp"

#include <nlohmann/json.hpp>

#include <array>
#include <chrono>
#include <cstdint>
#include <format>
#include <functional>
#include <initializer_list>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace vayu::db::config_seeds {

/// Milliseconds since the epoch, the `updated_at` every seeded entry stamps.
inline int64_t now_ms () {
    return std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::system_clock::now ().time_since_epoch ())
    .count ();
}

// Retired settings: keys nothing reads any more. `seed_default_config`
// deletes any row left behind by an older version so the Settings UI (which
// renders engine entries dynamically from GET /config) stops offering a dead
// knob.
//
//   requestBatchSize - drove the removed batched request iteration.
//   contextPoolSize  - promised "pre-initialized JS contexts", but the
//                      script context pool is grown lazily and never read a
//                      bound (issue #112). A user could set it 1..256 and
//                      change nothing.
//
// The 2026-08 sweep (#519) retired eleven more. Each was verified by
// searching the engine for a reader; where the constant behind the key kept
// its own callers, the constant stayed and only the knob went.
//
//   maxConnections       - no reader anywhere; the server enforces no such
//                          global limit.
//   tcpKeepAliveIdle     - curl_utils sets both CURL keep-alive options from
//   tcpKeepAliveInterval   constants and never consults the config.
//   statsInterval        - superseded by liveTickIntervalMs, which shares its
//                          default and its purpose and is the one that is
//                          read. Two rows, one mechanism.
//   maxJsonFieldSize     - json.cpp caps stored fields at the constant, so
//                          the "increase only if..." escape hatch the
//                          description offered did not exist.
//   sseConnectTimeout    - the dashboard's reconnect logic is renderer-side
//   sseMaxRetry            and never asked the engine for these; the sse::*
//   sseSendLastEventId     constants existed only to seed them.
//   dbTempStore          - all three are PRAGMAs the open callback applies
//   dbMmapSize             from constants. Wiring them buys nothing: the
//   dbWalAutocheckpoint    defaults are already the measured optimum (see
//                          docs/engine/benchmarks.md) and none has a user
//                          story. dbCacheSize, the one that does, is wired
//                          instead of retired.
inline constexpr std::array<const char*, 13> kRetiredConfigKeys = {
    "requestBatchSize", "contextPoolSize", "maxConnections", "tcpKeepAliveIdle",
    "tcpKeepAliveInterval", "statsInterval", "maxJsonFieldSize", "sseConnectTimeout",
    "sseMaxRetry", "sseSendLastEventId", "dbTempStore", "dbMmapSize", "dbWalAutocheckpoint"
};

/**
 * @brief Everything `Database::seed_default_config` used to do before it
 * became the seven per-category calls: delete the retired-key rows, index
 * the rows a reseed must preserve, and - through `operator()` - upsert one
 * entry, preserving a user's existing value, while refusing a key seeded
 * twice across the seven category files.
 *
 * The single function this replaces made that duplication impossible by
 * inspection - one function, read top to bottom. Split across seven files it
 * is not, so the check that used to be free is now explicit: `operator()`
 * throws `std::runtime_error` naming the key the moment a second category
 * tries to seed it, which fails engine startup loudly rather than letting
 * the second write silently win. `known_keys` is cleared on construction, so
 * a fresh engine start's pass never flags a key the *previous* pass seeded.
 *
 * Reaches back into `Database`'s private storage through two type-erased
 * callbacks rather than exposing `Database::Impl` (that split is #1614's,
 * over the table-family members - config seeding never touches a stored row
 * outside this one pass, so it does not need the storage type at all, only
 * the ability to write and delete one row).
 */
class ConfigSeeder {
    public:
    ConfigSeeder (std::vector<ConfigEntry> existing,
    std::unordered_set<std::string>& known_keys,
    std::function<void (const ConfigEntry&)> replace,
    const std::function<void (const std::string&)>& remove)
    : known_keys_ (known_keys), replace_ (std::move (replace)) {
        known_keys_.clear ();
        for (const char* retired : kRetiredConfigKeys) {
            remove (retired);
        }
        for (auto& entry : existing) {
            existing_[entry.key] = std::move (entry);
        }
    }

    void operator() (const ConfigEntry& new_entry) {
        if (!known_keys_.insert (new_entry.key).second) {
            throw std::runtime_error (
            "Database: config key seeded twice: " + new_entry.key);
        }
        seeded_[new_entry.key] = new_entry;
        auto it                = existing_.find (new_entry.key);
        if (it != existing_.end ()) {
            // Preserve the user's value but update metadata (description,
            // label, etc.)
            ConfigEntry updated = new_entry;
            updated.value       = it->second.value;     // Keep user's value
            updated.updated_at = it->second.updated_at; // Keep original timestamp
            replace_ (updated);
        } else {
            // New entry - use defaults
            replace_ (new_entry);
        }
    }

    // Refuses a `dependsOn` naming a key nothing seeded, a key in a different
    // category, or a key that is not itself boolean - the same way `operator()`
    // refuses a key seeded twice, and for the same reason: a dangling relation
    // would reach the app as a nesting instruction it cannot carry out. Called
    // once, after every category's seed function has run, so a dependent is
    // free to name a parent regardless of which file seeds first.
    void validate_dependencies () const {
        for (const auto& [key, entry] : seeded_) {
            if (!entry.depends_on) {
                continue;
            }
            const std::string& parent_key = *entry.depends_on;
            auto parent_it                = seeded_.find (parent_key);
            if (parent_it == seeded_.end ()) {
                throw std::runtime_error (std::format (
                "Database: config entry '{}' depends on unknown key '{}'", key, parent_key));
            }
            const ConfigEntry& parent = parent_it->second;
            if (parent.category != entry.category) {
                throw std::runtime_error (
                std::format ("Database: config entry '{}' depends on '{}', "
                             "which is not in the same category",
                key, parent_key));
            }
            if (parent.type != "boolean") {
                throw std::runtime_error (
                std::format ("Database: config entry '{}' depends on '{}', "
                             "which is not a boolean entry",
                key, parent_key));
            }
        }
    }

    private:
    std::unordered_map<std::string, ConfigEntry> existing_;
    std::unordered_map<std::string, ConfigEntry> seeded_;
    std::unordered_set<std::string>& known_keys_;
    std::function<void (const ConfigEntry&)> replace_;
};

// Metadata markers, wrapped around the entry they apply to so the flag is
// read at the top of the seed rather than counted out as a trailing
// positional `true` after `now`.
//
// restart_required: the running engine keeps the old value until restarted.
// The app shows one chip from this and the Dock a pending signal; nothing
// states it in the label or the description any more.
//
// advanced: an internal with no everyday user story. Rendered collapsed
// under "Advanced" at the bottom of its category, not removed - a knob that
// is still live is still reachable.
inline ConfigEntry restart_required (ConfigEntry entry) {
    entry.requires_restart = true;
    return entry;
}

inline ConfigEntry advanced (ConfigEntry entry) {
    entry.advanced = true;
    return entry;
}

// keywords: the words a user arrives with that this entry's key, label and
// description never say - "ram" for a cache size, "deadline" for a timeout.
// Not a place to repeat what the entry already carries: search already
// matches all three fields, and a keyword that duplicates one only lifts the
// entry above better matches. A guard test enforces that.
inline std::function<ConfigEntry (ConfigEntry)> keywords (
std::initializer_list<const char*> terms) {
    // Serialized here rather than inside the returned wrapper: an
    // initializer_list's backing array dies with the full-expression that
    // built it, so a wrapper that held on to it would be reading freed
    // storage the moment one is stored instead of called immediately.
    std::string json =
    nlohmann::json (std::vector<std::string> (terms.begin (), terms.end ())).dump ();
    return [json = std::move (json)] (ConfigEntry entry) {
        entry.keywords = json;
        return entry;
    };
}

// unit: what the value measures, for the entries that measure something. The
// app renders it as the input's suffix, which is the one place a unit
// belongs - so a description that also spells it out states it twice, and a
// guard test rejects the "in milliseconds" / "in bytes" clause for any entry
// that declares one. A count (workers, retained runs, stored steps) declares
// none: it measures nothing, and a suffix reading "items" is noise.
inline std::function<ConfigEntry (ConfigEntry)> unit (const char* symbol) {
    return [symbol = std::string (symbol)] (ConfigEntry entry) {
        entry.unit = symbol;
        return entry;
    };
}

// depends_on: this entry means nothing until the named boolean sibling in the
// same category is switched on ("Header name" without "Correlation Id" being
// true). The app nests the entry under its parent, indented and disabled
// until the parent reads true; `ConfigSeeder::validate_dependencies` refuses
// a key naming an absent, cross-category, or non-boolean parent.
inline std::function<ConfigEntry (ConfigEntry)> depends_on (const char* key) {
    return [key = std::string (key)] (ConfigEntry entry) {
        entry.depends_on = key;
        return entry;
    };
}

// One category, one file, one function - called in this order from
// `Database::seed_default_config` (`database.cpp`). Each seeds exactly the
// entries `docs/engine/db-schema.md`'s `config_entries.category` table lists
// for it.
void seed_general (ConfigSeeder& seed, int64_t now);
void seed_network (ConfigSeeder& seed, int64_t now);
void seed_services (ConfigSeeder& seed, int64_t now);
void seed_observability (ConfigSeeder& seed, int64_t now);
void seed_data_retention (ConfigSeeder& seed, int64_t now);
void seed_limits (ConfigSeeder& seed, int64_t now);
void seed_scripting (ConfigSeeder& seed, int64_t now);

} // namespace vayu::db::config_seeds
