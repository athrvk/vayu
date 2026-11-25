/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#pragma once

/// What every category file under `config_seeds/` shares (#1611): what
/// `Database::seed_default_config` factored out, so a category file needs only
/// this include and `vayu/types.hpp`'s `ConfigEntry`. `ConfigSeeder` below says
/// how it reaches `Database`'s private storage without exposing
/// `Database::Impl` (#1614's split).

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

// Retired settings: keys nothing reads. `seed_default_config` deletes a row an
// older version left, so the Settings UI (which renders engine entries from
// GET /config) stops offering a dead knob.
//
//   requestBatchSize - drove the removed batched request iteration.
//   contextPoolSize  - promised "pre-initialized JS contexts", but the
//                      script context pool grows lazily and never read a
//                      bound (#112): setting it 1..256 changed nothing.
//
// The 2026-08 sweep (#519) retired eleven more, each after a search for a
// reader; where the constant behind a key had its own callers, only the knob
// went.
//
//   maxConnections       - no reader; the server enforces no global limit.
//   tcpKeepAliveIdle     - curl_utils sets both CURL keep-alive options from
//   tcpKeepAliveInterval   constants and never consults the config.
//   statsInterval        - superseded by liveTickIntervalMs, same default
//                          and purpose, the one that is read.
//   maxJsonFieldSize     - json.cpp caps stored fields at the constant, so
//                          the description's "increase only if..." escape
//                          hatch did not exist.
//   sseConnectTimeout    - the dashboard's reconnect logic is renderer-side
//   sseMaxRetry            and never asked the engine; the sse::* constants
//   sseSendLastEventId     existed only to seed them.
//   dbTempStore          - PRAGMAs the open callback applies from constants.
//   dbMmapSize             Wiring them buys nothing: the defaults are the
//   dbWalAutocheckpoint    measured optimum (docs/engine/benchmarks.md) and
//                          none has a user story. dbCacheSize, which does, is
//                          wired instead.
inline constexpr std::array<const char*, 13> kRetiredConfigKeys = {
    "requestBatchSize", "contextPoolSize", "maxConnections", "tcpKeepAliveIdle",
    "tcpKeepAliveInterval", "statsInterval", "maxJsonFieldSize", "sseConnectTimeout",
    "sseMaxRetry", "sseSendLastEventId", "dbTempStore", "dbMmapSize", "dbWalAutocheckpoint"
};

/// Tag for `ConfigSeeder::operator() (entry, adopt_new_default)`.
struct AdoptNewDefault {};
inline constexpr AdoptNewDefault adopt_new_default{};

