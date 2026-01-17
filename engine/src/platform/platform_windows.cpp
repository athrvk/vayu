/**
 * @file platform_windows.cpp
 * @brief Windows platform implementations
 */

#include "vayu/platform/platform.hpp"

#if VAYU_PLATFORM_WINDOWS

// Windows headers - must be included before other headers
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <direct.h>
#include <io.h>
#include <process.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <windows.h>

#include <atomic>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>

namespace vayu::platform {

// ============================================================================
// Process Management
// ============================================================================

int get_process_id() {
    return static_cast<int>(GetCurrentProcessId());
}

bool is_process_running(int pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
    if (process == nullptr) {
        return false;
    }
    
    DWORD exit_code = 0;
    bool is_running = true;
    if (GetExitCodeProcess(process, &exit_code)) {
        // If exit code is STILL_ACTIVE (259), process is still running
        is_running = (exit_code == STILL_ACTIVE);
    } else {
        is_running = false;
    }
    
    CloseHandle(process);
    return is_running;
}

// ============================================================================
// File Locking
// ============================================================================

bool acquire_file_lock(const std::string& path, LockHandle& handle) {
    // Create or open the lock file
    // Note: On Windows, file locks are automatically released when the process terminates
    // (even if it crashes or is killed), so stale locks are not a concern.
    handle = CreateFileA(path.c_str(),
                         GENERIC_READ | GENERIC_WRITE,
                         0,  // No sharing - exclusive access
                         nullptr,
                         OPEN_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL,
                         nullptr);

    if (handle == INVALID_HANDLE_VALUE) {
        handle = INVALID_LOCK_HANDLE;
        return false;
    }

    // Try to lock the file (non-blocking)
    // Lock the first byte of the file to prevent other processes from acquiring it
    OVERLAPPED overlapped = {0};
    if (!LockFileEx(
            handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)) {
        CloseHandle(handle);
        handle = INVALID_LOCK_HANDLE;
        return false;
    }

    return true;
}

bool write_pid_to_lock(LockHandle handle) {
    if (handle == INVALID_LOCK_HANDLE) {
        return false;
    }

    // Truncate the file by setting file pointer to beginning and setting end of file
    SetFilePointer(handle, 0, nullptr, FILE_BEGIN);
    SetEndOfFile(handle);

    // Write PID
    std::string pid = std::to_string(get_process_id()) + "\n";
    DWORD written = 0;
    if (!WriteFile(handle, pid.c_str(), static_cast<DWORD>(pid.length()), &written, nullptr)) {
        return false;
    }

    // Flush to ensure data is written
    FlushFileBuffers(handle);

    return written == static_cast<DWORD>(pid.length());
}

bool read_pid_from_lock(const std::string& path, int& pid) {
    std::ifstream file(path);
    if (!file.is_open()) {
        return false;
    }

    std::string line;
    if (!std::getline(file, line)) {
        return false;
    }

    try {
        pid = std::stoi(line);
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

void release_file_lock(LockHandle& handle) {
    if (handle != INVALID_LOCK_HANDLE) {
        // Unlock the file
        OVERLAPPED overlapped = {0};
        UnlockFileEx(handle, 0, 1, 0, &overlapped);
        CloseHandle(handle);
        handle = INVALID_LOCK_HANDLE;
    }
}

// ============================================================================
// Directory Operations
// ============================================================================

bool is_directory(const std::string& path) {
    DWORD attribs = GetFileAttributesA(path.c_str());
    if (attribs == INVALID_FILE_ATTRIBUTES) {
        return false;
    }
    return (attribs & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool create_directory(const std::string& path) {
    if (CreateDirectoryA(path.c_str(), nullptr)) {
        return true;
    }
    // Check if it already exists as a directory
    DWORD error = GetLastError();
    if (error == ERROR_ALREADY_EXISTS && is_directory(path)) {
        return true;
    }
    return false;
}

void ensure_directory(const std::string& path) {
    DWORD attribs = GetFileAttributesA(path.c_str());
    if (attribs == INVALID_FILE_ATTRIBUTES) {
        // Directory doesn't exist, create it
        if (!CreateDirectoryA(path.c_str(), nullptr)) {
            DWORD error = GetLastError();
            if (error != ERROR_ALREADY_EXISTS) {
                throw std::runtime_error("Failed to create directory: " + path + " - error code " +
                                         std::to_string(error));
            }
        }
    } else if ((attribs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        throw std::runtime_error("Path exists but is not a directory: " + path);
    }
}

// ============================================================================
// Signal Handling
// ============================================================================

namespace {
std::atomic<bool> g_shutdown_requested{false};
ShutdownCallback g_shutdown_callback;

BOOL WINAPI windows_ctrl_handler(DWORD ctrl_type) {
    switch (ctrl_type) {
        case CTRL_C_EVENT:
        case CTRL_BREAK_EVENT:
        case CTRL_CLOSE_EVENT:
        case CTRL_SHUTDOWN_EVENT: {
            bool force = g_shutdown_requested.load();
            g_shutdown_requested.store(true);
            if (g_shutdown_callback) {
                g_shutdown_callback(force);
            }
            // Return TRUE to indicate we handled it
            // For CTRL_CLOSE_EVENT and CTRL_SHUTDOWN_EVENT, we have limited time
            return TRUE;
        }
        default:
            return FALSE;
    }
}
}  // namespace

void setup_signal_handlers(ShutdownCallback callback) {
    g_shutdown_callback = std::move(callback);
    g_shutdown_requested.store(false);

    SetConsoleCtrlHandler(windows_ctrl_handler, TRUE);
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
    bool base_has_sep = (base.back() == sep || base.back() == '/' || base.back() == '\\');
    bool comp_has_sep =
        (component.front() == sep || component.front() == '/' || component.front() == '\\');

    if (base_has_sep && comp_has_sep) {
        return base + component.substr(1);
    } else if (base_has_sep || comp_has_sep) {
        return base + component;
    } else {
        return base + sep + component;
    }
}

}  // namespace vayu::platform

#endif  // VAYU_PLATFORM_WINDOWS
