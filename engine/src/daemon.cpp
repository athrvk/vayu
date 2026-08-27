/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */


/**
 * @file daemon.cpp
 * @brief Vayu Engine daemon entry point
 *
 * This is the background process that handles high-concurrency requests.
 * It exposes a Control API for the Electron app to communicate with.
 */

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <span>
#include <string_view>
#include <thread>

#include "vayu/core/constants.hpp"
#include "vayu/core/numeric_flag.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/server.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace {
std::atomic<bool> g_running{ true };
vayu::platform::LockHandle g_lock_handle = vayu::platform::INVALID_LOCK_HANDLE;

std::string get_default_data_dir () {
    // Default to the repository data folder adjacent to the engine build
    // ("../data"). This makes the daemon, logger and lock file default to the
    // project's data directory when no --data-dir argument is provided.
    return vayu::platform::path_join (".", "data");
}

bool acquire_lock (const std::string& lock_path) {
    if (!vayu::platform::acquire_file_lock (lock_path, g_lock_handle)) {
        vayu::utils::log_error ("Error: Another instance of Vayu Engine is "
                                "already running, or failed to create lock "
                                "file: " +
        lock_path);
        return false;
    }

    if (!vayu::platform::write_pid_to_lock (g_lock_handle)) {
        vayu::utils::log_warning ("Failed to write PID to lock file");
        // Not fatal, continue anyway
    }

    return true;
}
/**
 * Read @p text as @p flag's value onto @p out.
 *
 * The refusal is printed here rather than returned, because both call sites do
 * the same thing with it and the argument loop is at its complexity budget with
 * one branch per flag, not two.
 *
 * @return true to carry on, false when the run is over.
 */
bool read_numeric_flag (const vayu::core::NumericFlag& flag, std::string_view text, int& out) {
    const auto parsed = vayu::core::parse_numeric_flag (flag, text);
    if (!parsed) {
        std::cerr << "vayu-engine: " << parsed.error () << "\n";
        return false;
    }
    out = *parsed;
    return true;
}

/// `-p` / `--port <PORT>`. A flag with nothing after it leaves the default
/// standing, which is what it has always done.
bool read_port (std::span<char* const> args, size_t& i, int& port) {
    if (i + 1 >= args.size ()) {
        return true;
    }
    return read_numeric_flag (vayu::core::PORT_FLAG, args[++i], port);
}

/// `-v` / `--verbose [LEVEL]`. The level is optional, so a leading digit is
/// what says the next argument was meant as one at all - `-v run` is verbose
/// with no level, not a bad level. Once it is meant as one it is held to the
/// range rather than clamped into it: `-v 5` was silently 2, which told the
/// user nothing about the levels that exist.
bool read_verbosity (std::span<char* const> args, size_t& i, int& verbosity) {
    if (i + 1 < args.size () &&
    std::isdigit (static_cast<unsigned char> (*args[i + 1])) != 0) {
        return read_numeric_flag (vayu::core::VERBOSITY_FLAG, args[++i], verbosity);
    }
    // No level specified, default to 1 (info level)
    verbosity = 1;
    return true;
}

/**
 * The daemon's own arguments.
 *
 * @return the exit code to stop on - `--help` answers here - or nothing to
 *         carry on with what the pass read.
 */
