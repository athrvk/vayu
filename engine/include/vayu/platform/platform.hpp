#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file platform.hpp
 * @brief Cross-platform abstraction layer for OS-specific operations
 *
 * This header provides platform-independent interfaces for:
 * - Process management (PID, signals)
 * - File locking (single instance)
 * - Directory operations
 * - Signal handling
 */

#include <functional>
#include <string>

// Platform detection macros
// Macros, not an enum: every consumer is a preprocessor conditional
// (`#if VAYU_PLATFORM_WINDOWS`), which an enum cannot serve.
// NOLINTBEGIN(modernize-macro-to-enum)
#ifdef _WIN32
#define VAYU_PLATFORM_WINDOWS 1
#define VAYU_PLATFORM_UNIX 0
#define VAYU_PLATFORM_MACOS 0
#define VAYU_PLATFORM_LINUX 0
#elif defined(__APPLE__)
#define VAYU_PLATFORM_WINDOWS 0
#define VAYU_PLATFORM_UNIX 1
#define VAYU_PLATFORM_MACOS 1
#define VAYU_PLATFORM_LINUX 0
#elif defined(__linux__)
#define VAYU_PLATFORM_WINDOWS 0
#define VAYU_PLATFORM_UNIX 1
#define VAYU_PLATFORM_MACOS 0
#define VAYU_PLATFORM_LINUX 1
#else
#define VAYU_PLATFORM_WINDOWS 0
#define VAYU_PLATFORM_UNIX 1
#define VAYU_PLATFORM_MACOS 0
#define VAYU_PLATFORM_LINUX 0
#endif
// NOLINTEND(modernize-macro-to-enum)

namespace vayu::platform {

// ============================================================================
// Process Management
// ============================================================================

/**
 * @brief Get the current process ID
 * @return Process ID as integer
 */
int get_process_id ();

/**
 * @brief Check if a process with the given PID is still running
 * @param pid Process ID to check
 * @return true if process is running, false otherwise
 */
bool is_process_running (int pid);

// ============================================================================
// File Locking (Single Instance)
// ============================================================================

/**
 * @brief Opaque handle type for file locks
 * On Windows: HANDLE, On Unix: int (file descriptor)
 */
#if VAYU_PLATFORM_WINDOWS
using LockHandle                         = void*;
constexpr LockHandle INVALID_LOCK_HANDLE = nullptr;
#else
using LockHandle                         = int;
constexpr LockHandle INVALID_LOCK_HANDLE = -1;
#endif

/**
 * @brief Acquire an exclusive lock on a file
 * @param path Path to the lock file
 * @param handle Output parameter for the lock handle
 * @return true if lock acquired successfully, false otherwise
 *
 * The lock file will be created if it doesn't exist.
 * The lock is exclusive and non-blocking (fails immediately if locked).
 */
bool acquire_file_lock (const std::string& path, LockHandle& handle);

/**
 * @brief Write the current PID to the lock file
 * @param handle Lock handle from acquire_file_lock
 * @return true on success
 */
bool write_pid_to_lock (LockHandle handle);

/**
 * @brief Read PID from a lock file
 * @param path Path to the lock file
 * @param pid Output parameter for the PID
 * @return true if PID was successfully read, false otherwise
 */
bool read_pid_from_lock (const std::string& path, int& pid);

/**
 * @brief Release a previously acquired file lock
 * @param handle Lock handle from acquire_file_lock
 */
void release_file_lock (LockHandle& handle);

// ============================================================================
// Directory Operations
// ============================================================================

/**
 * @brief Check if a path is a directory
 * @param path Path to check
 * @return true if path exists and is a directory
 */
bool is_directory (const std::string& path);

/**
 * @brief Create a directory (and parents if needed)
 * @param path Path to create
 * @return true on success or if directory already exists
 */
bool create_directory (const std::string& path);

/**
 * @brief Ensure a directory exists, throw on failure
 * @param path Path to ensure
 * @throws std::runtime_error if directory cannot be created
 */
void ensure_directory (const std::string& path);

// ============================================================================
// Signal Handling
// ============================================================================

/**
 * @brief Callback type for shutdown signals
 */
using ShutdownCallback = std::function<void (bool force)>;

/**
 * @brief Set up signal handlers for graceful shutdown
 * @param callback Function to call when shutdown signal is received
 *
 * On Unix: Handles SIGINT and SIGTERM
 * On Windows: Handles CTRL+C and CTRL+BREAK via SetConsoleCtrlHandler
 *
 * The callback receives 'force=true' on second signal (force quit)
 */
void setup_signal_handlers (ShutdownCallback callback);

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * @brief Get the path separator for the current platform
 * @return "/" on Unix, "\\" on Windows
 */
constexpr char path_separator () {
#if VAYU_PLATFORM_WINDOWS
    return '\\';
#else
    return '/';
#endif
}

/**
 * @brief Join two path components
 * @param base Base path
 * @param component Component to append
 * @return Combined path
 */
std::string path_join (const std::string& base, const std::string& component);

// ============================================================================
// High-Resolution Timer
// ============================================================================
/**
 * @brief Holds the system's 1 ms timer resolution for as long as it lives
 *
 * Windows only in effect - on every other platform the class is an empty
 * bracket the counter still records, so the balance is one invariant tested
 * everywhere rather than on one CI leg (`high_resolution_timer_holders`).
 *
 * Windows' default timer resolution is ~15.6 ms, and `timeBeginPeriod (1)`
 * lowers it to 1 ms. Two consumers need that, and **both live only while a run
 * is sending** (issue #1161):
 *
 * - the event loop's `curl_multi_poll (..., POLL_TIMEOUT_MS)`, which asks for a
 *   1 ms wait per iteration and gets ~15.6 ms without this;
 * - the rate-limited pacing loop's `sleep_for` leg, which runs below ~500 RPS
 *   (above it the tick's remainder is spun out instead - see
 *   `wait_for_next_tick`), where a 2.5 ms sleep would likewise round to ~15.6.
 *
 * So the request is scoped to runs and not to the process: the sidecar is
 * resident for the whole app session and idle for almost all of it, and a
 * process-lifetime request is the classic Windows battery finding. The holder
 * is the event loop itself (`detail::EventLoopImpl`), which exists only while
 * a run is sending and is destroyed by `release_execution_resources` as the
 * run is retained - so nothing has to remember to give the request back, and
 * a design-mode scenario run, which sends sequentially and builds no loop,
 * never asks for it.
 *
 * Nesting is safe: the underlying request is refcounted, taken by the first
 * holder and released by the last, under a mutex - the count and the OS call
 * move together, so a run starting as another finishes cannot end with the
 * resolution released while a live run needs it.
 */
class HighResolutionTimerScope {
    public:
    HighResolutionTimerScope ();
    ~HighResolutionTimerScope ();
    HighResolutionTimerScope (const HighResolutionTimerScope&) = delete;
    HighResolutionTimerScope& operator= (const HighResolutionTimerScope&) = delete;
    HighResolutionTimerScope (HighResolutionTimerScope&&)            = delete;
    HighResolutionTimerScope& operator= (HighResolutionTimerScope&&) = delete;
};

/**
 * @brief How many scopes hold the 1 ms request right now
 *
 * The refcount itself, so a test can state the invariant the scope exists for -
 * that what a run takes, a run gives back - on a platform where the OS call is
 * compiled out.
 */
[[nodiscard]] int high_resolution_timer_holders ();

} // namespace vayu::platform
