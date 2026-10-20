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
#include <condition_variable>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <mutex>
#include <span>
#include <string>

#include "vayu/core/constants.hpp"
#include "vayu/core/daemon_args.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/client.hpp"
#include "vayu/http/grant_secret.hpp"
#include "vayu/http/loopback_guard.hpp"
#include "vayu/http/server.hpp"
#include "vayu/platform/platform.hpp"
#include "vayu/utils/logger.hpp"
#include "vayu/version.hpp"

namespace {
std::atomic<bool> g_running{ true };

// What the main loop waits on between checks of `g_running`. A signal handler
// may only store the atomic - notifying a condition variable is not
// async-signal-safe - so a signal is still seen on the loop's next check, but
// `POST /shutdown` (how the app stops the engine on every platform) runs on an
// ordinary thread and wakes the loop at once instead of waiting out the check.
std::mutex g_wake_mutex;
std::condition_variable g_wake;

void request_stop () {
    {
        std::lock_guard<std::mutex> lock (g_wake_mutex);
        g_running.store (false);
    }
    g_wake.notify_all ();
}

/// The single-instance lock, released when this goes out of scope.
///
/// `run_daemon` declares it before the `Database`, so locals destroyed in
/// reverse order close the database (its checkpoint included) before the lock
/// is released: a successor that takes the lock never meets this engine's
/// connection at its startup probe (issue #2420). An early return or a
/// throw releases it the same way. Taken before the database opens, so the
/// startup reconcile that fails `running` runs can only meet rows no live
/// engine owns (issue #2422).
class InstanceLock {
    public:
    InstanceLock () = default;
    ~InstanceLock () {
        vayu::platform::release_file_lock (handle_);
    }
    InstanceLock (const InstanceLock&)            = delete;
    InstanceLock& operator= (const InstanceLock&) = delete;
    InstanceLock (InstanceLock&&)                 = delete;
    InstanceLock& operator= (InstanceLock&&)      = delete;

    bool acquire (const std::string& lock_path) {
        const auto acquired = vayu::platform::acquire_file_lock (lock_path, handle_);
        if (acquired == vayu::platform::LockAcquisition::Refused) {
            vayu::utils::log_error ("startup",
            "Error: Another instance of Vayu Engine is "
            "already running, or failed to create lock "
            "file: " +
            lock_path);
            return false;
        }
        if (acquired == vayu::platform::LockAcquisition::FileOnly) {
            vayu::utils::log_warning ("startup",
            "This filesystem cannot lock the data directory, so the "
            "single-instance guard is the lock file alone: deleting it while "
            "this engine runs would let a second engine start: " +
            lock_path);
        }

        if (!vayu::platform::write_pid_to_lock (handle_)) {
            vayu::utils::log_warning ("startup", "Failed to write PID to lock file");
            // Not fatal, continue anyway
        }

        return true;
    }

