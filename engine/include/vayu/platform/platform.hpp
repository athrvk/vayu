#pragma once

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

namespace vayu::platform {

// ============================================================================
// Process Management
// ============================================================================

/**
 * @brief Get the current process ID
 * @return Process ID as integer
 */
int get_process_id();

/**
 * @brief Check if a process with the given PID is still running
 * @param pid Process ID to check
 * @return true if process is running, false otherwise
 */
bool is_process_running(int pid);

// ============================================================================
// File Locking (Single Instance)
// ============================================================================

/**
 * @brief Opaque handle type for file locks
 * On Windows: HANDLE, On Unix: int (file descriptor)
 */
#if VAYU_PLATFORM_WINDOWS
using LockHandle = void*;
constexpr LockHandle INVALID_LOCK_HANDLE = nullptr;
#else
using LockHandle = int;
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
bool acquire_file_lock(const std::string& path, LockHandle& handle);

/**
 * @brief Write the current PID to the lock file
 * @param handle Lock handle from acquire_file_lock
 * @return true on success
 */
bool write_pid_to_lock(LockHandle handle);

/**
 * @brief Read PID from a lock file
 * @param path Path to the lock file
 * @param pid Output parameter for the PID
 * @return true if PID was successfully read, false otherwise
 */
bool read_pid_from_lock(const std::string& path, int& pid);

/**
 * @brief Release a previously acquired file lock
 * @param handle Lock handle from acquire_file_lock
 */
void release_file_lock(LockHandle& handle);

// ============================================================================
// Directory Operations
// ============================================================================

/**
 * @brief Check if a path is a directory
 * @param path Path to check
 * @return true if path exists and is a directory
 */
bool is_directory(const std::string& path);

/**
 * @brief Create a directory (and parents if needed)
 * @param path Path to create
 * @return true on success or if directory already exists
 */
bool create_directory(const std::string& path);

/**
 * @brief Ensure a directory exists, throw on failure
 * @param path Path to ensure
 * @throws std::runtime_error if directory cannot be created
 */
void ensure_directory(const std::string& path);

// ============================================================================
// Signal Handling
// ============================================================================

/**
 * @brief Callback type for shutdown signals
 */
using ShutdownCallback = std::function<void(bool force)>;

/**
 * @brief Set up signal handlers for graceful shutdown
 * @param callback Function to call when shutdown signal is received
 *
 * On Unix: Handles SIGINT and SIGTERM
 * On Windows: Handles CTRL+C and CTRL+BREAK via SetConsoleCtrlHandler
 *
 * The callback receives 'force=true' on second signal (force quit)
 */
void setup_signal_handlers(ShutdownCallback callback);

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * @brief Get the path separator for the current platform
 * @return "/" on Unix, "\\" on Windows
 */
constexpr char path_separator() {
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
std::string path_join(const std::string& base, const std::string& component);

}  // namespace vayu::platform
