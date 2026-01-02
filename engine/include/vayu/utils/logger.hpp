#pragma once

#include "vayu/core/constants.hpp"
#include <string>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <filesystem>

namespace vayu::utils
{
    class Logger
    {
    public:
        enum class Level
        {
            DEBUG = 0,
            INFO = 1,
            WARNING = 2,
            ERROR = 3
        };

        static Logger &instance();

        void init(const std::string &log_dir = vayu::core::constants::logging::DIR);
        void log(Level level, const std::string &message);
        void debug(const std::string &message);
        void info(const std::string &message);
        void warning(const std::string &message);
        void error(const std::string &message);

        void set_verbose(bool verbose) { verbose_ = verbose; }
        bool is_verbose() const { return verbose_; }

    private:
        Logger() = default;
        ~Logger();

        std::string level_to_string(Level level) const;
        std::string get_timestamp() const;
        void ensure_log_directory();

        std::unique_ptr<std::ofstream> log_file_;
        std::mutex mutex_;
        bool verbose_ = false;
        std::string log_dir_;
    };

    // Convenience functions
    inline void log_debug(const std::string &msg)
    {
        Logger::instance().debug(msg);
    }

    inline void log_info(const std::string &msg)
    {
        Logger::instance().info(msg);
    }

    inline void log_warning(const std::string &msg)
    {
        Logger::instance().warning(msg);
    }

    inline void log_error(const std::string &msg)
    {
        Logger::instance().error(msg);
    }

} // namespace vayu::utils
