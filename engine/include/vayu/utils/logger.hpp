#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>

#include <nlohmann/json.hpp>

#include "vayu/core/constants.hpp"

// Windows headers define ERROR as a macro, undef it
#ifdef _WIN32
#ifdef ERROR
#undef ERROR
#endif
#endif

namespace vayu::utils {

struct LogRecord;

class Logger {
    public:
    enum class Level : std::uint8_t {
        DEBUG   = 0,
        INFO    = 1,
        WARNING = 2,
        ERROR   = 3
    };

    static Logger& instance ();

    // Public although the constructor and destructor below are not: a deleted
    // member that is also private reports as inaccessible rather than as
    // deleted, which says nothing about why (`modernize-use-equals-delete`).
    // The singleton is enforced by the private constructor; these say that even
    // `instance()`'s reference cannot be copied out of it.
    Logger (const Logger&)            = delete;
    Logger& operator= (const Logger&) = delete;
    Logger (Logger&&)                 = delete;
    Logger& operator= (Logger&&)      = delete;

    /// @p source is `"engine"` or `"cli"` (issue #1557): both the value every
    /// record's `src` field carries and the file name prefix
    /// (`engine_<stamp>.log` / `cli_<stamp>.log`), so the two binaries' files
    /// sort apart under one directory without a second `logDir` to configure.
    void init (const std::string& log_dir, std::string_view source = "engine");

    // The file sink's own floor, separate from `verbosity_level_`, which is
    // what `-v` buys the console. The file used to take everything at DEBUG
    // unconditionally; `logLevel` is what moves that floor, and it is applied
    // once the database is open - so the handful of lines startup writes before
    // that always land.
    void set_file_level (Level level);
    // Size one log file may reach before it is rotated once to `<name>.1`;
    // 0 means unlimited. Config entry `maxLogFileBytes`.
    void set_max_file_bytes (int64_t bytes);

    void set_verbosity (int level) {
        verbosity_level_ = level;
    }
    int get_verbosity () const {
        return verbosity_level_;
    }

    // Force flush log file
    void flush ();

    /// @brief The one entry point (issue #1557).
    ///
    /// Every `log_debug`/`log_info`/`log_warning`/`log_error` call below
    /// builds a `LogRecord` and calls this. Adds `ts` (UTC), `pid`, `tid` and
    /// `src`, redacts `record.fields` in place (`utils/log_redact.hpp`), then
    /// renders the result to whichever sink is enabled for the level: a JSON
    /// line to the file, one text line to the console.
    void write (LogRecord&& record);

    private:
    Logger () = default;
    ~Logger ();

    std::string level_console_name (Level level) const;
    std::string_view level_wire_name (Level level) const;
    std::string get_thread_id () const;
    void ensure_log_directory ();
    // Rotate the open file to `<path>.1` and continue in a fresh one. Called
    // with `mutex_` held, from `write_to_file_locked` only.
    void rotate_locked ();
    // The prefix `write` opened the current file with (`engine_` or `cli_`),
    // for `rotate_locked` and for the retention sweep in `init`.
    std::string file_prefix () const;
    // The two sinks `write` renders @p record to, split out to keep `write`
    // itself a dispatch rather than both bodies at once. Both require
    // `mutex_` held, and both read a `ts` `write` computed once for the pair.
    void write_to_file_locked (const LogRecord& record,
    const std::string& ts,
    const std::string& thread_id,
    int pid);
    void write_to_console_locked (const LogRecord& record, const std::string& ts);

    std::unique_ptr<std::ofstream> log_file_;
    std::mutex mutex_;
    int verbosity_level_ = 0; // 0=warn/error, 1=info+, 2=debug+
    std::string log_dir_;
    std::string log_file_path_;
    std::string source_     = "engine";
    Level file_level_       = Level::DEBUG;
    int64_t max_file_bytes_ = 0; // 0 = unlimited
    // Bytes in the open file, seeded from its size because it is opened for
    // append: a restart inside the same clock second reopens the file the
    // previous start wrote, and the cap is on the file, not on this process.
    int64_t file_bytes_ = 0;
};

/**
 * @brief One log call's whole payload (issue #1557).
 *
 * `cat` is a `string_view` because every call site passes a string literal
 * from its source-scanned category list (`tests/log_category_scan_test.cpp`);
 * `fields` defaults to an empty object rather than nlohmann's default `null`,
 * so `Logger::write` can merge it into a record unconditionally.
 */
struct LogRecord {
    Logger::Level level;
    std::string_view cat;
    std::string msg;
    nlohmann::json fields = nlohmann::json::object ();
};

/**
 * @brief The level named by @p name (`debug`, `info`, `warn`, `error`).
 * @return `std::nullopt` for anything else, so a bad config value is a
 *         reportable failure rather than a silent fallback.
 *
 * Case-insensitive; `warning` is accepted alongside `warn` because that is what
 * the level prints as.
 */
std::optional<Logger::Level> parse_log_level (std::string_view name);

/**
 * @brief Delete files matching `<file_prefix><stamp>.log` in @p log_dir beyond
 *        the newest @p keep.
 * @param file_prefix The filename prefix to match - `"engine_"` or `"cli_"` -
 *        never a full path. Each source's files are pruned as their own
 *        generation, so a busy CLI cannot evict the daemon's history or the
 *        other way around.
 * @return How many files were deleted.
 *
 * Newest is decided by filename, not by modification time: the names embed
 * `%Y%m%d_%H%M%S`, so they sort chronologically, and a copied or touched
 * directory keeps sorting the way the log timestamps read. A file's `.1`
 * rotation goes with it, so a pruned generation leaves nothing behind.
 */
std::size_t
prune_old_logs (const std::string& log_dir, std::string_view file_prefix, std::size_t keep);

/**
 * @brief Delete every `<legacy_prefix>*.log` file (and its `.1` rotation) in
 *        @p log_dir - the pre-#1557 naming, before the per-source `engine_`/
 *        `cli_` split.
 * @return How many files were deleted.
 *
 * Unlike `prune_old_logs`, this keeps none: the legacy generation is not a
 * history to retain a tail of, it is dead weight from before the split, and
 * every start pays the one directory scan to clear whatever a not-yet-upgraded
 * install left behind.
 */
std::size_t remove_legacy_log_files (const std::string& log_dir, std::string_view legacy_prefix);

// Convenience functions - the only way to log (issue #1557): `Logger::write`
// is the one entry point these all route through, so a category is never
// optional and a bad-value redaction path is not something a call site can
// route around.
inline void log_debug (std::string_view cat,
std::string msg,
nlohmann::json fields = nlohmann::json::object ()) {
    Logger::instance ().write (
    LogRecord{ Logger::Level::DEBUG, cat, std::move (msg), std::move (fields) });
}

inline void log_info (std::string_view cat,
std::string msg,
nlohmann::json fields = nlohmann::json::object ()) {
    Logger::instance ().write (
    LogRecord{ Logger::Level::INFO, cat, std::move (msg), std::move (fields) });
}

inline void log_warning (std::string_view cat,
std::string msg,
nlohmann::json fields = nlohmann::json::object ()) {
    Logger::instance ().write (
    LogRecord{ Logger::Level::WARNING, cat, std::move (msg), std::move (fields) });
}

inline void log_error (std::string_view cat,
std::string msg,
nlohmann::json fields = nlohmann::json::object ()) {
    Logger::instance ().write (
    LogRecord{ Logger::Level::ERROR, cat, std::move (msg), std::move (fields) });
}

} // namespace vayu::utils
