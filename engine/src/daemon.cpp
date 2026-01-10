/**
 * @file daemon.cpp
 * @brief Vayu Engine daemon entry point
 *
 * This is the background process that handles high-concurrency requests.
 * It exposes a Control API for the Electron app to communicate with.
 */

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstring>
#include <iostream>
#include <thread>

#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/server.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace {
std::atomic<bool> g_running{true};
std::atomic<bool> g_shutdown_requested{false};
int g_lock_fd = -1;

void signal_handler(int signal) {
    if (signal == SIGINT || signal == SIGTERM) {
        if (g_shutdown_requested.load()) {
            // Second signal - force immediate exit
            vayu::utils::log_warning("Force shutdown requested, exiting immediately");
            std::exit(1);
        }
        vayu::utils::log_info("Shutting down...");
        g_shutdown_requested.store(true);
        g_running.store(false);
    }
}

bool acquire_lock() {
    const char* lock_path = "/tmp/vayu.lock";
    g_lock_fd = open(lock_path, O_RDWR | O_CREAT, 0666);
    if (g_lock_fd < 0) {
        vayu::utils::log_error("Failed to open lock file: " + std::string(lock_path));
        return false;
    }

    if (flock(g_lock_fd, LOCK_EX | LOCK_NB) < 0) {
        if (errno == EWOULDBLOCK) {
            vayu::utils::log_error("Error: Another instance of Vayu Engine is already running.");
        } else {
            vayu::utils::log_error("Error: Failed to acquire lock on " + std::string(lock_path) +
                                   ": " + strerror(errno));
        }
        close(g_lock_fd);
        return false;
    }

    // Write PID
    if (ftruncate(g_lock_fd, 0) == -1) {
        perror("ftruncate failed");
        close(g_lock_fd);
        return false;
    }
    std::string pid = std::to_string(getpid()) + "\n";
    ssize_t written = write(g_lock_fd, pid.c_str(), pid.length());
    if (written != (ssize_t) pid.length()) {
        perror("write failed");
        close(g_lock_fd);
        return false;
    }

    // Do not close the fd, as that releases the lock
    return true;
}
}  // namespace

int main(int argc, char* argv[]) {
    // Initialize logger first
    vayu::utils::Logger::instance().init(vayu::core::constants::logging::DIR);

    // Check for single instance
    if (!acquire_lock()) {
        return 1;
    }

    // Parse arguments
    int port = vayu::core::constants::defaults::PORT;
    int verbosity = 0;  // 0=warn/error, 1=info+, 2=debug+

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];

        if (arg == vayu::core::constants::cli::ARG_PORT_SHORT ||
            arg == vayu::core::constants::cli::ARG_PORT_LONG) {
            if (i + 1 < argc) {
                port = std::stoi(argv[++i]);
            }
        } else if (arg == "-v" || arg == "--verbose") {
            // Check if next arg is a number (verbosity level)
            if (i + 1 < argc && std::isdigit(argv[i + 1][0])) {
                verbosity = std::stoi(argv[++i]);
                // Clamp to valid range [0, 2]
                verbosity = std::max(0, std::min(2, verbosity));
            } else {
                // No level specified, default to 1 (info level)
                verbosity = 1;
            }
        } else if (arg == "-h" || arg == "--help") {
            std::cout << "Vayu Engine " << vayu::Version::string << "\n\n";
            std::cout << "Usage: vayu-engine [OPTIONS]\n\n";
            std::cout << "Options:\n";
            std::cout << "  -p, --port <PORT>     Port to listen on (default: 9876)\n";
            std::cout << "  -v, --verbose [LEVEL] Enable verbose output (0=warn/error, 1=info, "
                         "2=debug, default: 1)\n";
            std::cout << "  -h, --help            Show this help message\n";
            return 0;
        }
    }

    vayu::utils::Logger::instance().set_verbosity(verbosity);

    // Setup signal handlers
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    // Initialize database
    vayu::db::Database db("db/vayu.db");
    try {
        db.init();
        vayu::utils::log_info("Database initialized at db/vayu.db");
    } catch (const std::exception& e) {
        vayu::utils::log_error("Failed to initialize database: " + std::string(e.what()));
        return 1;
    }

    // Initialize curl
    vayu::http::global_init();

    // Create RunManager
    vayu::core::RunManager run_manager;

    // Create and start HTTP server
    // verbose parameter is kept for backward compatibility with server internals
    bool verbose_legacy = (verbosity >= 1);
    vayu::http::Server server(db, run_manager, port, verbose_legacy);
    server.start();

    // Wait for shutdown signal
    while (g_running && server.is_running()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    // Graceful shutdown
    vayu::utils::log_info("Shutting down gracefully...");

    // Stop the HTTP server first (with timeout)
    auto server_stop_start = std::chrono::steady_clock::now();
    server.stop();
    auto server_stop_elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                                   std::chrono::steady_clock::now() - server_stop_start)
                                   .count();
    vayu::utils::log_debug("Server stopped in " + std::to_string(server_stop_elapsed) + "ms");

    // Signal all active runs to stop
    size_t active = run_manager.active_count();
    if (active > 0) {
        vayu::utils::log_info("Stopping " + std::to_string(active) + " active load tests...");

        auto active_runs = run_manager.get_all_active_runs();
        for (const auto& context : active_runs) {
            context->should_stop = true;
        }

        // Wait for active runs to complete (max 5 seconds)
        auto shutdown_start = std::chrono::steady_clock::now();
        while (run_manager.active_count() > 0) {
            auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                               std::chrono::steady_clock::now() - shutdown_start)
                               .count();

            if (elapsed >= 5) {
                vayu::utils::log_warning("Warning: " + std::to_string(run_manager.active_count()) +
                                         " tests still running after 5s, forcing shutdown");
                break;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        vayu::utils::log_info("All load tests stopped");
    }

    vayu::http::global_cleanup();

    // Release lock file
    if (g_lock_fd >= 0) {
        flock(g_lock_fd, LOCK_UN);
        close(g_lock_fd);
    }

    vayu::utils::log_info("Goodbye!");

    // Force flush logs
    vayu::utils::Logger::instance().flush();

    return 0;
}
