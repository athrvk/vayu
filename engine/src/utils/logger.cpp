/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <system_error>
#include <thread>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/utils/reentrant.hpp"

namespace vayu::utils {
Logger& Logger::instance () {
    static Logger logger;
    return logger;
}

void Logger::init (const std::string& log_dir) {
    std::lock_guard<std::mutex> lock (mutex_);
    log_dir_ = log_dir;
    ensure_log_directory ();

    // Open log file with timestamp
    auto now  = std::chrono::system_clock::now ();
    auto time = std::chrono::system_clock::to_time_t (now);

    log_file_path_ = log_dir_ + vayu::core::constants::logging::FILE_PREFIX +
    format_local_time (time, vayu::core::constants::logging::TIME_FORMAT) + ".log";
    log_file_ = std::make_unique<std::ofstream> (log_file_path_, std::ios::app);

    if (!log_file_ || !log_file_->is_open ()) {
        std::cerr << "Failed to open log file: " << log_file_path_ << "\n";
    }

    std::error_code ec;
    const auto existing = std::filesystem::file_size (log_file_path_, ec);
    file_bytes_         = ec ? 0 : static_cast<int64_t> (existing);

    // Retention runs after the new file exists, so it is one of the N kept -
    // pruning first would keep N old files plus this one, which is N+1 on
    // disk for every value of N.
    prune_old_logs (log_dir_,
    static_cast<std::size_t> (vayu::core::constants::logging::RETAINED_FILES));
}

void Logger::set_file_level (Level level) {
    std::lock_guard<std::mutex> lock (mutex_);
    file_level_ = level;
}

void Logger::set_max_file_bytes (int64_t bytes) {
    std::lock_guard<std::mutex> lock (mutex_);
    max_file_bytes_ = bytes > 0 ? bytes : 0;
}

void Logger::rotate_locked () {
    log_file_->close ();

    // One rotation generation, overwriting whatever `.1` held: the file name
    // already carries the process start, so history is the per-start files
    // retention bounds - a `.2`, `.3` chain would be a second, unbounded
    // history under a naming scheme that does not need one.
    const std::string rotated = log_file_path_ + ".1";
    std::error_code ec;
    std::filesystem::rename (log_file_path_, rotated, ec);
    if (ec) {
        std::cerr << "Failed to rotate log file: " << ec.message () << "\n";
    }

    log_file_ = std::make_unique<std::ofstream> (log_file_path_, std::ios::trunc);
    file_bytes_ = 0;
    if (!log_file_->is_open ()) {
        std::cerr << "Failed to reopen log file after rotation: " << log_file_path_ << "\n";
    }
}

void Logger::log (Level level, const std::string& message) {
    std::lock_guard<std::mutex> lock (mutex_);

    std::string timestamp = get_timestamp ();
    std::string level_str = level_to_string (level);
    std::string thread_id = get_thread_id ();

    std::string log_message =
    timestamp + " [" + level_str + "] [" + thread_id + "] " + message;

    // The file takes everything at or above `logLevel`, which defaults to
    // DEBUG - the level the file used to take unconditionally.
    if (level >= file_level_) {
        if (log_file_ && log_file_->is_open ()) {
            const auto line_bytes = static_cast<int64_t> (log_message.size ()) + 1;
            // Rotate *before* the line that would cross the cap rather than
            // after, so the cap bounds the file rather than being the point it
            // is already past.
            if (max_file_bytes_ > 0 && file_bytes_ > 0 &&
            file_bytes_ + line_bytes > max_file_bytes_) {
                rotate_locked ();
            }
            *log_file_ << log_message << "\n";
            log_file_->flush ();
            file_bytes_ += line_bytes;
        } else {
            std::cerr << "Log file is not open." << "\n";
        }
    }

    // Console output based on verbosity level:
    // Level 0: Only ERROR and WARNING
    // Level 1: ERROR, WARNING, INFO
    // Level 2: ERROR, WARNING, INFO, DEBUG
    // Errors and warnings are unconditional; the other two are what verbosity
    // buys. One expression rather than a chain of branches that all assigned
    // the same `true`, which said nothing about which condition earned it.
    const bool should_print_to_console = level == Level::ERROR ||
    level == Level::WARNING || (level == Level::INFO && verbosity_level_ >= 1) ||
    (level == Level::DEBUG && verbosity_level_ >= 2);

    if (should_print_to_console) {
        if (level == Level::ERROR) {
            std::cerr << log_message << "\n";
            std::cerr.flush (); // Flush immediately on Linux when stdout/stderr are pipes
        } else {
            std::cout << log_message << "\n";
            std::cout.flush (); // Flush immediately on Linux when stdout/stderr are pipes
        }
    }
}

void Logger::debug (const std::string& message) {
    log (Level::DEBUG, message);
}

void Logger::info (const std::string& message) {
    log (Level::INFO, message);
}

void Logger::warning (const std::string& message) {
    log (Level::WARNING, message);
}

void Logger::error (const std::string& message) {
    log (Level::ERROR, message);
}

void Logger::flush () {
    std::lock_guard<std::mutex> lock (mutex_);
    if (log_file_ && log_file_->is_open ()) {
        log_file_->flush ();
    }
    std::cout.flush ();
    std::cerr.flush ();
}

Logger::~Logger () {
    if (log_file_ && log_file_->is_open ()) {
        log_file_->close ();
    }
}

std::string Logger::level_to_string (Level level) const {
    switch (level) {
    case Level::DEBUG: return "DEBUG";
    case Level::INFO: return "INFO";
    case Level::WARNING: return "WARNING";
    case Level::ERROR: return "ERROR";
    default: return "UNKNOWN";
    }
}

std::string Logger::get_timestamp () const {
    auto now  = std::chrono::system_clock::now ();
    auto time = std::chrono::system_clock::to_time_t (now);
    auto ms =
    std::chrono::duration_cast<std::chrono::milliseconds> (now.time_since_epoch ()) % 1000;

    std::stringstream ss;
    ss << format_local_time (time, "%Y-%m-%d %H:%M:%S");
    ss << '.' << std::setfill ('0') << std::setw (3) << ms.count ();

    return ss.str ();
}

std::string Logger::get_thread_id () const {
    std::stringstream ss;
    ss << std::this_thread::get_id ();
    return "T:" + ss.str ();
}

void Logger::ensure_log_directory () {
    std::filesystem::create_directories (log_dir_);
}

std::optional<Logger::Level> parse_log_level (std::string_view name) {
    std::string lowered (name);
    std::transform (lowered.begin (), lowered.end (), lowered.begin (),
    [] (unsigned char ch) { return static_cast<char> (std::tolower (ch)); });

    if (lowered == "debug")
        return Logger::Level::DEBUG;
    if (lowered == "info")
        return Logger::Level::INFO;
    if (lowered == "warn" || lowered == "warning")
        return Logger::Level::WARNING;
    if (lowered == "error")
        return Logger::Level::ERROR;
    return std::nullopt;
}

std::size_t prune_old_logs (const std::string& log_dir, std::size_t keep) {
    namespace fs = std::filesystem;

    // FILE_PREFIX leads with the separator it is concatenated onto a
    // directory with; a filename does not carry it.
    constexpr std::string_view PREFIX =
    std::string_view (vayu::core::constants::logging::FILE_PREFIX).substr (1);
    constexpr std::string_view SUFFIX = ".log";

    std::error_code ec;
    std::vector<fs::path> candidates;
    for (const auto& entry : fs::directory_iterator (log_dir, ec)) {
        if (!entry.is_regular_file ())
            continue;
        const std::string name = entry.path ().filename ().string ();
        if (name.size () > PREFIX.size () + SUFFIX.size () &&
        name.starts_with (PREFIX) && name.ends_with (SUFFIX)) {
            candidates.push_back (entry.path ());
        }
    }
    if (ec || candidates.size () <= keep) {
        return 0;
    }

    std::sort (candidates.begin (), candidates.end ());

    std::size_t deleted = 0;
    for (std::size_t i = 0; i + keep < candidates.size (); ++i) {
        std::error_code remove_ec;
        if (fs::remove (candidates[i], remove_ec)) {
            ++deleted;
        }
        // The generation's rotated half, if it has one. Removed with its
        // parent so a `.1` cannot outlive the file it rotated out of and sit
        // in the directory forever, which is the growth this prune exists to
        // stop.
        fs::remove (candidates[i].string () + ".1", remove_ec);
    }
    return deleted;
}

} // namespace vayu::utils