/**
 * What `Database::seed_default_config` does around the seven per-category
 * calls: delete the retired-key rows, index the rows a reseed must preserve,
 * and, through `operator()`, upsert one entry, keeping a user's existing value
 * and refusing a key seeded twice across the seven files.
 *
 * One function read top to bottom made a duplicate key impossible by
 * inspection; across seven files it is not, so `operator()` throws
 * `std::runtime_error` naming the key when a second category seeds it, failing
 * startup loudly rather than letting the second write win. `known_keys` is
 * cleared on construction, so a start never flags a key the *previous* pass
 * seeded.
 *
 * Reaches `Database`'s private storage through two type-erased callbacks rather
 * than exposing `Database::Impl` (#1614's split): seeding touches no stored row
 * outside this pass, so it needs only to write and delete one row, not the
 * storage type.
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

    /// Seeds one entry. A stored value is always the user's and is kept, even
    /// when this build changes the entry's default.
    void operator() (const ConfigEntry& new_entry) {
        seed_entry (new_entry, false);
    }

    /// As above, but a stored value equal to the *stored* default (the user
    /// never moved off what the previous build shipped) follows this build's
    /// new default once (#2419). Opt-in per entry: a machine-dependent default
    /// (`workers`) differs between machines with no build changing it, and a
    /// row travelling with a workspace file must not be rewritten by the move.
    /// The row records the new default as it adopts it, so the next start sees
    /// value == default and writes nothing.
    void operator() (const ConfigEntry& new_entry, AdoptNewDefault) {
        seed_entry (new_entry, true);
    }

    // Refuses a `dependsOn` naming a key nothing seeded, one in another
    // category, or one that is not boolean, as `operator()` refuses a double
    // seed and for its reason: a dangling relation reaches the app as a nesting
    // instruction it cannot carry out. Called once, after every category has
    // seeded, so a dependent may name a parent whichever file seeds first.
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
    void seed_entry (const ConfigEntry& new_entry, bool follow_new_default) {
        if (!known_keys_.insert (new_entry.key).second) {
            throw std::runtime_error (
            "Database: config key seeded twice: " + new_entry.key);
        }
        seeded_[new_entry.key] = new_entry;
        auto it                = existing_.find (new_entry.key);
        if (it == existing_.end ()) {
            // New entry - use defaults
            replace_ (new_entry);
            return;
        }
        // Preserve the user's value but update metadata (description,
        // label, etc.)
        ConfigEntry updated = new_entry;
        updated.value       = it->second.value;      // Keep user's value
        updated.updated_at  = it->second.updated_at; // Keep original timestamp
        const bool default_moved = it->second.default_value != new_entry.default_value;
        if (follow_new_default && default_moved &&
        it->second.value == it->second.default_value) {
            updated.value      = new_entry.default_value;
            updated.updated_at = new_entry.updated_at;
        }
        // Only an entry whose metadata changed is written: every start reseeds,
        // and rewriting all ~65 rows made each a database write before the
        // engine listened, for a catalogue that changes only with an engine
        // upgrade.
        if (updated != it->second) {
            replace_ (updated);
        }
    }

    std::unordered_map<std::string, ConfigEntry> existing_;
    std::unordered_map<std::string, ConfigEntry> seeded_;
    std::unordered_set<std::string>& known_keys_;
    std::function<void (const ConfigEntry&)> replace_;
};

// Metadata markers, wrapped around their entry so the flag is read at the top
// of the seed, not counted out as a trailing positional `true` after `now`.
//
// restart_required: the running engine keeps the old value until restarted. The
// app shows a chip and the Dock a pending signal; neither the label nor the
// description states it.
//
// advanced: an internal with no everyday user story, rendered collapsed under
// "Advanced" at the bottom of its category, not removed: a live knob stays
// reachable.
inline ConfigEntry restart_required (ConfigEntry entry) {
    entry.requires_restart = true;
    return entry;
}

inline ConfigEntry advanced (ConfigEntry entry) {
    entry.advanced = true;
    return entry;
}

// keywords: words a user arrives with that the key, label and description never
// say ("ram" for a cache size, "deadline" for a timeout). Search already
// matches those three fields, so a keyword repeating one only lifts the entry
// above better matches; a guard test enforces that.
inline std::function<ConfigEntry (ConfigEntry)> keywords (
std::initializer_list<const char*> terms) {
    // Serialized here, not in the returned wrapper: an initializer_list's
    // backing array dies with the full-expression that built it, so a wrapper
    // holding it would read freed storage once stored rather than called at
    // once.
    std::string json =
    nlohmann::json (std::vector<std::string> (terms.begin (), terms.end ())).dump ();
    return [json = std::move (json)] (ConfigEntry entry) {
        entry.keywords = json;
        return entry;
    };
}

// unit: what the value measures, for entries that measure something. The app
// renders it as the input's suffix, its one place, so a description spelling it
// out says it twice; a guard test rejects an "in milliseconds" / "in bytes"
// clause for an entry declaring one. A count (workers, retained runs, stored
// steps) declares none: a suffix reading "items" is noise.
inline std::function<ConfigEntry (ConfigEntry)> unit (const char* symbol) {
    return [symbol = std::string (symbol)] (ConfigEntry entry) {
        entry.unit = symbol;
        return entry;
    };
}

// depends_on: the entry means nothing until the named boolean sibling in its
// category is on ("Header name" without "Correlation ID"). The app nests it
// under its parent, indented and disabled until the parent reads true;
// `ConfigSeeder::validate_dependencies` refuses an absent, cross-category or
// non-boolean parent.
inline std::function<ConfigEntry (ConfigEntry)> depends_on (const char* key) {
    return [key = std::string (key)] (ConfigEntry entry) {
        entry.depends_on = key;
        return entry;
    };
}

// One category, one file, one function, called in this order from
// `Database::seed_default_config` (`database.cpp`); each seeds exactly the
// entries `docs/engine/db-schema/config.md`'s `config_entries.category` table
// lists for it.
void seed_general (ConfigSeeder& seed, int64_t now);
void seed_network (ConfigSeeder& seed, int64_t now);
void seed_services (ConfigSeeder& seed, int64_t now);
void seed_observability (ConfigSeeder& seed, int64_t now);
void seed_data_retention (ConfigSeeder& seed, int64_t now);
void seed_limits (ConfigSeeder& seed, int64_t now);
void seed_scripting (ConfigSeeder& seed, int64_t now);

} // namespace vayu::db::config_seeds