std::optional<int>
read_daemon_args (std::span<char* const> args, int& port, int& verbosity, std::string& data_dir) {
    for (size_t i = 1; i < args.size (); ++i) {
        std::string arg = args[i];

        if (arg == vayu::core::constants::cli::ARG_PORT_SHORT ||
        arg == vayu::core::constants::cli::ARG_PORT_LONG) {
            if (!read_port (args, i, port)) {
                return 1;
            }
        } else if (arg == "-d" || arg == "--data-dir") {
            if (i + 1 < args.size ()) {
                data_dir = args[++i];
            }
        } else if (arg == "-v" || arg == "--verbose") {
            if (!read_verbosity (args, i, verbosity)) {
                return 1;
            }
        } else if (arg == "-h" || arg == "--help") {
            std::cout << "Vayu Engine " << vayu::Version::string << "\n\n";
            std::cout << "Usage: vayu-engine [OPTIONS]\n\n";
            std::cout << "Options:\n";
            std::cout
            << "  -p, --port <PORT>        Port to listen on (default: 9876)\n";
            std::cout << "  -d, --data-dir <DIR>     Data directory for DB, "
                         "logs, and lock file "
                         "(default: ../data)\n";
            std::cout << "  -v, --verbose [LEVEL]    Enable verbose output "
                         "(0=warn/error, 1=info, "
                         "2=debug, default: 1)\n";
            std::cout << "  -h, --help               Show this help message\n";
            return 0;
        }
    }
    return std::nullopt;
}

} // namespace

