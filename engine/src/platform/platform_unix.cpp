/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file platform_unix.cpp
 * @brief Unix/macOS/Linux platform implementations
 */

#include "vayu/platform/platform.hpp"

#if !VAYU_PLATFORM_WINDOWS

#include <fcntl.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#if VAYU_PLATFORM_MACOS
#include <mach/mach_init.h>
#include <mach/mach_time.h>
#include <mach/thread_act.h>
#include <mach/thread_policy.h>
#else
#include <sched.h>
#endif

#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <ctime>
#include <fstream>
#include <sstream>
#include <stdexcept>

#include "vayu/utils/reentrant.hpp"

namespace vayu::platform {

// ============================================================================
// Process Management
// ============================================================================

int get_process_id () {
    return static_cast<int> (getpid ());
}

bool is_process_running (int pid) {
    // Send signal 0 to check if process exists
    // This doesn't actually send a signal, just checks if the process exists
    if (kill (pid, 0) == 0) {
        return true;
    }
    // If errno is ESRCH, process doesn't exist
    // If errno is EPERM, process exists but we don't have permission (still running)
    return errno == EPERM;
}

// ============================================================================
// File Locking
// ============================================================================

bool acquire_file_lock (const std::string& path, LockHandle& handle) {
    // Open or create the lock file
    // Note: On Unix, file locks (flock) are automatically released when the process terminates
    // (even if it crashes or is killed), so stale locks are not a concern.
    // POSIX declares `open` variadic so the mode argument can be omitted when
    // O_CREAT is not passed; with O_CREAT it is required. There is no
    // non-variadic spelling to move to - `std::fopen` cannot express the flags
    // `flock` below needs a descriptor for.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-vararg)
    handle = open (path.c_str (), O_RDWR | O_CREAT, 0666);
    if (handle < 0) {
        return false;
    }

    // Try to acquire exclusive lock (non-blocking)
    if (flock (handle, LOCK_EX | LOCK_NB) < 0) {
        close (handle);
        handle = INVALID_LOCK_HANDLE;
        return false;
    }

    return true;
}

bool write_pid_to_lock (LockHandle handle) {
    if (handle == INVALID_LOCK_HANDLE) {
        return false;
    }

    // Truncate the file
    if (ftruncate (handle, 0) == -1) {
        return false;
    }

    // Write PID
    std::string pid = std::to_string (get_process_id ()) + "\n";
    ssize_t written = write (handle, pid.c_str (), pid.length ());

    // Sync to ensure data is written to disk
    if (written == static_cast<ssize_t> (pid.length ())) {
        fsync (handle);
    }

    return written == static_cast<ssize_t> (pid.length ());
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
        flock (handle, LOCK_UN);
        close (handle);
        handle = INVALID_LOCK_HANDLE;
    }
}

// ============================================================================
// Directory Operations
// ============================================================================

bool is_directory (const std::string& path) {
    struct stat st{};
    if (stat (path.c_str (), &st) != 0) {
        return false;
    }
    return S_ISDIR (st.st_mode);
}

bool create_directory (const std::string& path) {
    if (mkdir (path.c_str (), 0755) == 0) {
        return true;
    }
    // Check if it already exists as a directory
    if (errno == EEXIST && is_directory (path)) {
        return true;
    }
    return false;
}

void ensure_directory (const std::string& path) {
    struct stat st{};
    if (stat (path.c_str (), &st) != 0) {
        // Directory doesn't exist, create it
        if (mkdir (path.c_str (), 0755) != 0 && errno != EEXIST) {
            throw std::runtime_error ("Failed to create directory: " + path +
            " - " + vayu::utils::errno_message (errno));
        }
    } else if (!S_ISDIR (st.st_mode)) {
        throw std::runtime_error ("Path exists but is not a directory: " + path);
    }
}

// ============================================================================
// Signal Handling
// ============================================================================

namespace {
std::atomic<bool> g_shutdown_requested{ false };
ShutdownCallback g_shutdown_callback;

void unix_signal_handler (int signal) {
    if (signal == SIGINT || signal == SIGTERM) {
        bool force = g_shutdown_requested.load ();
        g_shutdown_requested.store (true);
        if (g_shutdown_callback) {
            g_shutdown_callback (force);
        }
    }
}
} // namespace

