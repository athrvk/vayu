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
#include "vayu/db/database.hpp"
#include "vayu/version.hpp"

#include <atomic>
#include <csignal>
#include <iostream>
#include <thread>
#include <chrono>

namespace
{
    std::atomic<bool> g_running{true};

    void signal_handler(int signal)
    {
        if (signal == SIGINT || signal == SIGTERM)
        {
            std::cout << "\nShutting down...\n";
            g_running = false;
        }
    }
} // namespace

int main(int argc, char *argv[])
{
    // Parse arguments
    int port = 9876;
    bool verbose = false;

    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];

        if (arg == "-p" || arg == "--port")
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

    // Setup signal handlers
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    // Initialize database
    vayu::db::Database db("engine/db/vayu.db");
    try
    {
        db.init();
        std::cout << "Database initialized at engine/db/vayu.db\n";
    }
    catch (const std::exception &e)
    {
        std::cerr << "Failed to initialize database: " << e.what() << "\n";
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
    std::cout << "Shutting down gracefully...\n";

    // Stop the HTTP server first
    server.stop();

    // Signal all active runs to stop
    size_t active = run_manager.active_count();
    if (active > 0)
    {
        std::cout << "Stopping " << active << " active load tests...\n";

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
                std::cout << "Warning: " << run_manager.active_count()
                          << " tests still running after 5s, forcing shutdown\n";
                break;
            }

            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }

        std::cout << "All load tests stopped\n";
    }

    vayu::http::global_cleanup();

    std::cout << "Goodbye!\n";
    return 0;
}
