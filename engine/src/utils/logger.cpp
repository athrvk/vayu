#include "vayu/utils/logger.hpp"

#include <chrono>
#include <ctime>
#include <iomanip>
#include <sstream>

#include "vayu/core/constants.hpp"

namespace vayu::utils {
Logger& Logger::instance() {
    static Logger logger;
    return logger;
}

void Logger::init(const std::string& log_dir) {
    std::lock_guard<std::mutex> lock(mutex_);
    log_dir_ = log_dir;
    ensure_log_directory();

    // Open log file with timestamp
    auto now = std::chrono::system_clock::now();
    auto time = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::localtime(&time), vayu::core::constants::logging::TIME_FORMAT);

    std::string log_file =
        log_dir_ + vayu::core::constants::logging::FILE_PREFIX + ss.str() + ".log";
    log_file_ = std::make_unique<std::ofstream>(log_file, std::ios::app);

    if (!log_file_ || !log_file_->is_open()) {
        std::cerr << "Failed to open log file: " << log_file << "\n";
    }
}

void Logger::log(Level level, const std::string& message) {
    std::lock_guard<std::mutex> lock(mutex_);

    std::string timestamp = get_timestamp();
    std::string level_str = level_to_string(level);

    std::string log_message = timestamp + " [" + level_str + "] " + message;

    // Always write to file
    if (log_file_ && log_file_->is_open()) {
        *log_file_ << log_message << "\n";
        log_file_->flush();
    } else {
        std::cerr << "Log file is not open." << "\n";
    }

    // Console output based on verbosity level:
    // Level 0: Only ERROR and WARNING
    // Level 1: ERROR, WARNING, INFO
    // Level 2: ERROR, WARNING, INFO, DEBUG
    bool should_print_to_console = false;

    if (level == Level::ERROR || level == Level::WARNING) {
        should_print_to_console = true;  // Always show errors and warnings
    } else if (level == Level::INFO && verbosity_level_ >= 1) {
        should_print_to_console = true;
    } else if (level == Level::DEBUG && verbosity_level_ >= 2) {
        should_print_to_console = true;
    }

    if (should_print_to_console) {
        if (level == Level::ERROR) {
            std::cerr << log_message << "\n";
        } else {
            std::cout << log_message << "\n";
        }
    }
}

void Logger::debug(const std::string& message) {
    log(Level::DEBUG, message);
}

void Logger::info(const std::string& message) {
    log(Level::INFO, message);
}

void Logger::warning(const std::string& message) {
    log(Level::WARNING, message);
}

void Logger::error(const std::string& message) {
    log(Level::ERROR, message);
}

Logger::~Logger() {
    if (log_file_ && log_file_->is_open()) {
        log_file_->close();
    }
}

std::string Logger::level_to_string(Level level) const {
    switch (level) {
        case Level::DEBUG:
            return "DEBUG";
        case Level::INFO:
            return "INFO";
        case Level::WARNING:
            return "WARNING";
        case Level::ERROR:
            return "ERROR";
        default:
            return "UNKNOWN";
    }
}

std::string Logger::get_timestamp() const {
    auto now = std::chrono::system_clock::now();
    auto time = std::chrono::system_clock::to_time_t(now);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()) % 1000;

    std::stringstream ss;
    ss << std::put_time(std::localtime(&time), "%Y-%m-%d %H:%M:%S");
    ss << '.' << std::setfill('0') << std::setw(3) << ms.count();

    return ss.str();
}

void Logger::ensure_log_directory() {
    std::filesystem::create_directories(log_dir_);
}

}  // namespace vayu::utils
