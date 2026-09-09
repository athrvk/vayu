/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <system_error>
#include <thread>
#include <vector>

#include "vayu/core/constants.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/ascii_case.hpp"
#include "vayu/utils/log_redact.hpp"
#include "vayu/utils/reentrant.hpp"

namespace vayu::utils {
Logger& Logger::instance () {
    static Logger logger;
    return logger;
}

std::string Logger::file_prefix () const {
    return source_ == "cli" ? vayu::core::constants::logging::CLI_FILE_PREFIX :
                              vayu::core::constants::logging::ENGINE_FILE_PREFIX;
}

void Logger::init (const std::string& log_dir, std::string_view source) {
    std::lock_guard<std::mutex> lock (mutex_);
    log_dir_ = log_dir;
    source_  = source == "cli" ? "cli" : "engine";
    ensure_log_directory ();

    // Open log file with timestamp
    auto now  = std::chrono::system_clock::now ();
    auto time = std::chrono::system_clock::to_time_t (now);

    log_file_path_ = log_dir_ + "/" + file_prefix () +
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
    prune_old_logs (log_dir_, file_prefix (),
    static_cast<std::size_t> (vayu::core::constants::logging::RETAINED_FILES));

    // The pre-#1557 generation is never one of the N kept above - it has its
    // own prefix, so `prune_old_logs` never sees it - and nothing else in the
    // engine mentions it, so an install that predates the split would carry
    // it forever otherwise.
    remove_legacy_log_files (log_dir_, vayu::core::constants::logging::LEGACY_FILE_PREFIX);
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

namespace {

std::string format_ts (std::chrono::system_clock::time_point now) {
    const auto time = std::chrono::system_clock::to_time_t (now);
    const auto ms =
    std::chrono::duration_cast<std::chrono::milliseconds> (now.time_since_epoch ()) % 1000;
    std::ostringstream ts_stream;
    ts_stream << format_utc_time (time, "%Y-%m-%dT%H:%M:%S") << '.'
              << std::setfill ('0') << std::setw (3) << ms.count () << 'Z';
    return ts_stream.str ();
}

// Console verbosity buys INFO and DEBUG; ERROR and WARNING are unconditional
// so a quiet run still sees an engine failure. One expression rather than a
// chain of branches that all assigned the same `true`, which said nothing
// about which condition earned it.
bool should_print_to_console (Logger::Level level, int verbosity) {
    using Level = Logger::Level;
    return level == Level::ERROR || level == Level::WARNING ||
    (level == Level::INFO && verbosity >= 1) ||
    (level == Level::DEBUG && verbosity >= 2);
}

} // namespace

void Logger::write_to_file_locked (const LogRecord& record,
const std::string& ts,
const std::string& thread_id,
int pid) {
    if (!log_file_ || !log_file_->is_open ()) {
        std::cerr << "Log file is not open." << "\n";
        return;
    }
    nlohmann::json line;
    line["ts"]    = ts;
    line["level"] = level_wire_name (record.level);
    line["src"]   = source_;
    line["cat"]   = std::string (record.cat);
    line["msg"]   = record.msg;
    line["pid"]   = pid;
    line["tid"]   = thread_id;
    if (record.fields.is_object ()) {
        line.update (record.fields);
    }
    const std::string log_message = line.dump ();

    const auto line_bytes = static_cast<int64_t> (log_message.size ()) + 1;
    // Rotate *before* the line that would cross the cap rather than after, so
    // the cap bounds the file rather than being the point it is already past.
    if (max_file_bytes_ > 0 && file_bytes_ > 0 && file_bytes_ + line_bytes > max_file_bytes_) {
        rotate_locked ();
    }
    *log_file_ << log_message << "\n";
    log_file_->flush ();
    file_bytes_ += line_bytes;
}

void Logger::write_to_console_locked (const LogRecord& record, const std::string& ts) {
    std::ostringstream console_line;
    // "HH:MM:SS.mmm LEVEL cat      msg k=v ..." - the same shape on every
    // console, engine or (once #1558 lands) app.
    console_line << ts.substr (11, 12) << ' ' << std::left << std::setw (7)
                 << level_console_name (record.level) << std::setw (9)
                 << std::string (record.cat) << record.msg;
    if (record.fields.is_object ()) {
        for (const auto& [key, value] : record.fields.items ()) {
            console_line
            << ' ' << key << '='
            << (value.is_string () ? value.get<std::string> () : value.dump ());
        }
    }
    const std::string console_text = console_line.str ();

    if (record.level == Level::ERROR) {
        std::cerr << console_text << "\n";
        std::cerr.flush (); // Flush immediately on Linux when stdout/stderr are pipes
    } else {
        std::cout << console_text << "\n";
        std::cout.flush (); // Flush immediately on Linux when stdout/stderr are pipes
    }
}

void Logger::write (LogRecord&& record) {
    std::lock_guard<std::mutex> lock (mutex_);

    redact_fields (record.fields);

    const std::string ts        = format_ts (std::chrono::system_clock::now ());
    const std::string thread_id = get_thread_id ();
    const int pid               = vayu::platform::get_process_id ();

    // The file takes everything at or above `logLevel`, which defaults to
    // DEBUG - the level the file used to take unconditionally.
    if (record.level >= file_level_) {
        write_to_file_locked (record, ts, thread_id, pid);
    }
    if (should_print_to_console (record.level, verbosity_level_)) {
        write_to_console_locked (record, ts);
    }
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
    try {
        if (log_file_ && log_file_->is_open ()) {
            log_file_->close ();
        }
    } catch (...) {
        // @deliberate `close` sets `failbit` on a flush failure, and throws it
        // where the stream carries `exceptions()` - out of a destructor, which
        // terminates. A full disk or a yanked volume at shutdown is the shape
        // of it, and there is nothing to recover: the process is going away and
        // the bytes are already lost. It is not logged either, because the
        // logger is what is being destroyed - reporting through it here is the
        // circular path, and any other channel would outlive its own subject.
    }
}

std::string Logger::level_console_name (Level level) const {
    switch (level) {
    case Level::DEBUG: return "DEBUG";
    case Level::INFO: return "INFO";
    case Level::WARNING: return "WARNING";
    case Level::ERROR: return "ERROR";
    default: return "UNKNOWN";
    }
}

std::string_view Logger::level_wire_name (Level level) const {
    switch (level) {
    case Level::DEBUG: return "debug";
    case Level::INFO: return "info";
    case Level::WARNING: return "warn";
    case Level::ERROR: return "error";
    default: return "unknown";
    }
}

std::string Logger::get_thread_id () const {
    std::stringstream ss;
    ss << std::this_thread::get_id ();
    return ss.str ();
}

void Logger::ensure_log_directory () {
    std::filesystem::create_directories (log_dir_);
}

std::optional<Logger::Level> parse_log_level (std::string_view name) {
    std::string lowered = ascii_lower (name);

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

std::size_t
prune_old_logs (const std::string& log_dir, std::string_view file_prefix, std::size_t keep) {
    namespace fs = std::filesystem;

    constexpr std::string_view SUFFIX = ".log";

    std::error_code ec;
    std::vector<fs::path> candidates;
    for (const auto& entry : fs::directory_iterator (log_dir, ec)) {
        if (!entry.is_regular_file ())
            continue;
        const std::string name = entry.path ().filename ().string ();
        if (name.size () > file_prefix.size () + SUFFIX.size () &&
        name.starts_with (file_prefix) && name.ends_with (SUFFIX)) {
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

std::size_t remove_legacy_log_files (const std::string& log_dir, std::string_view legacy_prefix) {
    namespace fs = std::filesystem;

    constexpr std::string_view SUFFIX = ".log";

    std::error_code ec;
    std::vector<fs::path> victims;
    for (const auto& entry : fs::directory_iterator (log_dir, ec)) {
        if (!entry.is_regular_file ())
            continue;
        const std::string name = entry.path ().filename ().string ();
        if (name.starts_with (legacy_prefix) && name.ends_with (SUFFIX)) {
            victims.push_back (entry.path ());
        }
    }
    if (ec) {
        return 0;
    }

    std::size_t deleted = 0;
    for (const auto& victim : victims) {
        std::error_code remove_ec;
        if (fs::remove (victim, remove_ec)) {
            ++deleted;
        }
        fs::remove (victim.string () + ".1", remove_ec);
    }
    return deleted;
}

} // namespace vayu::utils
