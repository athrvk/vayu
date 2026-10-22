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

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <functional>
#include <span>
#include <string>
#include <system_error>

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
 * @brief Opaque handle type for the single-instance lock
 * On Windows: the lock file's HANDLE. On POSIX: two descriptors, the
 * directory holding the lock file (the guard) and the lock file itself (the
 * PID record); `directory` is -1 when the lock is `LockAcquisition::FileOnly`.
 */
#if VAYU_PLATFORM_WINDOWS
using LockHandle                         = void*;
constexpr LockHandle INVALID_LOCK_HANDLE = nullptr;
#else
struct LockHandle {
    int directory = -1;
    int file      = -1;

    bool operator== (const LockHandle&) const = default;
};
constexpr LockHandle INVALID_LOCK_HANDLE{};
#endif

/// What `acquire_file_lock` holds when it returns.
enum class LockAcquisition : std::uint8_t {
    /// Nothing: another holder has it, or a path could not be opened.
    Refused,
    /// The full guard. Deleting the lock file does not release it.
    Held,
    /// POSIX only: the filesystem refused to lock the directory (`ENOTSUP`,
    /// `EINVAL`, some network volumes), so only the lock file is locked and
    /// unlinking it would let a second holder in.
    FileOnly,
};

/**
 * @brief Acquire the exclusive, non-blocking single-instance lock
 * @param path Path to the lock file, created if it does not exist
 * @param handle Output parameter for the lock handle, invalid unless held
 * @return What is held; `Refused` leaves nothing open
 *
 * POSIX: `flock` on the directory containing @p path, then on the file. The
 * guard has to be the directory (issue #2422): a `flock` lives on an inode, so
 * once something unlinks the file, a newcomer's `O_CREAT` makes a new inode
 * whose lock is free. Re-checking the path's inode after locking would not
 * help, because only the holder could run that check, never the newcomer. The
 * file is still locked so an engine older than the directory lock, which takes
 * only the file, and this one exclude each other. Windows: the file is opened
 * with share mode 0, so it cannot be deleted while held, and byte-locked.
 */
[[nodiscard]] LockAcquisition acquire_file_lock (const std::string& path, LockHandle& handle);

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
 * @brief Release a previously acquired file lock, the file before the
 *        directory on POSIX
 * @param handle Lock handle from acquire_file_lock, invalid afterwards
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

/**
 * @brief Ensure a directory exists and only its owner can enter it
 *
 * The data directory holds secrets in plaintext (variables, tokens, run
 * history), so it is created owner-only and a directory an older engine left
 * open is tightened. POSIX: mode 0700. Windows: a protected DACL granting the
 * owner, SYSTEM and Administrators, inherited by what is created inside.
 * @param path Path to ensure
 * @throws std::runtime_error if the directory cannot be created or restricted
 */
void ensure_private_directory (const std::string& path);

/**
 * @brief Make every file this process creates from here on owner-only
 *
 * POSIX: `umask (077)`, so the database, its `-wal`/`-shm`, the `.bak` and
 * backup copies and the logs are 0600 whichever library opens them. Windows:
 * a no-op, the private directory's inherited DACL is what protects new files.
 * Call once at startup, before the first file is created.
 */
void restrict_new_files_to_owner ();

/**
 * @brief Make the data directory and what the engine keeps in it owner-only
 *
 * The whole of the daemon's data-layout setup, in one call so a test can make
 * it: `restrict_new_files_to_owner`, then `ensure_private_directory` for
 * @p data_dir (whatever `--data-dir` names - it is chmod'd 0700), `logs` and
 * `db`, then, on POSIX, a pass over the files an older engine left open. The
 * pass tightens to 0600 any file wider than that among `vayu.lock`, the
 * regular files directly under `db/` (the database, its `-wal` and `-shm`, the
 * `.bak` family, quarantined sets, `ca-bundle.pem`), under `db/backups/` and
 * under `logs/`, and `db/backups` itself to 0700. It is an allowlist and never
 * a walk of @p data_dir, which can be a directory the user keeps other things
 * in; symlinks and non-regular files are skipped; a path it cannot change is
 * skipped without an error. Windows has no file pass: the DACL is per
 * directory and files created from now on inherit it.
 *
 * Call once at startup, before the database opens or the logger writes.
 * @param data_dir The data directory
 * @throws std::runtime_error if a directory cannot be created or restricted
 */
void prepare_data_directory (const std::string& data_dir);

