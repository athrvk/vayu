/**
 * @file daemon.cpp
 * @brief Vayu Engine daemon entry point
 *
 * This is the background process that handles high-concurrency requests.
 * It exposes a Control API for the Electron app to communicate with.
 */

#include "vayu/http/server.hpp"
#include "vayu/http/client.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/constants.hpp"
#include "vayu/db/database.hpp"
#include "vayu/version.hpp"
#include "vayu/utils/logger.hpp"

#include <atomic>
#include <csignal>
#include <iostream>
#include <thread>
#include <chrono>
#include <fcntl.h>
#include <unistd.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <cstring>

namespace
{
    std::atomic<bool> g_running{true};
    int g_lock_fd = -1;

    void signal_handler(int signal)
    {
        if (signal == SIGINT || signal == SIGTERM)
        {
            vayu::utils::log_info("Shutting down...");
            g_running = false;
        }
    }

    bool acquire_lock()
    {
        const char *lock_path = "/tmp/vayu.lock";
        g_lock_fd = open(lock_path, O_RDWR | O_CREAT, 0666);
        if (g_lock_fd < 0)
        {
            vayu::utils::log_error("Failed to open lock file: " + std::string(lock_path));
            return false;
        }

        if (flock(g_lock_fd, LOCK_EX | LOCK_NB) < 0)
        {
            if (errno == EWOULDBLOCK)
            {
                vayu::utils::log_error("Error: Another instance of Vayu Engine is already running.");
            }
            else
            {
                vayu::utils::log_error("Error: Failed to acquire lock on " + std::string(lock_path) + ": " + strerror(errno));
            }
            close(g_lock_fd);
            return false;
        }

        // Write PID
        ftruncate(g_lock_fd, 0);
        std::string pid = std::to_string(getpid()) + "\n";
        write(g_lock_fd, pid.c_str(), pid.length());

        // Do not close the fd, as that releases the lock
        return true;
    }
} // namespace

int main(int argc, char *argv[])
{
    // Initialize logger first
    vayu::utils::Logger::instance().init(vayu::core::constants::logging::DIR);

    // Check for single instance
    if (!acquire_lock())
    {
        return 1;
    }

    // Parse arguments
    int port = vayu::core::constants::defaults::PORT;
    bool verbose = false;

    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];

        if (arg == vayu::core::constants::cli::ARG_PORT_SHORT || arg == vayu::core::constants::cli::ARG_PORT_LONG)
        {
            if (i + 1 < argc)
            {
                port = std::stoi(argv[++i]);
            }
        }
        else if (arg == "-v" || arg == "--verbose")
        {
            verbose = true;
        }
        else if (arg == "-h" || arg == "--help")
        {
            std::cout << "Vayu Engine " << vayu::Version::string << "\n\n";
            std::cout << "Usage: vayu-engine [OPTIONS]\n\n";
            std::cout << "Options:\n";
            std::cout << "  -p, --port <PORT>  Port to listen on (default: 9876)\n";
            std::cout << "  -v, --verbose      Enable verbose output\n";
            std::cout << "  -h, --help         Show this help message\n";
            return 0;
        }
    }

    vayu::utils::Logger::instance().set_verbose(verbose);

    // Setup signal handlers
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    // Initialize database
    vayu::db::Database db("engine/db/vayu.db");
    try
    {
        db.init();
        vayu::utils::log_info("Database initialized at engine/db/vayu.db");
    }
    catch (const std::exception &e)
    {
        vayu::utils::log_error("Failed to initialize database: " + std::string(e.what()));
        return 1;
    }

    // Initialize curl
    vayu::http::global_init();

    // Create RunManager
    vayu::core::RunManager run_manager;

    // Create and start HTTP server
    vayu::http::Server server(db, run_manager, port, verbose);
    server.start();

    // Wait for shutdown signal
    while (g_running && server.is_running())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // Graceful shutdown
    vayu::utils::log_info("Shutting down gracefully...");

    // Stop the HTTP server first
    server.stop();

    // Signal all active runs to stop
    size_t active = run_manager.active_count();
    if (active > 0)
    {
        vayu::utils::log_info("Stopping " + std::to_string(active) + " active load tests...");

        auto active_runs = run_manager.get_all_active_runs();
        for (const auto &context : active_runs)
        {
            context->should_stop = true;
        }

        // Wait for active runs to complete (max 5 seconds)
        auto shutdown_start = std::chrono::steady_clock::now();
        while (run_manager.active_count() > 0)
        {
            auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                               std::chrono::steady_clock::now() - shutdown_start)
                               .count();

            if (elapsed >= 5)
            {
                vayu::utils::log_warning("Warning: " + std::to_string(run_manager.active_count()) +
                                         " tests still running after 5s, forcing shutdown");
                break;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        vayu::utils::log_info("All load tests stopped");
    }

    vayu::http::global_cleanup();

    vayu::utils::log_info("Goodbye!");
    return 0;
}