int main (int argc, char* argv[]) {
    // Parse arguments first (need data_dir for logging)
    int port             = vayu::core::constants::defaults::PORT;
    int verbosity        = 0; // 0=warn/error, 1=info+, 2=debug+
    std::string data_dir = get_default_data_dir ();

    // The argument vector as the bounded range it is: `argv[i]` is arithmetic
    // on a pointer that carries no length, and the count is right there.
    const std::span<char* const> args (argv, static_cast<size_t> (argc));

    if (auto stop = read_daemon_args (args, port, verbosity, data_dir)) {
        return *stop;
    }


    // Ensure data directory exists
    try {
        vayu::platform::ensure_directory (data_dir);
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what () << "\n";
        return 1;
    }

    // Create subdirectories for logs and database
    std::string log_dir = vayu::platform::path_join (data_dir, "logs");
    std::string db_dir  = vayu::platform::path_join (data_dir, "db");
    try {
        vayu::platform::ensure_directory (log_dir);
        vayu::platform::ensure_directory (db_dir);
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what () << "\n";
        return 1;
    }

    // Initialize logger
    vayu::utils::Logger::instance ().init (log_dir);

    // Check for single instance
    std::string lock_path = vayu::platform::path_join (data_dir, "vayu.lock");
    if (!acquire_lock (lock_path)) {
        return 1;
    }

    vayu::utils::Logger::instance ().set_verbosity (verbosity);

    // Setup signal handlers using platform abstraction
    vayu::platform::setup_signal_handlers ([] (bool force) {
        if (force) {
            vayu::utils::log_warning (
            "Force shutdown requested, exiting immediately");
            // `_Exit` and not `exit` (#945): this runs inside the signal
            // handler, and `exit` would run every atexit handler and static
            // destructor *while the worker threads are still using what they
            // destroy* - the database, the curl globals, the logger this line
            // just wrote through. A second Ctrl-C is asking for the process to
            // stop now, so it stops now; the ordered teardown is the first
            // Ctrl-C's job, below.
            std::_Exit (1);
        }
        vayu::utils::log_info ("Shutting down...");
        g_running.store (false);
    });

#if VAYU_PLATFORM_WINDOWS
    // Enable 1 ms timer resolution so short sleeps are accurate (high-RPS load tests)
    vayu::platform::enable_high_resolution_timer ();
#endif

    // Initialize database
    std::string db_path = vayu::platform::path_join (db_dir, "vayu.db");
    vayu::db::Database db (db_path);
    try {
        db.init ();
        vayu::utils::log_info ("Database initialized at " + db_path);
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "Failed to initialize database: " + std::string (e.what ()));
        return 1;
    }

    // Apply the file sink's configuration, which needs the database the logger
    // is initialised before: the log directory has to exist and be writable
    // from the first line, and the first lines are written opening this file.
    // Both entries are restart-required for that reason - the value in force is
    // the one read here.
    const std::string configured_level =
    db.get_config_string ("logLevel", vayu::core::constants::logging::DEFAULT_LEVEL);
    if (auto level = vayu::utils::parse_log_level (configured_level)) {
        vayu::utils::Logger::instance ().set_file_level (*level);
    } else {
        vayu::utils::log_warning ("Ignoring unrecognised logLevel '" +
        configured_level + "' - the log file keeps its default level (" +
        vayu::core::constants::logging::DEFAULT_LEVEL + ")");
    }
    vayu::utils::Logger::instance ().set_max_file_bytes (db.get_config_int (
    "maxLogFileBytes", vayu::core::constants::logging::DEFAULT_MAX_FILE_BYTES));

    // Initialize curl
    vayu::http::global_init ();

    // Create RunManager and start its background TTL sweeper so retained
    // runs (completed but kept for /metrics/live replay) get evicted even in
    // headless flows that never hit /metrics/live or /run. The provider is
    // re-read each sweep tick, so changing liveRetentionMs from the UI takes
    // effect without restarting the daemon (0 = evict immediately).
    vayu::core::RunManager run_manager;
    run_manager.start_sweeper (
    [&db] () -> int64_t { return db.get_config_int ("liveRetentionMs", 60000); });

    // Create and start HTTP server
    // verbose parameter is kept for backward compatibility with server internals
    bool verbose_legacy = (verbosity >= 1);
    vayu::http::Server server (db, run_manager, port, verbose_legacy);

    // Set shutdown callback for /shutdown endpoint
    // This callback is invoked before the server stops, allowing us to
    // trigger the graceful shutdown sequence in the main loop
    server.set_shutdown_callback ([&] () {
        vayu::utils::log_info (
        "Shutdown callback invoked - signaling main loop to exit");
        g_running.store (false);
    });

    // A listener that never came up and one that was asked to stop both leave
    // the wait loop below with `is_running()` false, and telling them apart is
    // the whole of #983: a taken port used to print the listening banner, fall
    // into the graceful path and exit 0, so the app saw an engine that had
    // simply died. The teardown is shared - the lock file and curl's global
    // state must be released either way - and only the exit code differs.
    int exit_code = 0;
    if (!server.start ()) {
        // `start()` has already logged the reason, which puts it on stderr and
        // in the log file; what it cannot say is what to do about it.
        std::cerr << "vayu-engine: exiting 1 - stop the process holding that "
                     "port, or pass --port, then start the engine again.\n";
        std::cerr.flush ();
        exit_code = 1;
    }

    // Wait for shutdown signal (either from OS signal or /shutdown endpoint)
    while (g_running && server.is_running ()) {
        std::this_thread::sleep_for (std::chrono::milliseconds (100));
    }

    // Graceful shutdown
    vayu::utils::log_info ("Shutting down gracefully...");

    // Stop the HTTP server first (with timeout)
    auto server_stop_start = std::chrono::steady_clock::now ();
    server.stop ();
    auto server_stop_elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - server_stop_start)
                               .count ();
    vayu::utils::log_debug (
    "Server stopped in " + std::to_string (server_stop_elapsed) + "ms");

    // Stop every active run and JOIN its worker before anything it holds a
    // reference to is torn down. The loop this replaced stopped waiting once
    // `active_count()` hit zero - which a worker reaches at retain_run, its
    // last statement, with the thread still unwinding - and gave up entirely
    // after 5s, leaving detached workers writing to `db` and calling into curl
    // while both were destroyed underneath them.
    //
    // The order below is load-bearing: workers joined, then curl's global
    // teardown, then `server` / `run_manager` / `db` at scope exit.
    run_manager.shutdown ();

    vayu::http::global_cleanup ();

#if VAYU_PLATFORM_WINDOWS
    vayu::platform::disable_high_resolution_timer ();
#endif

    // Release lock file
    vayu::platform::release_file_lock (g_lock_handle);

    vayu::utils::log_info ("Goodbye!");

    // Force flush logs
    vayu::utils::Logger::instance ().flush ();

    // 1 = the listener never took its port (see the start() check above); 0 =
    // an ordinary shutdown. Documented in docs/engine/cli.md.
    return exit_code;
}
