/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

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

#include <sddl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

namespace vayu::platform {

// ============================================================================
// Process Management
// ============================================================================

int get_process_id () {
    return static_cast<int> (GetCurrentProcessId ());
}

bool is_process_running (int pid) {
    HANDLE process = OpenProcess (
    PROCESS_QUERY_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD> (pid));
    if (process == nullptr) {
        return false;
    }

    DWORD exit_code = 0;
    bool is_running = true;
    if (GetExitCodeProcess (process, &exit_code)) {
        // If exit code is STILL_ACTIVE (259), process is still running
        is_running = (exit_code == STILL_ACTIVE);
    } else {
        is_running = false;
    }

    CloseHandle (process);
    return is_running;
}

// ============================================================================
// File Locking
// ============================================================================

LockAcquisition acquire_file_lock (const std::string& path, LockHandle& handle) {
    // Create or open the lock file
    // Note: On Windows, file locks are automatically released when the process terminates
    // (even if it crashes or is killed), so stale locks are not a concern.
    // Share mode 0 is also what keeps the file from being deleted while held,
    // so the guard cannot be bypassed the way a POSIX file lock can (issue #2422).
    handle = CreateFileA (path.c_str (), GENERIC_READ | GENERIC_WRITE,
    0, // No sharing - exclusive access
    nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);

    if (handle == INVALID_HANDLE_VALUE) {
        handle = INVALID_LOCK_HANDLE;
        return LockAcquisition::Refused;
    }

    // Try to lock the file (non-blocking)
    // Lock the first byte of the file to prevent other processes from acquiring it
    OVERLAPPED overlapped = {};
    if (!LockFileEx (handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
        0, 1, 0, &overlapped)) {
        CloseHandle (handle);
        handle = INVALID_LOCK_HANDLE;
        return LockAcquisition::Refused;
    }

    return LockAcquisition::Held;
}

bool write_pid_to_lock (LockHandle handle) {
    if (handle == INVALID_LOCK_HANDLE) {
        return false;
    }

    // Truncate the file by setting file pointer to beginning and setting end of file
    SetFilePointer (handle, 0, nullptr, FILE_BEGIN);
    SetEndOfFile (handle);

    // Write PID
    std::string pid = std::to_string (get_process_id ()) + "\n";
    DWORD written   = 0;
    if (!WriteFile (handle, pid.c_str (), static_cast<DWORD> (pid.length ()),
        &written, nullptr)) {
        return false;
    }

    // Flush to ensure data is written
    FlushFileBuffers (handle);

    return written == static_cast<DWORD> (pid.length ());
}

bool read_pid_from_lock (const std::string& path, int& pid) {
    std::ifstream file (path);
    if (!file.is_open ()) {
        return false;
    }

    std::string line;
    if (!std::getline (file, line)) {
        return false;
    }

    try {
        pid = std::stoi (line);
        return true;
    } catch (const std::exception&) {
        return false;
    }
}

void release_file_lock (LockHandle& handle) {
    if (handle != INVALID_LOCK_HANDLE) {
        // Unlock the file
        OVERLAPPED overlapped = {};
        UnlockFileEx (handle, 0, 1, 0, &overlapped);
        CloseHandle (handle);
        handle = INVALID_LOCK_HANDLE;
    }
}

// ============================================================================
// Directory Operations
// ============================================================================

bool is_directory (const std::string& path) {
    DWORD attribs = GetFileAttributesA (path.c_str ());
    if (attribs == INVALID_FILE_ATTRIBUTES) {
        return false;
    }
    return (attribs & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

bool create_directory (const std::string& path) {
    if (CreateDirectoryA (path.c_str (), nullptr)) {
        return true;
    }
    // Check if it already exists as a directory
    DWORD error = GetLastError ();
    return error == ERROR_ALREADY_EXISTS && is_directory (path);
}

void ensure_directory (const std::string& path) {
    DWORD attribs = GetFileAttributesA (path.c_str ());
    if (attribs == INVALID_FILE_ATTRIBUTES) {
        // Directory doesn't exist, create it
        if (!CreateDirectoryA (path.c_str (), nullptr)) {
            DWORD error = GetLastError ();
            if (error != ERROR_ALREADY_EXISTS) {
                throw std::runtime_error ("Failed to create directory: " + path +
                " - error code " + std::to_string (error));
            }
        }
    } else if ((attribs & FILE_ATTRIBUTE_DIRECTORY) == 0) {
        throw std::runtime_error ("Path exists but is not a directory: " + path);
    }
}

void ensure_private_directory (const std::string& path) {
    ensure_directory (path);
    // Protected (no inherited ACEs), then owner / SYSTEM / Administrators,
    // inheritable by files and subdirectories created inside.
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorA (
        "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", SDDL_REVISION_1,
        &descriptor, nullptr)) {
        throw std::runtime_error ("Failed to build the directory ACL for: " + path +
        " - error code " + std::to_string (GetLastError ()));
    }
    const BOOL applied = SetFileSecurityA (path.c_str (),
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, descriptor);
    const DWORD error  = GetLastError ();
    LocalFree (descriptor);
    if (!applied) {
        throw std::runtime_error ("Failed to restrict directory: " + path +
        " - error code " + std::to_string (error));
    }
}

bool fsync_file (const std::string& path) {
    // Wide, like the rename this precedes: `std::filesystem` reads a narrow
    // path through the same code page, so both name the same file. Every share
    // flag, so an antivirus scan or an indexer holding the file open does not
    // fail the flush.
    const HANDLE file = CreateFileW (std::filesystem::path (path).c_str (),
    GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    const bool flushed = FlushFileBuffers (file) != 0;
    CloseHandle (file);
    return flushed;
}

bool fsync_directory (const std::string& path) {
    // Windows offers no way to flush a directory handle, so there is nothing
    // to do beyond confirming the argument; `replace_file_durably` is what
    // makes a rename survive a power loss here.
    return is_directory (path);
}

FileReplacement replace_file_durably (const std::string& from, const std::string& to) {
    FileReplacement replacement;
    // WRITE_THROUGH returns once the move has reached the disk, which stands
    // in for the directory flush POSIX needs.
    if (MoveFileExW (std::filesystem::path (from).c_str (),
        std::filesystem::path (to).c_str (),
        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0) {
        replacement.error = std::error_code (
        static_cast<int> (GetLastError ()), std::system_category ());
        return replacement;
    }
    replacement.durable = true;
    return replacement;
}

namespace {
std::error_code last_error () {
    return { static_cast<int> (GetLastError ()), std::system_category () };
}
} // namespace

std::expected<OpenedFile, std::error_code> open_regular_file (
const std::filesystem::path& path) {
    // No FILE_FLAG_BACKUP_SEMANTICS, so a directory fails to open here; a
    // device or a pipe opens and is refused by its type below. Sharing delete
    // as well lets the file be moved or removed while a run holds it, as on
    // POSIX.
    HANDLE file = CreateFileW (path.c_str (), GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return std::unexpected (last_error ());
    }
    LARGE_INTEGER size{};
    if (GetFileType (file) != FILE_TYPE_DISK || GetFileSizeEx (file, &size) == 0) {
        CloseHandle (file);
        return std::unexpected (std::make_error_code (std::errc::invalid_argument));
    }
    return OpenedFile{ file, static_cast<std::uint64_t> (size.QuadPart) };
}

std::expected<std::size_t, std::error_code>
read_file_at (ReadOnlyFile file, std::uint64_t offset, std::span<char> buffer) {
    // An OVERLAPPED on a synchronous handle is a positional read: it starts at
    // the offset it names and returns once the read completes.
    OVERLAPPED at{};
    // NOLINTBEGIN(cppcoreguidelines-pro-type-union-access) - Win32 declares the offset fields inside an anonymous union
    at.Offset     = static_cast<DWORD> (offset & 0xFFFFFFFFULL);
    at.OffsetHigh = static_cast<DWORD> (offset >> 32U);
    // NOLINTEND(cppcoreguidelines-pro-type-union-access)
    const auto wanted = static_cast<DWORD> (
    std::min<std::size_t> (buffer.size (), std::numeric_limits<DWORD>::max ()));
    DWORD got = 0;
    if (ReadFile (file, buffer.data (), wanted, &got, &at) == 0) {
        if (GetLastError () == ERROR_HANDLE_EOF) {
            return 0;
        }
        return std::unexpected (last_error ());
    }
    return static_cast<std::size_t> (got);
}

void close_file (ReadOnlyFile file) {
    if (file != INVALID_READ_ONLY_FILE) {
        CloseHandle (file);
    }
}

void restrict_new_files_to_owner () {
    // Nothing to set: new files take the private directory's inherited DACL.
}

void prepare_data_directory (const std::string& data_dir) {
    restrict_new_files_to_owner ();
    ensure_private_directory (data_dir);
    ensure_private_directory (path_join (data_dir, "logs"));
    ensure_private_directory (path_join (data_dir, "db"));
    // No pass over existing files: mode bits do not exist here, the DACL is set
    // per directory, and `SetFileSecurity` does not rewrite the DACL of a file
    // already inside it. Files created from now on inherit it.
}

// ============================================================================
// Signal Handling
// ============================================================================

namespace {
std::atomic<bool> g_shutdown_requested{ false };
ShutdownCallback g_shutdown_callback;

BOOL WINAPI windows_ctrl_handler (DWORD ctrl_type) {
    switch (ctrl_type) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_SHUTDOWN_EVENT: {
        bool force = g_shutdown_requested.load ();
        g_shutdown_requested.store (true);
        if (g_shutdown_callback) {
            g_shutdown_callback (force);
        }
        // Return TRUE to indicate we handled it
        // For CTRL_CLOSE_EVENT and CTRL_SHUTDOWN_EVENT, we have limited time
        return TRUE;
    }
    default: return FALSE;
    }
}
} // namespace

void setup_signal_handlers (ShutdownCallback callback) {
    g_shutdown_callback = std::move (callback);
    g_shutdown_requested.store (false);

    SetConsoleCtrlHandler (windows_ctrl_handler, TRUE);
}

// ============================================================================
// Path Utilities
// ============================================================================

std::string path_join (const std::string& base, const std::string& component) {
    if (base.empty ()) {
        return component;
    }
    if (component.empty ()) {
        return base;
    }

    char sep = path_separator ();
    bool base_has_sep =
    (base.back () == sep || base.back () == '/' || base.back () == '\\');
    bool comp_has_sep = (component.front () == sep ||
    component.front () == '/' || component.front () == '\\');

    if (base_has_sep && comp_has_sep) {
        return base + component.substr (1);
    } else if (base_has_sep || comp_has_sep) {
        return base + component;
    } else {
        return base + sep + component;
    }
}

std::string default_data_dir () {
    return path_join (".", "data");
}

std::string home_directory () {
    const DWORD needed = GetEnvironmentVariableW (L"USERPROFILE", nullptr, 0);
    if (needed == 0) {
        return {};
    }
    std::vector<wchar_t> buffer (needed);
    const DWORD written = GetEnvironmentVariableW (L"USERPROFILE", buffer.data (), needed);
    if (written == 0 || written >= needed) {
        return {};
    }
    // The narrow spelling every other path in the engine is held in, so
    // `canonical_root_path` compares this with a stored root like for like. A
    // profile path that spelling cannot hold is answered as unknown: no root
    // under it could be stored in that spelling either.
    try {
        return std::filesystem::path (std::wstring (buffer.data (), written)).string ();
    } catch (const std::system_error&) {
        return {};
    }
}

// The 1 ms timer request used to live here, held for the process' whole life.
// It is `HighResolutionTimerScope` in high_resolution_timer.cpp now, taken by
// each run and released with it (issue #1161).

// ============================================================================
// Thread Scheduling
// ============================================================================

bool pin_current_thread (unsigned cpu_index) {
    // A shift past the mask's own width is undefined behaviour; DWORD_PTR is
    // 32 bits on a 32-bit build and 64 on a 64-bit one; there is no group
    // affinity here (that would need SetThreadGroupAffinity for a system with
    // more logical CPUs than one mask can name), matching the single-mask
    // Linux/macOS pinning this function offers everywhere else.
    if (cpu_index >= sizeof (DWORD_PTR) * 8) {
        return false;
    }
    const DWORD_PTR mask = static_cast<DWORD_PTR> (1) << cpu_index;
    // Returns the previous affinity mask on success, 0 on failure - never a
    // value this call would want to interpret, only whether it is zero.
    return SetThreadAffinityMask (GetCurrentThread (), mask) != 0;
}

bool raise_current_thread_priority () {
    return SetThreadPriority (GetCurrentThread (), THREAD_PRIORITY_ABOVE_NORMAL) != 0;
}

void sleep_until_precise (std::chrono::steady_clock::time_point deadline) {
    // No Windows equivalent of clock_nanosleep/mach_wait_until at this layer;
    // the precision problem here is solved separately - HighResolutionTimerScope
    // plus the caller's own spin tail (see wait_for_next_tick in
    // load_strategy.cpp) - so this is deliberately sleep_for's ordinary
    // relative form, not a Windows-specific precision path.
    const auto now = std::chrono::steady_clock::now ();
    if (deadline > now) {
        std::this_thread::sleep_for (deadline - now);
    }
}

bool return_large_frees_to_os (std::size_t /*min_bytes*/) {
    // The CRT's heap already gives a large block its own allocation, released
    // when it is freed (see platform.hpp).
    return true;
}

void release_free_heap () {
    // The CRT heap decommits free pages past its own threshold, and there is
    // no call that returns more (see platform.hpp).
}

} // namespace vayu::platform

#endif // VAYU_PLATFORM_WINDOWS