void setup_signal_handlers (ShutdownCallback callback) {
    g_shutdown_callback = std::move (callback);
    g_shutdown_requested.store (false);

    // Two returns discarded on purpose (`cert-err33-c`), and they are different
    // discards. The previous handler goes because the daemon owns both signals
    // for the process lifetime and has nothing to chain to. `SIG_ERR` goes
    // because POSIX only produces it here for a signal that cannot be caught -
    // `SIGKILL` and `SIGSTOP` - and neither of these is one; there is also
    // nowhere to report it to, since this layer deliberately has no logger.
    static_cast<void> (std::signal (SIGINT, unix_signal_handler));
    static_cast<void> (std::signal (SIGTERM, unix_signal_handler));
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

    char sep          = path_separator ();
    bool base_has_sep = (base.back () == sep || base.back () == '/');
    bool comp_has_sep = (component.front () == sep || component.front () == '/');

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

// ============================================================================
// Thread Scheduling
// ============================================================================

namespace {
/// Logical CPUs the OS currently reports online, or 0 if the call fails.
/// Shared by the affinity bound check on both platforms below: macOS's
/// `thread_policy_set (THREAD_AFFINITY_POLICY)` is a hint the kernel never
/// refuses for an out-of-range tag, so the out-of-range case has to be caught
/// here rather than read off the OS call's own return value.
long online_cpu_count () {
    long count = sysconf (_SC_NPROCESSORS_ONLN);
    return count > 0 ? count : 0;
}
} // namespace

#if VAYU_PLATFORM_MACOS

bool pin_current_thread (unsigned cpu_index) {
    if (static_cast<long> (cpu_index) >= online_cpu_count ()) {
        return false;
    }
    // Darwin has no Linux-style CPU-mask affinity syscall. THREAD_AFFINITY_POLICY
    // only tags the thread: the kernel groups same-tagged threads onto one core
    // when it finds that convenient and does nothing guaranteed on Apple Silicon
    // - the "best-effort hint, not a hard pin" the header doc comment promises.
    thread_affinity_policy_data_t policy{ static_cast<integer_t> (cpu_index) };
    const thread_port_t self = mach_thread_self ();
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast) - mach's own API shape
    const kern_return_t result = thread_policy_set (self, THREAD_AFFINITY_POLICY,
    reinterpret_cast<thread_policy_t> (&policy), THREAD_AFFINITY_POLICY_COUNT);
    // mach_thread_self() hands back an owned send right (unlike pthread_self());
    // the caller is documented to give it back.
    mach_port_deallocate (mach_task_self (), self);
    return result == KERN_SUCCESS;
}

bool raise_current_thread_priority () {
    // THREAD_PRECEDENCE_POLICY, not THREAD_TIME_CONSTRAINT_POLICY: the latter is
    // Darwin's realtime class, declined for the same reason Linux never reaches
    // for SCHED_FIFO - see the doc comment in platform.hpp.
    thread_precedence_policy_data_t policy{ 10 };
    const thread_port_t self = mach_thread_self ();
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast) - mach's own API shape
    const kern_return_t result = thread_policy_set (self, THREAD_PRECEDENCE_POLICY,
    reinterpret_cast<thread_policy_t> (&policy), THREAD_PRECEDENCE_POLICY_COUNT);
    mach_port_deallocate (mach_task_self (), self);
    return result == KERN_SUCCESS;
}

void sleep_until_precise (std::chrono::steady_clock::time_point deadline) {
    const auto now = std::chrono::steady_clock::now ();
    if (deadline <= now) {
        return;
    }
    // mach_absolute_time() ticks are not nanoseconds; the timebase is the
    // fixed numer/denom fraction that converts between them, queried once
    // (function-local static, never at namespace scope) and reused for every
    // call after.
    static const mach_timebase_info_data_t timebase = [] {
        mach_timebase_info_data_t info{};
        mach_timebase_info (&info);
        return info;
    }();
    const auto ns_remaining =
    std::chrono::duration_cast<std::chrono::nanoseconds> (deadline - now).count ();
    const uint64_t ticks_remaining =
    static_cast<uint64_t> (ns_remaining) * timebase.denom / timebase.numer;
    mach_wait_until (mach_absolute_time () + ticks_remaining);
}

#else // Linux

bool pin_current_thread (unsigned cpu_index) {
    if (cpu_index >= static_cast<unsigned> (CPU_SETSIZE) ||
    static_cast<long> (cpu_index) >= online_cpu_count ()) {
        return false;
    }
    cpu_set_t set{};
    CPU_ZERO (&set);
    // CPU_SET's own macro expansion indexes with size_t, so an int argument
    // (the parameter type its glibc prototype comment describes) still
    // converts under -Wsign-conversion; give it the size_t the expansion
    // wants directly.
    CPU_SET (static_cast<size_t> (cpu_index), &set);
    return sched_setaffinity (0, sizeof (set), &set) == 0;
}

bool raise_current_thread_priority () {
    // A `nice` adjustment only, never SCHED_FIFO/SCHED_RR - see the doc comment
    // in platform.hpp. `PRIO_PROCESS` with pid 0 targets the calling thread's
    // own kernel-visible id (Linux implements threads as schedulable entities
    // with their own priority), not the whole process. Usually refused without
    // CAP_SYS_NICE, which is exactly the "best-effort" the caller expects.
    return setpriority (PRIO_PROCESS, 0, -5) == 0;
}

void sleep_until_precise (std::chrono::steady_clock::time_point deadline) {
    const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds> (
    deadline.time_since_epoch ())
                    .count ();
    struct timespec ts{};
    ts.tv_sec  = static_cast<time_t> (ns / 1'000'000'000LL);
    ts.tv_nsec = static_cast<long> (ns % 1'000'000'000LL);
    // Absolute against CLOCK_MONOTONIC, not sleep_for's relative form: a
    // relative sleep's duration is computed before the call and does not
    // account for the time spent computing it, so it always oversleeps by a
    // little; TIMER_ABSTIME sleeps to a timestamp instead. Retried on EINTR -
    // a delivered signal must not shorten the wait to whatever elapsed before
    // it arrived.
    while (clock_nanosleep (CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, nullptr) == EINTR) {
    }
}

#endif // VAYU_PLATFORM_MACOS

} // namespace vayu::platform

#endif // !VAYU_PLATFORM_WINDOWS