/**
 * @brief Flush a file's contents to stable storage
 * @param path The file to flush
 * @return true when the OS reports the data written out; false when the file
 *         cannot be opened or the flush fails. Never throws.
 *
 * A closed file is not a durable one: until the OS writes its cache out, a
 * power loss can leave a snapshot that was written, validated and renamed into
 * place as a file of zeros. POSIX: `open` + `fsync`. Windows: `CreateFileW` +
 * `FlushFileBuffers`. Call it on the finished file, before it is renamed over
 * the copy it replaces.
 */
[[nodiscard]] bool fsync_file (const std::string& path);

/**
 * @brief Flush a directory's entries (a create, a rename) to stable storage
 * @param path The directory to flush
 * @return true when the entries are flushed or the platform has nothing to
 *         flush; false when @p path is not a directory it can open or the
 *         flush fails. Never throws.
 *
 * A file's own `fsync` does not cover the directory entry that names it, so a
 * file created or renamed into place can still vanish on power loss. POSIX:
 * `open (O_DIRECTORY)` + `fsync`. Windows cannot flush a directory handle, so
 * this only confirms @p path is a directory; the rename there is made
 * durable by `replace_file_durably` instead.
 */
[[nodiscard]] bool fsync_directory (const std::string& path);

/// What `replace_file_durably` did.
struct FileReplacement {
    /// Set when @p to was not replaced; @p from is then untouched.
    std::error_code error;
    /// The replacement happened and is known to be on stable storage. False
    /// beside an empty `error` means the destination was replaced but the
    /// directory could not be flushed: the rename is in effect and may not
    /// survive a power loss.
    bool durable = false;
};

/**
 * @brief Rename @p from over @p to, atomically, and flush the rename
 * @param from The finished, already flushed file
 * @param to The path to replace; an existing file there is replaced
 *
 * One rename, so @p to always names a whole file: the old one until it
 * returns, the new one after. POSIX: `rename`, then `fsync_directory` of
 * @p to's parent (a failed flush cannot undo the rename, so it only clears
 * `durable`). Windows: `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING |
 * MOVEFILE_WRITE_THROUGH`, which returns after the move is on disk.
 */
[[nodiscard]] FileReplacement
replace_file_durably (const std::string& from, const std::string& to);

/// A file opened for positional reads: a descriptor on POSIX, a `HANDLE` on
/// Windows.
#if VAYU_PLATFORM_WINDOWS
using ReadOnlyFile                            = void*;
constexpr ReadOnlyFile INVALID_READ_ONLY_FILE = nullptr;
#else
using ReadOnlyFile                            = int;
constexpr ReadOnlyFile INVALID_READ_ONLY_FILE = -1;
#endif

/// What `open_regular_file` opened; the caller closes it with `close_file`.
struct OpenedFile {
    ReadOnlyFile file  = INVALID_READ_ONLY_FILE;
    std::uint64_t size = 0;
};

/**
 * @brief Open @p path read-only, refusing anything but a regular file
 * @return The open file and its size, or why nothing was opened:
 *         the OS's error, or `std::errc::invalid_argument` when @p path names
 *         something other than a regular file. Never throws.
 *
 * POSIX: `open` with `O_NOFOLLOW`, so a final component that is a symlink is
 * refused (`ELOOP`) rather than followed, and `O_NONBLOCK`, so a FIFO cannot
 * block the open before `fstat` refuses it. Windows: `CreateFileW` sharing
 * read, write and delete, which follows a final reparse point: a cloud
 * placeholder is one, so refusing them would refuse ordinary files.
 */
[[nodiscard]] std::expected<OpenedFile, std::error_code> open_regular_file (
const std::filesystem::path& path);

/**
 * @brief Read up to @p buffer's size from @p file at @p offset
 * @return The bytes read, 0 at the end of the file, or the OS's error.
 *
 * Positional (`pread`, `ReadFile` with an offset): no file position is read or
 * relied on, so any number of threads may read one file at once.
 */
[[nodiscard]] std::expected<std::size_t, std::error_code>
read_file_at (ReadOnlyFile file, std::uint64_t offset, std::span<char> buffer);

/// Close a file `open_regular_file` opened; an invalid one is left alone.
void close_file (ReadOnlyFile file);

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

/**
 * @brief The data directory a binary uses when nothing names one.
 * @return `./data`, adjacent to wherever the binary was started from.
 *
 * Shared by `vayu-engine` and `vayu-cli` (issue #1557) so a log file each
 * writes with no `--data-dir` of its own lands under the same tree, telling
 * `engine_<stamp>.log` and `cli_<stamp>.log` apart by prefix rather than by
 * directory.
 */
std::string default_data_dir ();

