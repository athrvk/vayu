/**
 * @file platform_unix.cpp
 * @brief Unix/macOS/Linux platform implementations
 */

#include "vayu/platform/platform.hpp"

#if !VAYU_PLATFORM_WINDOWS

#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <csignal>
#include <cstring>
#include <stdexcept>

namespace vayu::platform {

// ============================================================================
// Process Management
// ============================================================================

int get_process_id() {
    return static_cast<int>(getpid());
}

// ============================================================================
// File Locking
// ============================================================================

bool acquire_file_lock(const std::string& path, LockHandle& handle) {
    handle = open(path.c_str(), O_RDWR | O_CREAT, 0666);
    if (handle < 0) {
        return false;
    }

    if (flock(handle, LOCK_EX | LOCK_NB) < 0) {
        close(handle);
        handle = INVALID_LOCK_HANDLE;
        return false;
    }

    return true;
}

bool write_pid_to_lock(LockHandle handle) {
    if (handle == INVALID_LOCK_HANDLE) {
        return false;
    }

    // Truncate the file
    if (ftruncate(handle, 0) == -1) {
        return false;
    }

    // Write PID
    std::string pid = std::to_string(get_process_id()) + "\n";
    ssize_t written = write(handle, pid.c_str(), pid.length());
    return written == static_cast<ssize_t>(pid.length());
}

void release_file_lock(LockHandle& handle) {
    if (handle != INVALID_LOCK_HANDLE) {
        flock(handle, LOCK_UN);
        close(handle);
        handle = INVALID_LOCK_HANDLE;
    }
}

// ============================================================================
// Directory Operations
// ============================================================================

bool is_directory(const std::string& path) {
    struct stat st;
    if (stat(path.c_str(), &st) != 0) {
        return false;
    }
    return S_ISDIR(st.st_mode);
}

bool create_directory(const std::string& path) {
    if (mkdir(path.c_str(), 0755) == 0) {
        return true;
    }
    // Check if it already exists as a directory
    if (errno == EEXIST && is_directory(path)) {
        return true;
    }
    return false;
}

void ensure_directory(const std::string& path) {
    struct stat st;
    if (stat(path.c_str(), &st) != 0) {
        // Directory doesn't exist, create it
        if (mkdir(path.c_str(), 0755) != 0 && errno != EEXIST) {
            throw std::runtime_error("Failed to create directory: " + path + " - " +
                                     strerror(errno));
        }
    } else if (!S_ISDIR(st.st_mode)) {
        throw std::runtime_error("Path exists but is not a directory: " + path);
    }
}

// ============================================================================
// Signal Handling
// ============================================================================

namespace {
std::atomic<bool> g_shutdown_requested{false};
ShutdownCallback g_shutdown_callback;

void unix_signal_handler(int signal) {
    if (signal == SIGINT || signal == SIGTERM) {
        bool force = g_shutdown_requested.load();
        g_shutdown_requested.store(true);
        if (g_shutdown_callback) {
            g_shutdown_callback(force);
        }
    }
}
}  // namespace

void setup_signal_handlers(ShutdownCallback callback) {
    g_shutdown_callback = std::move(callback);
    g_shutdown_requested.store(false);

    std::signal(SIGINT, unix_signal_handler);
    std::signal(SIGTERM, unix_signal_handler);
}

// ============================================================================
// Path Utilities
// ============================================================================

std::string path_join(const std::string& base, const std::string& component) {
    if (base.empty()) {
        return component;
    }
    if (component.empty()) {
        return base;
    }

    char sep = path_separator();
    bool base_has_sep = (base.back() == sep || base.back() == '/');
    bool comp_has_sep = (component.front() == sep || component.front() == '/');

    if (base_has_sep && comp_has_sep) {
        return base + component.substr(1);
    } else if (base_has_sep || comp_has_sep) {
        return base + component;
    } else {
        return base + sep + component;
    }
}

}  // namespace vayu::platform

#endif  // !VAYU_PLATFORM_WINDOWS
