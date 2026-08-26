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

#include "vayu/core/constants.hpp"

// Windows headers define ERROR as a macro, undef it
#ifdef _WIN32
#ifdef ERROR
#undef ERROR
#endif
#endif

namespace vayu::utils {
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

    void init (const std::string& log_dir = vayu::core::constants::logging::DIR);
    void log (Level level, const std::string& message);

    // The file sink's own floor, separate from `verbosity_level_`, which is
    // what `-v` buys the console. The file used to take everything at DEBUG
    // unconditionally; `logLevel` is what moves that floor, and it is applied
    // once the database is open - so the handful of lines startup writes before
    // that always land.
    void set_file_level (Level level);
    // Size one log file may reach before it is rotated once to `<name>.1`;
    // 0 means unlimited. Config entry `maxLogFileBytes`.
    void set_max_file_bytes (int64_t bytes);
    void debug (const std::string& message);
    void info (const std::string& message);
    void warning (const std::string& message);
    void error (const std::string& message);

    void set_verbosity (int level) {
        verbosity_level_ = level;
    }
    int get_verbosity () const {
        return verbosity_level_;
    }

    // Force flush log file
    void flush ();

    // Legacy support
    void set_verbose (bool verbose) {
        verbosity_level_ = verbose ? 1 : 0;
    }
    bool is_verbose () const {
        return verbosity_level_ > 0;
    }

    private:
    Logger () = default;
    ~Logger ();

    std::string level_to_string (Level level) const;
    std::string get_timestamp () const;
    std::string get_thread_id () const;
    void ensure_log_directory ();
    // Rotate the open file to `<path>.1` and continue in a fresh one. Called
    // with `mutex_` held, from `log` only.
    void rotate_locked ();

    std::unique_ptr<std::ofstream> log_file_;
    std::mutex mutex_;
    int verbosity_level_ = 0; // 0=warn/error, 1=info+, 2=debug+
    std::string log_dir_;
    std::string log_file_path_;
    Level file_level_       = Level::DEBUG;
    int64_t max_file_bytes_ = 0; // 0 = unlimited
    // Bytes in the open file, seeded from its size because it is opened for
    // append: a restart inside the same clock second reopens the file the
    // previous start wrote, and the cap is on the file, not on this process.
    int64_t file_bytes_ = 0;
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
 * @brief Delete `vayu_*.log` files in @p log_dir beyond the newest @p keep.
 * @return How many files were deleted.
 *
 * Newest is decided by filename, not by modification time: the names embed
 * `%Y%m%d_%H%M%S`, so they sort chronologically, and a copied or touched
 * directory keeps sorting the way the log timestamps read. A file's `.1`
 * rotation goes with it, so a pruned generation leaves nothing behind, and
 * anything not named `vayu_<stamp>.log` is never a candidate.
 */
std::size_t prune_old_logs (const std::string& log_dir, std::size_t keep);

// Convenience functions
inline void log_debug (const std::string& msg) {
    Logger::instance ().debug (msg);
}

inline void log_info (const std::string& msg) {
    Logger::instance ().info (msg);
}

inline void log_warning (const std::string& msg) {
    Logger::instance ().warning (msg);
}

inline void log_error (const std::string& msg) {
    Logger::instance ().error (msg);
}

} // namespace vayu::utils
