/**
 * @file daemon.cpp
 * @brief Vayu Engine daemon entry point
 *
 * This is the background process that handles high-concurrency requests.
 * It exposes a Control API for the Electron app to communicate with.
 */

#include <atomic>
#include <chrono>
#include <iostream>
#include <thread>

#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/server.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace {
std::atomic<bool> g_running{true};
vayu::platform::LockHandle g_lock_handle = vayu::platform::INVALID_LOCK_HANDLE;

std::string get_default_data_dir() {
    // Default to current directory for backward compatibility
    return ".";
}

bool acquire_lock(const std::string& lock_path) {
    if (!vayu::platform::acquire_file_lock(lock_path, g_lock_handle)) {
        vayu::utils::log_error(
            "Error: Another instance of Vayu Engine is already running, or failed to create lock "
            "file: " +
            lock_path);
        return false;
    }

    if (!vayu::platform::write_pid_to_lock(g_lock_handle)) {
        vayu::utils::log_warning("Failed to write PID to lock file");
        // Not fatal, continue anyway
    }

    return true;
}
}  // namespace

int main(int argc, char* argv[]) {
    // Parse arguments first (need data_dir for logging)
    int port = vayu::core::constants::defaults::PORT;
    int verbosity = 0;  // 0=warn/error, 1=info+, 2=debug+
    std::string data_dir = get_default_data_dir();

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];

        if (arg == vayu::core::constants::cli::ARG_PORT_SHORT ||
            arg == vayu::core::constants::cli::ARG_PORT_LONG) {
            if (i + 1 < argc) {
                port = std::stoi(argv[++i]);
            }
        } else if (arg == "-d" || arg == "--data-dir") {
            if (i + 1 < argc) {
                data_dir = argv[++i];
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
            std::cout << "  -p, --port <PORT>        Port to listen on (default: 9876)\n";
            std::cout << "  -d, --data-dir <DIR>     Data directory for DB, logs, and lock file (default: .)\n";
            std::cout << "  -v, --verbose [LEVEL]    Enable verbose output (0=warn/error, 1=info, "
                         "2=debug, default: 1)\n";
            std::cout << "  -h, --help               Show this help message\n";
            return 0;
        }
    }

    // Ensure data directory exists
    try {
        vayu::platform::ensure_directory(data_dir);
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }

    // Create subdirectories for logs and database
    std::string log_dir = vayu::platform::path_join(data_dir, "logs");
    std::string db_dir = vayu::platform::path_join(data_dir, "db");
    try {
        vayu::platform::ensure_directory(log_dir);
        vayu::platform::ensure_directory(db_dir);
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }

    // Initialize logger
    vayu::utils::Logger::instance().init(log_dir);

    // Check for single instance
    std::string lock_path = vayu::platform::path_join(data_dir, "vayu.lock");
    if (!acquire_lock(lock_path)) {
        return 1;
    }

    vayu::utils::Logger::instance().set_verbosity(verbosity);

    // Setup signal handlers using platform abstraction
    vayu::platform::setup_signal_handlers([](bool force) {
        if (force) {
            vayu::utils::log_warning("Force shutdown requested, exiting immediately");
            std::exit(1);
        }
        vayu::utils::log_info("Shutting down...");
        g_running.store(false);
    });

    // Initialize database
    std::string db_path = vayu::platform::path_join(db_dir, "vayu.db");
    vayu::db::Database db(db_path);
    try {
        db.init();
        vayu::utils::log_info("Database initialized at " + db_path);
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
    vayu::platform::release_file_lock(g_lock_handle);

    vayu::utils::log_info("Goodbye!");

    // Force flush logs
    vayu::utils::Logger::instance().flush();

    return 0;
}