    private:
    vayu::platform::LockHandle handle_ = vayu::platform::INVALID_LOCK_HANDLE;
};

/// The usage `-h` / `--help` answers with. Printed here rather than by the
/// parse, which reports the request and owns no output stream (#1031).
void print_help () {
    std::cout << "Vayu Engine " << vayu::Version::string << "\n\n";
    std::cout << "Usage: vayu-engine [OPTIONS]\n\n";
    std::cout << "Options:\n";
    std::cout << "  -p, --port <PORT>        Port to listen on (default: 9876, "
                 "1-65535)\n";
    std::cout << "  -d, --data-dir <DIR>     Data directory for DB, "
                 "logs, and lock file "
                 "(default: ../data)\n";
    std::cout << "  -v, --verbose [LEVEL]    Enable verbose output "
                 "(0=warn/error, 1=info, "
                 "2=debug, default: 1)\n";
    std::cout << "  -h, --help               Show this help message\n";
}

/// The daemon proper. `main` is the wrapper that keeps a throw from escaping
/// it - see the note there, and it is where `argc`/`argv` become the bounded
/// range this takes: `argv[i]` is arithmetic on a pointer carrying no length,
/// and only `main`'s own signature is exempt from saying so.
int run_daemon (std::span<char* const> args) {
    // Parse arguments first (need data_dir for logging)
    vayu::core::DaemonArgs parsed;
    parsed.data_dir = vayu::platform::default_data_dir ();

    const auto request = vayu::core::read_daemon_args (args, parsed);
    if (!request) {
        // Refused before anything starts - no logger yet, so stderr is the
        // whole of the report, and it is the same shape every bad argument
        // answers with (#1028, #1031).
        std::cerr << "vayu-engine: " << request.error () << "\n";
        return 1;
    }
    if (*request == vayu::core::DaemonRequest::Help) {
        print_help ();
        return 0;
    }

    const int port             = parsed.port;
    const int verbosity        = parsed.verbosity;
    const std::string data_dir = parsed.data_dir;

    // The data directory holds secrets in plaintext, so everything under it is
    // owner-only (#1781, #1802): directories 0700, new files 0600, and the
    // files an older engine left at 0644 are tightened here, before the
    // logger or the database touch them. `tests/platform_test.cpp` scans for
    // this call, because a daemon that skipped it passes every other test.
    try {
        vayu::platform::prepare_data_directory (data_dir);
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what () << "\n";
        return 1;
    }

    const std::string log_dir = vayu::platform::path_join (data_dir, "logs");
    const std::string db_dir  = vayu::platform::path_join (data_dir, "db");

    // Initialize logger
    vayu::utils::Logger::instance ().init (log_dir, "engine");

    // Taken while this is the only thread, because it writes the environment,
    // and early, so nothing the engine reads or starts afterwards sees it.
    const vayu::http::GrantSecret grant_secret =
    vayu::http::take_grant_secret_from_environment ();

    // Before any worker thread allocates (#2544); a refusal keeps the
    // allocator's default, which is slower to give memory back, not wrong.
    if (!vayu::platform::return_large_frees_to_os (
        vayu::core::constants::server::OWN_MAPPING_MIN_BYTES)) {
        vayu::utils::log_warning ("startup",
        "Fixed mmap threshold refused; freed large blocks may stay resident");
    }

    // Check for single instance
    std::string lock_path = vayu::platform::path_join (data_dir, "vayu.lock");
    InstanceLock instance_lock;
    if (!instance_lock.acquire (lock_path)) {
        return 1;
    }

    vayu::utils::Logger::instance ().set_verbosity (verbosity);

    // Setup signal handlers using platform abstraction
    vayu::platform::setup_signal_handlers ([] (bool force) {
        if (force) {
            vayu::utils::log_warning ("shutdown", "Force shutdown requested, exiting immediately");
            // `_Exit` and not `exit` (#945): this runs inside the signal
            // handler, and `exit` would run every atexit handler and static
            // destructor *while the worker threads are still using what they
            // destroy* - the database, the curl globals, the logger this line
            // just wrote through. A second Ctrl-C is asking for the process to
            // stop now, so it stops now; the ordered teardown is the first
            // Ctrl-C's job, below.
            std::_Exit (1);
        }
        vayu::utils::log_info ("shutdown", "Shutting down...");
        g_running.store (false);
    });

    // Initialize database
    std::string db_path = vayu::platform::path_join (db_dir, "vayu.db");
    vayu::db::Database db (db_path);
    try {
        db.init ();
        vayu::utils::log_info ("startup", "Database initialized at " + db_path);
    } catch (const std::exception& e) {
        vayu::utils::log_error (
        "startup", "Failed to initialize database: " + std::string (e.what ()));
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
        vayu::utils::log_warning ("config",
        "Ignoring unrecognised logLevel '" + configured_level +
        "' - the log file keeps its default level (" +
        vayu::core::constants::logging::DEFAULT_LEVEL + ")");
    }
    vayu::utils::Logger::instance ().set_max_file_bytes (db.get_config_int (
    "maxLogFileBytes", vayu::core::constants::logging::DEFAULT_MAX_FILE_BYTES));

    // Initialize curl
    vayu::http::global_init ();

    // Create RunManager and start its background TTL sweeper so retained
    // runs (completed but kept for /runs/:id/live replay) get evicted even in
    // headless flows that never hit /runs/:id/live or POST /runs. The provider is
    // re-read each sweep tick, so changing liveRetentionMs from the UI takes
    // effect without restarting the daemon (0 = evict immediately).
    vayu::core::RunManager run_manager;
    run_manager.start_sweeper (
    [&db] () -> int64_t { return db.get_config_int ("liveRetentionMs", 60000); });

    // Before the listener starts, so no request is served while an outbound
    // transfer could still reach this port (#2355). A port that cannot be
    // bound ends the process below, so the requested port is the bound one.
    vayu::http::set_engine_port (port);

    // Create and start HTTP server
    vayu::http::Server server (db, run_manager, port, grant_secret);

    // Set shutdown callback for /shutdown endpoint
    // This callback is invoked before the server stops, allowing us to
    // trigger the graceful shutdown sequence in the main loop
    server.set_shutdown_callback ([&] () {
        vayu::utils::log_info (
        "shutdown", "Shutdown callback invoked - signaling main loop to exit");
        request_stop ();
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
    } else {
        // After the listener, never before it: the refresh is O(database size)
        // and used to be taken in the `Database` constructor, ahead of the
        // first `/health`. It reads through a connection of its own, so the
        // app's first requests are served alongside it. It holds what the
        // session started from; the refresh at shutdown below adds what the
        // session wrote (#2421).
        db.start_recovery_backup_refresh ();
    }

    // Wait for shutdown signal (either from OS signal or /shutdown endpoint).
    // The timeout is the signal path's check interval and the listener-died
    // check; `/shutdown` wakes the wait directly (see `request_stop`).
    {
        std::unique_lock<std::mutex> lock (g_wake_mutex);
        while (g_running && server.is_running ()) {
            g_wake.wait_for (lock, std::chrono::milliseconds (100));
        }
    }

    // Graceful shutdown. The app's kill timer (`server::SHUTDOWN_WINDOW_MS`)
    // started when it asked for this; here is the engine's nearest measure of
    // that moment.
    const auto shutdown_began = std::chrono::steady_clock::now ();
    vayu::utils::log_info ("shutdown", "Shutting down gracefully...");

    // Stop the HTTP server first (with timeout)
    auto server_stop_start = std::chrono::steady_clock::now ();
    server.stop ();
    auto server_stop_elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - server_stop_start)
                               .count ();
    vayu::utils::log_debug ("shutdown",
    "Server stopped in " + std::to_string (server_stop_elapsed) + "ms");

    // Stop every active run and JOIN its worker before anything it holds a
    // reference to is torn down. The loop this replaced stopped waiting once
    // `active_count()` hit zero - which a worker reaches at retain_run, its
    // last statement, with the thread still unwinding - and gave up entirely
    // after 5s, leaving detached workers writing to `db` and calling into curl
    // while both were destroyed underneath them.
    //
    // The order below is load-bearing: workers joined, then the recovery
    // backup's final refresh, then curl's global teardown, then `server` /
    // `run_manager` / `db` at scope exit, and the instance lock last of all,
    // after `db` has closed (see `InstanceLock`).
    run_manager.shutdown ();

    // A snapshot still reading the database must not overlap the next
    // engine's start. Interrupted rather than waited out; the previous backup
    // stands.
    db.finish_recovery_backup_refresh ();

    // Nothing writes any more, and `db` and the instance lock are both still
    // held, so the next engine cannot start against the copy. Budgeted against
    // what the run drain above left of the app's window.
    const auto shutdown_elapsed = std::chrono::duration_cast<std::chrono::milliseconds> (
    std::chrono::steady_clock::now () - shutdown_began);
    const auto refreshed = db.refresh_recovery_backup_on_shutdown (
    std::chrono::milliseconds (vayu::core::constants::server::SHUTDOWN_WINDOW_MS) - shutdown_elapsed);
    if (!refreshed) {
        vayu::utils::log_warning ("db",
        "The recovery backup was not refreshed at shutdown, so the previous "
        "one stands: " +
        refreshed.error ());
    }

    vayu::http::global_cleanup ();

    vayu::utils::log_info ("shutdown", "Goodbye!");

    // Force flush logs
    vayu::utils::Logger::instance ().flush ();

    // 1 = the listener never took its port (see the start() check above); 0 =
    // an ordinary shutdown. Documented in docs/engine/cli.md.
    return exit_code;
}
} // namespace

int main (int argc, char* argv[]) {
    try {
        return run_daemon (std::span<char* const> (argv, static_cast<size_t> (argc)));
    } catch (const std::exception& e) {
        // Reported rather than terminated on, for the reason `cli.cpp` gives:
        // an escape from `main` aborts with no message and a status no caller
        // can tell from a crash.
        //
        // The `Database` constructor's refusals land here on purpose (the
        // `try` in `run_daemon` guards `init`, not the constructor): a
        // database written by a newer schema (#1514) and one that could not
        // be examined because it is locked, the disk is full or read-only
        // (#2420). Each message names the path and what to do, and this is
        // what puts it on stderr with exit status 1. `Logger::init` and
        // `Server` also throw where nothing else catches.
        std::cerr << "vayu-engine: " << e.what () << "\n";
        vayu::utils::log_error ("startup", std::string ("vayu-engine: ") + e.what ());
        return 1;
    } catch (...) {
        std::cerr << "vayu-engine: unknown error\n";
        vayu::utils::log_error ("startup", "vayu-engine: unknown error");
        return 1;
    }
}