/**
 * @brief The current user's home folder, or empty when the platform says
 *        nothing.
 *
 * The account database's entry (`getpwuid_r`) on Linux and macOS, never
 * `HOME`: the engine reads no environment variable but the one
 * `transport_policy.cpp` exempts. `USERPROFILE` through
 * `GetEnvironmentVariableW` on Windows, which reads the process environment
 * block under its own lock rather than the CRT's shared copy.
 */
std::string home_directory ();

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
 *   1 ms wait per iteration and gets ~15.6 ms without this, and the same poll
 *   a rate-limited worker parks in until its next token, as short as 1 ms;
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

// ============================================================================
// Thread Scheduling
// ============================================================================

/**
 * @brief Pin the calling thread to one logical CPU, best-effort.
 * @param cpu_index Zero-based logical CPU index.
 * @return true if the OS accepted the request, false otherwise (never throws).
 *
 * A container or sandboxed dev environment commonly denies this - the caller
 * logs once and continues; a load-testing sidecar that failed to start because
 * it could not pin a thread would be worse than one that paces slightly less
 * precisely.
 */
[[nodiscard]] bool pin_current_thread (unsigned cpu_index);

/**
 * @brief Raise the calling thread's scheduling priority a modest amount, best-effort.
 * @return true if the OS accepted the request, false otherwise (never throws).
 *
 * Deliberately NOT realtime (SCHED_FIFO/SCHED_RR on Linux, THREAD_TIME_CONSTRAINT_POLICY
 * everywhere): this engine shares the machine with the app it is a sidecar for and
 * the target under test, and a realtime thread that misbehaves can starve both.
 * Windows: THREAD_PRIORITY_ABOVE_NORMAL. Linux: a `nice` adjustment only (SCHED_FIFO
 * needs CAP_SYS_NICE, usually absent in a container, and would starve the UI/target
 * on a shared box even when granted). macOS: THREAD_PRECEDENCE_POLICY, not a
 * time-constraint policy (that one really is closer to realtime).
 */
[[nodiscard]] bool raise_current_thread_priority ();

/**
 * @brief Sleep until `deadline`, using the platform's most precise wait primitive.
 * @param deadline An absolute steady_clock time point.
 *
 * Linux: clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, ...) - absolute rather than
 * relative, so it carries no "time already spent computing the duration" error the
 * way sleep_for's relative arithmetic does. macOS: mach_wait_until (no clock_nanosleep
 * there). Windows: falls back to sleep_for's relative form - the precision problem
 * there is solved separately (HighResolutionTimerScope + the caller's own spin tail),
 * not by this function; this exists for Linux/macOS.
 *
 * Never spins and never busy-waits past the deadline itself - a caller wanting a
 * spin tail (see `tick_sleep_leg_us` / `wait_for_next_tick` in `load_strategy.cpp`)
 * calls this for the coarse leg only and spins the remainder itself, exactly as the
 * existing Windows leg already does.
 */
void sleep_until_precise (std::chrono::steady_clock::time_point deadline);

// ============================================================================
// Memory
// ============================================================================

/**
 * @brief Give every heap block of at least @p min_bytes a mapping of its own,
 *        returned to the OS when it is freed.
 * @return false when the C library refused the setting (the default stays).
 *
 * glibc's malloc raises its mmap threshold to the largest block freed so far,
 * after which a block that size comes from the allocating thread's arena and
 * stays resident there once freed. Each HTTP worker thread has an arena of its
 * own, and `malloc_trim` cannot shrink the end of one that is not the main
 * thread's, where such a block lands, so one large design send per worker left
 * the daemon hundreds of MB larger for the session (issue #2544). A fixed
 * threshold (`mallopt (M_MMAP_THRESHOLD)`) ends the raising. macOS, the Windows CRT and musl already map a large block
 * separately, so there this does nothing and answers true. Call it once, at
 * daemon start, before any thread exists.
 */
[[nodiscard]] bool return_large_frees_to_os (std::size_t min_bytes);

/**
 * @brief Hand the freed small blocks every heap arena holds back to the OS,
 *        best-effort.
 *
 * glibc keeps a freed small block in its arena's free lists for reuse, so the
 * tens of thousands of nodes a parsed response body built stay resident in the
 * worker thread's arena once freed (issue #2544). On glibc this is
 * `malloc_trim (0)`, which releases the whole pages inside those free blocks
 * in every arena; the large blocks are `return_large_frees_to_os`'s. A no-op
 * where the C library returns memory itself (macOS, the Windows CRT, musl). It
 * walks every arena: call it after a rare large release, never per request.
 */
void release_free_heap ();

} // namespace vayu::platform
