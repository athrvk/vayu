#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

// `DEFAULT_USER_AGENT` only, and deliberately *not* "vayu/version.hpp" (issue
// #659 item 5). This header is reached by essentially every translation unit, so
// anything version-derived in it makes a release bump recompile the whole
// engine; `user_agent.hpp` declares the symbol without naming the version, and
// one .cpp defines it. `version_isolation_test.cpp` guards the rule.
#include "vayu/core/user_agent.hpp"
// VAYU_PLATFORM_WINDOWS / VAYU_PLATFORM_MACOS, for pacing::spin_tail_us below.
#include "vayu/platform/platform.hpp"

namespace vayu::core::constants {
/**
 * @brief Default configuration values
 */
namespace defaults {
/// Default URL for the daemon process
constexpr const char* DAEMON_URL = "http://127.0.0.1:9876";
/// Default port for the daemon server
constexpr int PORT = 9876;
/// The MCP server's port, which the engine never sends a request to
/// (`http/loopback_guard.hpp`, #2355). The server lives in the app, so
/// `MCP_PORT` in `app/electron/constants.ts` owns the number; this is a copy.
constexpr int MCP_PORT = 9877;
/// Default verbosity level
constexpr bool VERBOSE = false;
// DEFAULT_USER_AGENT is declared in "vayu/core/user_agent.hpp", included above.
} // namespace defaults

/**
 * @brief CLI argument constants
 */
namespace cli {
/// Short flag for port argument
constexpr const char* ARG_PORT_SHORT = "-p";
/// Long flag for port argument
constexpr const char* ARG_PORT_LONG = "--port";
} // namespace cli

/**
 * @brief Logging configuration
 */
namespace logging {
/// Prefix for the daemon's log filenames - `src="engine"` records.
constexpr const char* ENGINE_FILE_PREFIX = "engine_";
/// Prefix for `vayu-cli`'s log filenames - `src="cli"` records. A separate
/// prefix, not a separate directory, is what lets `jq` read both with one
/// glob (issue #1557) while `prune_old_logs` still only ever deletes the
/// generation it was asked to.
constexpr const char* CLI_FILE_PREFIX = "cli_";
/// Prefix of the pre-#1557 log files (`vayu_<stamp>.log`), from before the
/// per-source `engine_`/`cli_` split. `Logger::init` removes any it finds,
/// once per start, so an install that predates the split does not carry both
/// generations forever.
constexpr const char* LEGACY_FILE_PREFIX = "vayu_";
/// Timestamp format for log filenames
constexpr const char* TIME_FORMAT = "%Y%m%d_%H%M%S";
/// How many per-start log files survive a start; the rest are deleted oldest
/// first. One file is written per process start and nothing else ever removes
/// them, so without this an install accumulates a file per launch forever.
constexpr int RETAINED_FILES = 10;
/// Default value of the `maxLogFileBytes` config entry: the size one log file
/// may reach before it is rotated once to `.log.1`. 0 means unlimited.
constexpr int DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
/// Default value of the `logLevel` config entry, and the level
/// `Logger::default_file_level` derives the logger's own from. `info`, not
/// `debug`: every 2xx request line and every database write is a debug record,
/// which fills a long session's file; `debug` is one `logLevel` entry away.
constexpr const char* DEFAULT_LEVEL = "info";
} // namespace logging

/**
 * @brief HTTP protocol constants
 */
namespace http {
/// End-of-line characters for HTTP headers
constexpr const char* EOL_CHARS = "\r\n";
/// Largest response body a design-mode send - `POST /execute` and every step
/// of a collection run - reads into memory (issue #1157). Deliberately the
/// same figure as the load path's `event_loop::MAX_RESPONSE_BODY_BYTES` and
/// deliberately a *separate* one: a load run holds a body per in-flight
/// request and refuses one past the bound, while a design send holds one at a
/// time and is being watched by someone who asked to see it - so this one
/// keeps the prefix it read and says the body was cut, rather than answering
/// with nothing. What it bounds is the renderer's exposure as much as the
/// daemon's: the whole body crosses to the app and is held there as a string.
/// 0 = unbounded, which is what every caller that sets nothing still gets.
constexpr size_t MAX_DESIGN_RESPONSE_BODY_BYTES = size_t{ 32 } * 1024 * 1024;
/// Largest UTF-8 response body `POST /execute` also answers parsed, as `body`
/// beside `bodyRaw` (issue #2544). A JSON DOM costs several times its text in
/// nodes and strings, and the answer is dumped from it once more, so a 20 MB
/// body made the daemon's peak around ten times that for a copy no reader in
/// the engine uses and the app's pane does not show (it reads `bodyRaw`). Past
/// this the parse is skipped and `body` is `null`, whatever the caller asked
/// for. Not a setting: it bounds the engine's own convenience copy, never what
/// is read, shown or stored.
constexpr size_t MAX_PARSED_RESPONSE_BODY_BYTES = size_t{ 4 } * 1024 * 1024;
} // namespace http

/**
 * @brief Event loop configuration
 */
namespace event_loop {
/// Maximum concurrent requests per worker
constexpr size_t MAX_CONCURRENT = 1000;
/// Concurrent connections per host (per worker): the `eventLoopMaxPerHost`
/// default, a floor a load run raises to cover its virtual users (#2394).
constexpr size_t MAX_PER_HOST = 200;
/// Timeout for a worker's curl_multi_poll in milliseconds. Deliberately short:
/// it only bounds how long a worker with active transfers blocks waiting for
/// IO, and submit() interrupts the poll via curl_multi_wakeup anyway.
/// On Windows a 1ms wait is only 1ms because the run holds
/// `platform::HighResolutionTimerScope`; at the OS default this poll would
/// return after ~15.6ms (issue #1161).
constexpr int POLL_TIMEOUT_MS = 1;
/// DNS cache timeout in seconds (avoids DNS resolver saturation).
/// Governs both curl's own cache and the pre-resolution pin cache.
/// 0 disables caching; a negative value never expires.
constexpr long DNS_CACHE_TIMEOUT_SECONDS = 300;
/// How long a failed lookup is remembered, so an unresolvable host does not
/// re-block the worker thread on getaddrinfo for every request. Deliberately
/// short: a host that has just come up should be picked up quickly.
constexpr long DNS_NEGATIVE_CACHE_SECONDS = 5;
/// Largest response body a single load-run transfer may buffer in memory.
/// A transfer past this fails with CURLE_WRITE_ERROR rather than growing as
/// concurrency x body-size until the daemon is OOM-killed. 0 = unbounded.
constexpr size_t MAX_RESPONSE_BODY_BYTES = size_t{ 32 } * 1024 * 1024;
/// TCP keep-alive idle time in seconds
constexpr long TCP_KEEPALIVE_IDLE_SECONDS = 60;
/// TCP keep-alive probe interval in seconds
constexpr long TCP_KEEPALIVE_INTERVAL_SECONDS = 30;
/// Grace added to a transfer's own bound (the per-request timeout, or a
/// stream's cap plus its backstop: `natural_end_drain_ms`) when a run drains
/// its in-flight transfers at the natural end of its duration. A transfer that
/// outlives its bound by this much is not going to complete, so it is cancelled
/// rather than allowed to hold the run in `running` indefinitely.
constexpr int64_t STOP_DRAIN_GRACE_MS = 2000;
} // namespace event_loop

/**
 * @brief Accepted ranges for a POST /runs load-test config.
 *
 * These are crash guards, not policy: every client caps itself far lower
 * (the load dialog offers concurrency <= 1000, the MCP tool has a
 * user-settable cap). They exist because each field is read with
 * `config.value(...)` and cast to `size_t`, so a negative becomes ~1.8e19 and
 * an out-of-range value reaches an eager allocation or a modulo before
 * anything else can reject it.
 */
namespace run_config {
/// Upper bound on a run's `concurrency`. `EventLoopConfig::max_concurrent` is
/// an *eager* per-worker curl-handle pre-allocation, so an unbounded value
/// allocates until malloc fails. Ten times the per-worker ceiling leaves every
/// realistic run untouched while keeping the pre-allocation finite.
constexpr int64_t MAX_CONCURRENCY = 10 * static_cast<int64_t> (event_loop::MAX_CONCURRENT);
/// Upper bound on `maxInFlight`, the open-loop backpressure ceiling. It is
/// deliberately **not** `MAX_CONCURRENCY`: that bounds an eager curl-handle
/// pre-allocation, while this bounds a counter of outstanding requests that
/// allocates nothing up front. Reusing the connection guard here refused
/// configurations the engine already runs implicitly - the default ceiling is
/// `max(targetRps * 10, 1000)` (`load_strategy.cpp`), which reaches 500,000 at
/// the load dialog's 50k RPS maximum. A million covers the default formula
/// across the whole advertised RPS range and still keeps a negative value -
/// ~1.8e19 once cast to `size_t` - from removing the backpressure entirely.
constexpr int64_t MAX_IN_FLIGHT = 1000000;
/// Upper bound on `max_response_samples` (each retained sample holds a full
/// response body, and the vector is reserved up front).
constexpr int64_t MAX_RESPONSE_SAMPLES = 1000000;
/// Upper bound on `max_success_results` / `max_slow_results`. Each retained
/// record holds a serialised timing breakdown (~200 bytes), and both vectors
/// are reserved up front, so an unbounded value is an eager allocation.
constexpr int64_t MAX_RETAINED_RESULTS = 1000000;
/// Upper bound on `slow_threshold_ms` (a day - past that no completion is an
/// outlier because no completion survives).
constexpr int64_t MAX_SLOW_THRESHOLD_MS = 86400000;
/// Upper bound on `max_sample_body_bytes`. A captured body is copied on the
/// completion callback, so an unbounded per-body cap turns one huge response
/// into a hot-path memcpy the whole worker waits on.
constexpr int64_t MAX_SAMPLE_BODY_BYTES = 104857600; // 100MB
/// Upper bound on `max_sample_bytes` (the whole-run capture budget). Every
/// byte under it is held in memory until the run flushes.
constexpr int64_t MAX_SAMPLE_BYTES = 1073741824; // 1GB
/// Upper bound on `max_response_sample_bytes` (the whole-run budget for the
/// script-validation reservoir). Every byte under it is held in memory for the
/// run *and* its retention window, so the ceiling is the capture budget's.
constexpr int64_t MAX_RESPONSE_SAMPLE_BYTES = 1073741824; // 1GB
/// Upper bound on `max_exemplar_results`. Each retained exemplar holds a
/// captured exchange, bounded in turn by the two budgets above.
constexpr int64_t MAX_EXEMPLAR_RESULTS = 100000;
/// Upper bound on a capacity run's `sloMs`. Mirrors the app's own clamp on the
/// client-side SLO setting (`app/src/constants/client-settings.ts`), so a
/// budget the dialog can express is one the engine accepts.
constexpr int64_t MAX_SLO_MS = 60000;
/// Upper bound on a run's top-level `iterations`. An iterations run stops on
/// its request count alone and reads it as a `size_t`, so the bound is what
/// keeps a negative count (~1.8e19) from being a run that never ends. It is
/// the ceiling `scenario.iterations` already has (`scenario_plan.cpp`), so one
/// count is legal in both places, and it sits above every client's own cap
/// (the MCP `maxIterations` ceiling is 100,000,000).
constexpr int64_t MAX_ITERATIONS = 2147483647;
/// Upper bound on `rps` / `targetRps`, the open-loop arrival rate. The
/// highest value the app's RPS ceiling setting and the MCP `maxRps` setting
/// can reach, so a rate either client can send is one the engine accepts;
/// past it the pacing interval is under a microsecond, finer than any tick
/// the generator can keep.
constexpr int64_t MAX_TARGET_RPS = 1000000;
/// Virtual users a constant or ramp-up run holds when the config names no
/// `concurrency`. A constant run with no `targetRps` is closed-loop at this
/// width, so an omitted rate runs unpaced. The MCP tool resolves its own table
/// from these values (`safety.test.ts` reads this line), so a change here is a
/// change to what an agent's un-configured run does.
constexpr int64_t DEFAULT_CONCURRENCY = 100;
/// Length of a constant or ramp-up run when the config names no `duration`.
constexpr int64_t DEFAULT_DURATION_MS = 60000;
/// Request count of an iterations run when the config names no `iterations`.
constexpr int64_t DEFAULT_ITERATIONS = 1000;
/// Virtual users of an iterations run when the config names no `concurrency`.
/// Narrower than `DEFAULT_CONCURRENCY` because the run is bounded by its
/// request count, not by a clock.
constexpr int64_t DEFAULT_ITERATIONS_CONCURRENCY = 10;
/// Time a ramp-up run spends climbing when the config names no
/// `rampUpDuration`.
constexpr int64_t DEFAULT_RAMP_DURATION_MS = 10000;
/// Virtual users a ramp-up run starts from when the config names no
/// `startConcurrency`.
constexpr int64_t DEFAULT_START_CONCURRENCY = 1;
} // namespace run_config

/**
 * @brief Defaults for the capacity-discovery search.
 *
 * Only the first three are settable per run (`sloMs`, `stepDuration`, and the
 * `startConcurrency`/`concurrency` bounds the other modes already own). The
 * rest are the controller's policy: they live here rather than as run-config
 * keys because a user asking "what can my service take" is not also choosing a
 * step-growth factor, and a knob nobody sets is a knob nobody maintains.
 */
namespace capacity {
/// Default latency budget the search looks for the edge of, in ms. Matches the
/// app's `DEFAULT_SLO_THRESHOLD_MS` so the dialog's prefill is the same number.
constexpr int64_t SLO_MS = 200;
/// How long each level is held before it is judged. Long enough to outlast the
/// settle ticks and leave a level histogram worth a p99 at the stock 100ms tick
/// cadence, short enough
/// that a search over tens of levels finishes inside a normal run duration.
constexpr int64_t STEP_DURATION_MS = 5000;
/// Deadline for the whole search when the run config names no `duration`.
///
/// Deliberately **not** the 60s every other mode falls back to: at the default
/// step this mode walks a level every 5s, so a minute is a dozen levels and a
/// search that almost always ends `deadline` rather than finding anything. It
/// is a named constant rather than a literal because the MCP duration cap has
/// to know it - a guard assuming one default for every mode let a capacity run
/// past a cap it was under - and `safety.test.ts` reads this line to stay in
/// step.
constexpr int64_t DEADLINE_MS = 300000;
/// Ticks discarded at the start of each level: the in-flight count is still
/// climbing to the new target, so those windows measure the transition rather
/// than the level. At the stock cadence this is the first 300ms of every step.
constexpr size_t SETTLE_TICKS = 3;
/// Concurrency cap when the run config names none.
constexpr int64_t MAX_CONCURRENCY = 100;
/// Fractional growth per healthy step (+25%), floored at +1 concurrency.
constexpr double STEP_GROWTH = 0.25;
/// Below this percentage of throughput gained across the last two step-ups, the
/// service is saturated even though it is still inside its latency budget.
constexpr double PLATEAU_GAIN_PCT = 5.0;
/// Consecutive breaching windows before the search stops. Two, not one, so a
/// single noisy window re-measures instead of ending the run.
constexpr size_t SLO_BREACH_WINDOWS = 2;
/// A level whose error share (`vayu::count_status_failures` over its
/// completions) is above this percentage breaches, whatever its p99 (#2815): a
/// target answering fast 503s is not sustaining that level.
constexpr double ERROR_RATE_PCT = 1.0;
} // namespace capacity

/**
 * @brief How a `constant_rps` tick waits out its remainder.
 *
 * All three platforms sleep the coarse leg and spin the last
 * `spin_tail_us (remaining)` of every tick (issue #1370 landed it for
 * Windows; the same shape now runs on Linux and macOS too, through
 * `platform::sleep_until_precise`). Only the *shape* of the tail is
 * platform-specific, because the sleep primitive each platform's leg
 * actually uses overshoots by a different amount and, on macOS, in a
 * different way (see below).
 */
namespace pacing {
namespace detail {
/// The general tail model, shared by every platform:
/// `min (remaining / divisor + base_us, cap_us)`. `divisor == 0` is the
/// degenerate flat case (Windows, Linux): the slope term drops out and the
/// tail is always `cap_us`, which by convention equals `base_us` there.
constexpr int64_t
compute_spin_tail_us (int64_t remaining_us, int64_t divisor, int64_t base_us, int64_t cap_us) {
    if (divisor <= 0) {
        return cap_us;
    }
    // Parenthesized to block macro expansion: this header is reached by
    // essentially every translation unit (see the file-level comment above),
    // including ones that pull in `windows.h` (via curl.h/httplib.h) ahead of
    // this include without `NOMINMAX` defined - it is PRIVATE to `vayu_core`
    // (`engine/CMakeLists.txt`), so `vayu-engine`, `vayu-cli` and the test
    // target never get it. An unparenthesized `std::min` there macro-expands
    // to `windows.h`'s `min(a,b)` and fails to compile with MSVC's C2589.
    return (std::min) ((remaining_us / divisor) + base_us, cap_us);
}
} // namespace detail

/// The value is the sleep overshoot it has to cover. Measured on Windows 11
/// 24H2 (i5-8300H) with a 1 ms timer request held, 400 samples per row, as
/// `actual - requested` for the durations this leg actually asks for:
///
///     requested   100    500   1000   2000   3500   5000  us
///     p50        1817   1377    912    641   1139    596  us
///     p90        2099   1626   1141   1104   1639   1068  us
///     p99        3143   2157   1740   1700   2209   1571  us
///
/// The overshoot is a wakeup latency, not a proportional error - it barely
/// moves with the duration asked for - so a fixed tail covers every rate. At
/// 2000 us it absorbs the median and p90 of every row, which is what turns
/// the 400 RPS arrival gap from "sleep, then pay two requests back" into a
/// regular interval. Sizing it to p99 instead would roughly double the spin
/// for the last few percent of ticks, and a sidecar that pins a core is not
/// an improvement (issue #1370).
///
/// It is also the old spin *threshold*, unchanged in value: before #1370 a
/// remainder at or under 2000 us was spun whole and anything longer was slept
/// whole. The first half of that rule is what this constant still says, so
/// every tick from ~500 RPS up - where the remainder never exceeds the tail -
/// paces exactly as it did. Flat (`divisor = 0`), so Windows's `spin_tail_us`
/// always returns `WINDOWS_CAP_US` regardless of the remainder - the exact
/// behavior this constant had before it became a function argument.
///
/// Named unconditionally (not inside the `#if` below), alongside every other
/// platform's parameters, so `SpinTailUs.*` in `load_strategy_test.cpp` can
/// exercise every platform's tail shape - through `detail::compute_spin_tail_us`
/// directly - on whichever single platform actually built this translation
/// unit.
constexpr int64_t WINDOWS_BASE_US = 2000;
constexpr int64_t WINDOWS_CAP_US  = 2000;

/// Real measurement (issue #1667,
/// https://github.com/athrvk/vayu/issues/1667#issuecomment-5679113672):
/// Apple M3 Pro, macOS 26.7, 400 samples/row, `mach_wait_until`
/// `actual - requested` overshoot, engine+Electron running concurrently.
///
/// Unlike Windows, the overshoot is not flat: it scales with the requested
/// sleep duration up to ~5-10ms, then plateaus around ~1020-1060us. That
/// matches XNU's timer-coalescing leeway model - slop proportional to the
/// timer length, capped - rather than a fixed wakeup cost:
/// `overshoot ~= min (requested / 8, ~1000us) + ~15us base, p99 +30us
/// margin`. A single fixed tail cannot cover both ends: sized for the
/// low-RPS/long-tick case (~1100us) it would busy-spin an entire core at
/// high RPS (1500 RPS = 667us ticks, wholly consumed by the spin); sized for
/// high RPS it misses the deadline at low RPS (the sleep leg alone already
/// overshoots a flat 300us placeholder by ~2x at 200 RPS before any spin
/// happens). So the tail is `remaining / MACOS_DIVISOR + MACOS_BASE_US`,
/// capped at `MACOS_CAP_US`, which reproduces that measured shape: near-zero
/// at very short remainders, tracking the p99 line through the mid-range,
/// and flat at the plateau.
///
/// The cap is tied to the pacing thread's current (default) latency QoS
/// tier - it runs under `THREAD_PRECEDENCE_POLICY`'s priority bump but no
/// explicit QoS class - so a future change to that thread's scheduling
/// policy needs this re-measured; not tracked as a separate issue, since
/// pursuing a QoS change on its own was explicitly decided against without
/// further justification.
constexpr int64_t MACOS_DIVISOR = 9;
constexpr int64_t MACOS_BASE_US = 60;
constexpr int64_t MACOS_CAP_US  = 1100;

/// Placeholder pending real-hardware measurement - see issue #1667. Linux's
/// default timer slack is documented as ~50us
/// (https://www.kernel.org/doc/html/latest/timers/timers-howto.html and
/// `/proc/<pid>/timerslack_ns`, default 50000ns); this value adds margin for
/// scheduler wakeup latency on top of that and has NOT been measured the way
/// the Windows constant above was. Flat (`divisor = 0`), so Linux's
/// `spin_tail_us` always returns `LINUX_CAP_US` regardless of the remainder.
constexpr int64_t LINUX_BASE_US = 150;
constexpr int64_t LINUX_CAP_US  = 150;

/// How much of each tick's remainder is busy-spun rather than slept, in
/// microseconds. The tick sleeps `remainder - spin_tail_us (remainder)` and
/// spins the rest; a remainder no longer than this is spun whole.
#if VAYU_PLATFORM_WINDOWS
constexpr int64_t spin_tail_us (int64_t remaining_us) {
    return detail::compute_spin_tail_us (remaining_us, 0, WINDOWS_BASE_US, WINDOWS_CAP_US);
}
#elif VAYU_PLATFORM_MACOS
constexpr int64_t spin_tail_us (int64_t remaining_us) {
    return detail::compute_spin_tail_us (
    remaining_us, MACOS_DIVISOR, MACOS_BASE_US, MACOS_CAP_US);
}
#else // Linux
constexpr int64_t spin_tail_us (int64_t remaining_us) {
    return detail::compute_spin_tail_us (remaining_us, 0, LINUX_BASE_US, LINUX_CAP_US);
}
#endif
} // namespace pacing

/**
 * @brief Server configuration
 */
namespace server {
/// Default request timeout in milliseconds
constexpr int DEFAULT_TIMEOUT_MS = 30000;
/// Ceiling on the connect phase (TCP and TLS) of every transfer, issue #2835.
/// A stream and a stall-bounded fetch set no total deadline, and without a
/// connect bound libcurl's 300s default (or the kernel's SYN retries) decides.
/// A request timeout above this narrows connect to it on purpose.
constexpr int64_t CONNECT_TIMEOUT_CAP_MS = 30000;
/// `CURLOPT_CONNECTTIMEOUT_MS` for a transfer whose own deadline (a total, a
/// stall window) is @p timeout_ms: the smaller of it and the cap. A deadline of
/// zero or less is "none", which gets the cap rather than libcurl's default.
constexpr int64_t connect_timeout_ms (int64_t timeout_ms) {
    if (timeout_ms <= 0) {
        return CONNECT_TIMEOUT_CAP_MS;
    }
    // Not std::min: a translation unit that includes <windows.h> without
    // NOMINMAX turns `min (` into a macro (default_headers_test.cpp).
    return timeout_ms < CONNECT_TIMEOUT_CAP_MS ? timeout_ms : CONNECT_TIMEOUT_CAP_MS;
}
/// Smallest heap block the daemon gives a mapping of its own, returned to the
/// OS when freed (`platform::return_large_frees_to_os`, issue #2544). Large
/// enough that a load run's ordinary bodies and buffers stay in the arenas,
/// where reuse is cheapest; a block this size is a large design-send body or a
/// copy of one, rare and exactly what held the daemon's RSS at its peak.
constexpr size_t OWN_MAPPING_MIN_BYTES = size_t{ 4 } * 1024 * 1024;
/// A buffered design send whose response body is larger than this calls
/// `platform::release_free_heap` once it has answered (issue #2544). Parsing a
/// body leaves around ten times its size in freed small blocks in the worker
/// thread's arena, so this bounds what one send can leave resident per worker
/// to around ten MB, while the many small sends an agent or a script makes
/// never pay for a walk of every arena.
constexpr size_t RELEASE_HEAP_AFTER_BODY_BYTES = size_t{ 1 } * 1024 * 1024;
/// Interval for collecting statistics in milliseconds
constexpr int STATS_INTERVAL_MS = 100;
/// Shortest span the live and stored per-tick rates and window means cover
/// (`currentRps`, `currentSendRate`, `windowAvg*`, #2393). A 100 ms delta
/// counts four or five closed-loop batches and reads 0 between sparse
/// completions; a second smooths both and still shows an outage within one.
constexpr int64_t LIVE_RATE_WINDOW_MS = 1000;
/// Default span of live SSE history retained in memory per run, in
/// milliseconds (config key `liveReplayWindowMs`). The buffer is a ring: older
/// ticks are evicted, so a run's memory does not grow with its duration. A
/// consumer that resumes from further back is served from the oldest retained
/// tick (SSE clients tolerate a gap on resume).
///
/// The bound is a *duration*, not a tick count, because the tick cadence is
/// itself user-configurable (`liveTickIntervalMs`, 10-1000ms): a fixed count
/// would mean a 30-second window at one end of that range and a 50-minute one
/// at the other. 5 minutes matches the app's default live-chart window, so a
/// dashboard attaching mid-run replays what it is going to show.
constexpr int DEFAULT_LIVE_REPLAY_WINDOW_MS = 300000;
/// Default ceiling on retained live ticks per run (config key
/// `liveMaxRetainedTicks`) - the backstop that keeps a fast cadence from
/// turning a long window into unbounded memory. It is a *memory* bound, not a
/// rendering one: the dashboard's charts bucket ticks before plotting (0.5s by
/// default) and uPlot draws to canvas, so a full window reaches the screen as a
/// few thousand points however many ticks back it.
///
/// Raising it is close to free at stock settings, because the window - not this
/// ceiling - is what sizes the ring: a 5-minute window at a 100ms cadence holds
/// 3000 ticks whatever this is set to. It only binds when window / cadence
/// exceeds it. 50000 is chosen so the longest configurable window (1 hour) is
/// honoured in full at the default cadence, with headroom.
///
/// The renderer keeps the same value (its DEFAULT_MAX_RETAINED_TICKS in
/// app/src/constants/live-window.ts) and reads this key too, so neither side
/// promises a window the other cannot hold.
constexpr size_t DEFAULT_MAX_LIVE_TICKS = 50000;
/// How long `GET /runs/:id/live` waits, once it has sent the run's last tick,
/// for the worker to settle (`RunContext::settled`) before it sends `complete`
/// without a status (#2140). The wait normally lasts as long as the run's
/// finishing pass - flush, deferred validation, teardown scripts, summary -
/// so this is a backstop for a worker that never reaches `retain_run`, not a
/// budget that pass is expected to approach.
constexpr int64_t LIVE_SETTLE_TIMEOUT_MS = 60000;
/// How long `RunManager::shutdown` waits for signalled runs to reach a terminal
/// status before it logs that they have not. The *wait* is bounded; the join
/// that follows it is not, because abandoning a still-running worker is exactly
/// the use-after-free the drain exists to prevent. Matches the 5s the daemon
/// waited before the drain was ordered.
constexpr int64_t RUN_SHUTDOWN_GRACE_MS = 5000;
/// How long the app's sidecar waits for the engine to exit, once it has asked
/// it to stop, before it kills it: `ENGINE_GRACEFUL_EXIT_TIMEOUT_MS` in
/// `app/electron/constants.ts`, which must not fall below this. The daemon
/// budgets its optional shutdown work (the recovery backup's final refresh,
/// #2421) against what is left of it.
constexpr int64_t SHUTDOWN_WINDOW_MS = 5000;
/// How far ahead of an OAuth 2.0 token's expiry a run refreshes it (config key
/// `oauth2RefreshLeadMs`). Comfortably wider than the 45s skew
/// `oauth::is_expired` already applies, so the new credential is published
/// while the old one is still being accepted and no request falls in the gap.
constexpr int64_t OAUTH2_REFRESH_LEAD_MS = 60000;
/// Floor on the wait between two mid-run refreshes. A token whose whole
/// lifetime is shorter than the lead is always inside its refresh window, so
/// without a floor the watchdog would re-acquire in a tight loop and hammer the
/// token endpoint on the run's behalf.
constexpr int64_t OAUTH2_REFRESH_MIN_INTERVAL_MS = 1000;
/// First wait after a failed mid-run refresh, doubled per consecutive failure
/// up to OAUTH2_REFRESH_RETRY_MAX_MS. The run keeps sending the credential it
/// has - a failed refresh is reported, never fatal - so retrying is about
/// recovering from a token endpoint that blipped, not about the run's fate.
constexpr int64_t OAUTH2_REFRESH_RETRY_MS = 5000;
/// Ceiling on that backoff, so a token endpoint that is down for an hour costs
/// the run a bounded number of attempts rather than one every five seconds.
constexpr int64_t OAUTH2_REFRESH_RETRY_MAX_MS = 60000;
/// How often the refresh watchdog wakes while waiting, to notice that the run
/// has ended. The worker joins the thread on its way out, so this is what
/// bounds how long a finished run waits for it: without the slice, a watchdog
/// asleep until the next expiry would hold the run open for the rest of the
/// token's life. Lower costs a few more wakeups per second on one thread.
constexpr int64_t OAUTH2_REFRESH_POLL_INTERVAL_MS = 100;
} // namespace server

/**
 * @brief The server-vitals monitor a run may scrape alongside its own metrics.
 *
 * The three a user reaches for are config-backed (`monitorIntervalMs`,
 * `monitorMaxSeries`, `monitorScrapeTimeoutMs`) and these are their seeds. The
 * rest are rails rather than preferences: the interval bounds exist to stop a
 * cadence that measures the scraper instead of the target, and the backoff
 * threshold is how politely the loop gives up on a dead endpoint - the same
 * reason `threshold_eval`'s budget ranges are constants.
 */
namespace monitor {
/// Floor on `monitor.intervalMs`. Below this the scrape's own latency is a
/// large share of the interval, so the series measures the scraper.
constexpr int MIN_INTERVAL_MS = 250;
/// Ceiling on it. A run shorter than one interval would record nothing.
constexpr int MAX_INTERVAL_MS = 60000;
/// Cadence for a block that names no `intervalMs` (config `monitorIntervalMs`).
constexpr int DEFAULT_INTERVAL_MS = 1000;
/// How many metrics one run may chart (config `monitorMaxSeries`). Each is a
/// line on one overlay and a name matched against every exposition line.
constexpr size_t MAX_SERIES = 8;
/// Consecutive failed scrapes before the loop logs once and backs off. Below
/// this a scrape failure is a gap in the series and nothing else.
constexpr int FAILURES_BEFORE_BACKOFF = 5;
/// `monitorScrapeTimeoutMs` seed. Zero is the sentinel for "derive from the
/// interval", which is what keeps the timeout tracking a cadence the user
/// changes later; see `resolve_scrape_timeout_ms`.
constexpr int DEFAULT_SCRAPE_TIMEOUT_MS = 0;
/// Floor the derivation never goes below, for an interval small enough that
/// three quarters of it would time out before a loopback endpoint could answer.
constexpr int MIN_DERIVED_SCRAPE_TIMEOUT_MS = 100;
} // namespace monitor

/**
 * @brief Script engine configuration
 */
namespace script_engine {
/// Memory limit for the script engine in bytes (64MB)
constexpr size_t MEMORY_LIMIT = size_t{ 64 } * 1024 * 1024;
/// Script execution timeout in milliseconds
constexpr uint64_t TIMEOUT_MS = 5000;
/// The bounds of `scriptTimeout`: the config entry's seeded minimum and
/// maximum, and the range `read_script_config` clamps a stored value into.
/// There is no "no limit" value; 1 ms is the shortest deadline expressible.
constexpr uint64_t SCRIPT_TIMEOUT_MIN_MS = 1;
constexpr uint64_t SCRIPT_TIMEOUT_MAX_MS = 60000;
/// Stack size for the script engine in bytes (256KB)
constexpr size_t STACK_SIZE = size_t{ 256 } * 1024;
/// The bounds of `scriptStackSize`, shared by the seeded entry and the clamp.
/// QuickJS measures its ceiling from the stack pointer where the runtime is
/// created, already some frames into the worker thread, so the ceiling must
/// leave room for those frames on the smallest thread the engine runs on:
/// macOS gives a secondary thread 512 KB (Windows 1 MiB) and no engine thread
/// sets a stack size of its own. A 512 KB ceiling overflows that thread before
/// QuickJS refuses the recursion; 256 KB, the default, is the size proven on
/// it, so the setting can only be lowered.
constexpr size_t STACK_SIZE_MIN = size_t{ 64 } * 1024;
constexpr size_t STACK_SIZE_MAX = STACK_SIZE;
/**
 * @brief Stack budget while a bundled `require()` library (lodash, moment) is
 *        evaluated, in bytes (768KB).
 *
 * That source is Vayu's own vendored code, so its parse depth is not the
 * user's to budget, and a frame is a different size on every toolchain: MSVC
 * at /Od under ASan overflowed `STACK_SIZE` inside QuickJS's own parser on
 * lodash (73KB) and moment (61KB). A library evaluates under the larger of
 * this and the script's own budget, then the script's budget is restored.
 * It must fit the thread that runs the script with room to spare: 1MB is the
 * smallest stack an engine thread has (Windows), and the limit is measured
 * from where the runtime was built, a little way down it.
 */
constexpr size_t SHELF_LIBRARY_STACK_SIZE = size_t{ 768 } * 1024;
/// Whether to enable console output from scripts
constexpr bool ENABLE_CONSOLE = true;
/**
 * @brief How many requests one script execution may issue via
 *        `pm.sendRequest`.
 *
 * A cap rather than a knob because the failure it bounds is not the single
 * script a user is watching: a load run's `tests` script runs once per
 * *sampled* response, serially, on the run's worker thread, so an uncapped
 * loop turns post-run validation into minutes of apparent hang. Ten is well
 * above the token-fetch case the feature exists for and far below the point
 * where a sampled run stops looking finished.
 */
constexpr int SEND_REQUEST_LIMIT = 10;
/**
 * @brief How many promise jobs and timer callbacks, together, one execution
 *        may run when it has no wall-clock deadline.
 *
 * The queues a script leaves are drained inside its execution (#2531, #2577),
 * and with a deadline the deadline bounds that drain. Without one, a runaway
 * `while (true) await null;` or a `setInterval` nothing clears would hold the
 * thread forever, so the count bounds it instead. The config cannot produce
 * that state (`scriptTimeout` has a minimum of 1, #2359); an embedder or a test
 * that builds a `ScriptConfig` with `timeout_ms` 0 can. Far above what a script
 * awaiting a few sends queues.
 */
constexpr size_t MAX_ASYNC_JOBS_WITHOUT_TIMEOUT = 100000;
/**
 * @brief How many `setTimeout` / `setInterval` registrations one execution may
 *        hold at once (#2577).
 *
 * The queue lives outside the QuickJS heap, so the script's memory limit does
 * not bound it: a loop that only queues timers would grow the engine process
 * until the deadline, or without end when the engine runs with no
 * deadline. A script that waits on a few sends holds a handful.
 */
constexpr size_t MAX_PENDING_TIMERS = 10000;
} // namespace script_engine

/**
 * @brief JSON processing configuration
 */
namespace json {
/// Default indentation level for JSON serialization
constexpr int DEFAULT_INDENT = 2;
/// Maximum size for JSON field parsing to prevent OOM (10MB)
constexpr size_t MAX_FIELD_SIZE = size_t{ 10 } * 1024 * 1024;
/// Maximum request/response body bytes stored per design-run trace (5MB).
/// Larger bodies are truncated in results.trace_data with bodyTruncated set.
constexpr size_t MAX_TRACE_BODY_BYTES = size_t{ 5 } * 1024 * 1024;
} // namespace json

/**
 * @brief Collection-runner (scenario) bounds.
 */
namespace scenario {
/// Largest plan one scenario run may resolve to (config key `maxScenarioSteps`).
/// The whole plan is composed up front and held in memory for the run's life,
/// and load-mode scenarios allocate one latency histogram per step, so plan
/// size is a memory bound in both modes rather than a policy preference.
constexpr size_t MAX_STEPS = 200;
/// Largest inline `data` array one scenario run may carry (config key
/// `maxScenarioDataRows`). The rows arrive on the run payload because the app
/// owns file parsing and the script sandbox has no filesystem access; this is
/// what bounds the payload that decision costs.
constexpr size_t MAX_DATA_ROWS = 1000;
/// Largest serialized size of that inline `data` array (config key
/// `maxScenarioDataBytes`). The row bound alone does not bound the payload -
/// one row with a megabyte in a cell is within it - and the transport's own
/// ceiling (`request_body::MAX_BYTES`) refuses a whole payload without naming
/// what in it was too large. This is the engine-authored bound that answers
/// first.
constexpr size_t MAX_DATA_BYTES = size_t{ 16 } * 1024 * 1024;
/// The largest value `maxScenarioDataBytes` accepts (its config entry's
/// maximum), which `request_body::MAX_BYTES` is held above.
constexpr size_t MAX_CONFIGURABLE_DATA_BYTES = size_t{ 100 } * 1024 * 1024;
/// Largest number of per-step `results` rows one scenario run stores (config
/// key `maxScenarioStoredSteps`; 0 = unlimited). `Database::get_results` loads
/// every row of a run with no limit and the report parses each `trace_data`,
/// which the dashboard polls - so an unbounded 200-step by 500-iteration run
/// would make the report path quadratic. Steps that did not pass are kept
/// first and what was thinned is disclosed in the run summary.
constexpr size_t MAX_STORED_STEPS = 5000;
/// How many step executions one iteration may perform, derived from the plan
/// when the config key `maxStepsPerIteration` is left at its default of 0:
/// `STEPS_PER_ITERATION_MULTIPLIER x plan steps`, never below
/// `MIN_STEPS_PER_ITERATION`. `pm.execution.setNextRequest` makes an infinite
/// loop a two-line script, so an iteration needs a ceiling; the ceiling is a
/// multiple of the sequence's own length because a plan of 3 steps and a plan
/// of 200 do not want the same one, and the floor keeps a short plan's
/// legitimate retry loops working.
constexpr size_t STEPS_PER_ITERATION_MULTIPLIER = 10;
constexpr size_t MIN_STEPS_PER_ITERATION        = 100;
} // namespace scenario

/**
 * @brief Metrics collector configuration for high-RPS load testing
 */
namespace metrics_collector {
/// Default expected requests for pre-allocation
constexpr size_t DEFAULT_EXPECTED_REQUESTS = 100000;
/// Default maximum error records to store (config key `maxStoredErrors`;
/// 0 = unlimited) (prevents OOM at high error rates). A fully-failing target
/// produces errors at close to the completion rate, each carrying a message and
/// a trace blob, so an unlimited store is a straight path to an OOM kill
/// mid-run. Errors past the cap are still counted (see
/// MetricsCollector::errors_dropped) and still reach the status-code
/// distribution and the per-type counts (#2400) - only their individual
/// records are dropped.
constexpr size_t DEFAULT_MAX_ERRORS = 10000;
/// Maximum sampled success results to store (config key `max_success_results`;
/// 0 = unlimited). Retained as a reservoir: past the cap a later completion
/// displaces a uniformly chosen incumbent rather than being dropped, so the
/// stored set describes the whole run instead of its first
/// `max_success_results * success_sample_rate` requests.
constexpr size_t DEFAULT_MAX_SUCCESS_RESULTS = 1000;
/// Maximum slow-request records to store (config key `max_slow_results`;
/// 0 = unlimited). A separate budget from the sampled successes: a completion
/// past `slow_threshold_ms` is stored because the user asked for outliers, so
/// it must not consume a 1-in-N slot - and under saturation most completions
/// cross the threshold, so it needs a ceiling of its own.
constexpr size_t DEFAULT_MAX_SLOW_RESULTS = 1000;
/// Default latency (ms) past which a completion is captured as an outlier
/// (config key `slow_threshold_ms`). 0 disables slow-request capture.
constexpr int DEFAULT_SLOW_THRESHOLD_MS = 1000;
/// Default sample rate for success traces (1 in N)
constexpr size_t DEFAULT_SUCCESS_SAMPLE_RATE = 100;
/// Whether to store success trace data by default
constexpr bool DEFAULT_STORE_SUCCESS_TRACES = false;
/// Maximum response samples to store for deferred script validation
constexpr size_t DEFAULT_MAX_RESPONSE_SAMPLES = 1000;
/// Sample rate for response storage (1 = all, 100 = 1%, etc.)
constexpr size_t DEFAULT_RESPONSE_SAMPLE_RATE = 100;
/// Upper bound on the collector's *pre-allocation* - not on what a run may go
/// on to store, since both vectors still grow past it.
///
/// Both derived reserves scale with `expected_requests`, which RunContext
/// computes as duration x RPS x 1.2 with no ceiling of its own. At 1M RPS for
/// a day that is ~1.04e11, and the errors reserve (expected / 20, taken
/// whenever `max_errors` is 0 - the default, and nothing overrides it) asks
/// for ~5.2e9 ResultRecords, on the order of 450 GB. That allocation throws
/// out of the collector's constructor, which runs inside RunContext's, which
/// the route calls *after* writing the run row - so the caller gets an opaque
/// 500 and the row is stranded `pending` forever. A reserve is only an
/// optimisation, so capping it costs a few reallocations on a run that large
/// and nothing at all otherwise. 1M records is ~90 MB, still generous.
constexpr size_t MAX_RESERVE_RECORDS = 1000000;
/// Whether a load run captures response headers/bodies for its retained
/// samples by default (config key `capture_response_bodies`). On by default is
/// only defensible because capture is failure-and-outlier-shaped rather than
/// uniform: a healthy run captures roughly `EXEMPLARS_PER_STATUS` bodies per
/// distinct status code and nothing else, so the common case costs kilobytes.
constexpr bool DEFAULT_CAPTURE_RESPONSE_BODIES = true;
/// Largest single captured response body kept, in bytes (config key
/// `maxSampleBodyBytes`). Deliberately far below design mode's
/// `maxTraceBodyBytes` (5 MiB): a design run stores one exchange the user asked
/// for, a load run stores tens of them nobody asked for individually.
constexpr size_t DEFAULT_MAX_SAMPLE_BODY_BYTES = 32768;
/// Whole-run budget for captured body bytes (config key `maxSampleBytes`).
/// Once spent, samples keep being recorded with their headers and metadata and
/// only the bodies are dropped - counted by
/// MetricsCollector::sample_bodies_dropped so the UI can say the set is
/// incomplete rather than showing a silently biased subset.
constexpr size_t DEFAULT_MAX_SAMPLE_BYTES = size_t{ 2 } * 1024 * 1024;
/// Whole-run budget for the script-validation reservoir's bodies (config key
/// `maxResponseSampleBytes`). Two orders of magnitude above the capture budget
/// beside it because the two stores answer different questions: a captured
/// exchange is an exhibit a person reads, truncated to 32 KiB, while a retained
/// sample is the *input* to a deferred script or schema check and is kept whole
/// - truncating it would make that check report a failure the target never
/// produced. So the budget drops whole samples instead, and this is where it
/// starts: against a target answering 1 MiB bodies the count cap alone
/// (`max_response_samples`, 1000) allowed ~1 GB resident, held through the
/// retention window after the run (issue #1155).
constexpr size_t DEFAULT_MAX_RESPONSE_SAMPLE_BYTES = size_t{ 256 } * 1024 * 1024;
/// How many exemplars of each distinct status code a run guarantees to retain.
/// Small on purpose: exemplars answer "what does a 503 from this target look
/// like", which the first few answer as well as the first few hundred.
constexpr size_t EXEMPLARS_PER_STATUS = 3;
/// Ceiling on the exemplar store (config key `max_exemplar_results`; 0 =
/// unlimited). The per-status gate already bounds a normal run to
/// `EXEMPLARS_PER_STATUS x distinct status codes`, which is single digits;
/// this is the guard for a target that answers with hundreds of distinct
/// codes. Exemplars past it are dropped and counted, never displaced - an
/// exemplar's whole value is that it was retained, so a reservoir would defeat
/// the bucket.
constexpr size_t DEFAULT_MAX_EXEMPLAR_RESULTS = 64;
/// HdrHistogram significant figures (3 = ~0.1% precision)
constexpr int HISTOGRAM_SIGNIFICANT_FIGURES = 3;
/// HdrHistogram max trackable latency in microseconds (1 hour). A longer
/// duration is clamped to it at the record site (`histogram_latency_us`).
constexpr int64_t HISTOGRAM_MAX_LATENCY_US = 3600LL * 1000LL * 1000LL;
/// Whether a load run feeds the five per-phase histograms (config key
/// `phaseHistograms`). On by default: the phase values are computed for every
/// completion anyway, and without this bank they survive only for the ~1% of
/// completions a trace is retained for - so "was it the server or the
/// connection path" is answered off a biased sample. The escape hatch exists
/// because the feed is five atomic histogram records on the completion path;
/// see docs/engine/benchmarks.md for the measured cost.
constexpr bool DEFAULT_PHASE_HISTOGRAMS = true;

/// Whether a streaming load run feeds the per-completion event histogram
/// (run config `stream_metrics`, issue #576). On by default: it is one atomic
/// histogram record per completion, paid only by runs that stream, and it is
/// the whole point of running a stream under load - events/sec is the number
/// such a run exists to produce.
constexpr bool DEFAULT_STREAM_METRICS = true;

/// Ceiling on the event histogram's value range - events delivered by one
/// stream. Above `sse::STREAM_EVENTS_CEILING`, which is what a per-request cap
/// can be set to, so the histogram can hold any completion the caps allow.
constexpr int64_t HISTOGRAM_MAX_EVENTS = 10000000;

/// Ceiling on distinct `metric.record` / `pm.metrics` names one run may
/// declare (issue #1500). Each name backs its own HdrHistogram (trend) or
/// atomic pair (counter, rate), so the bound is a memory guard the same way
/// `max_exemplar_results` is - refused at validate time for a declared
/// `metric.record` element, so a run never discovers the limit mid-flight.
constexpr size_t MAX_CUSTOM_METRIC_NAMES = 32;
/// A custom trend's value, scaled into the same fixed-point integer space
/// `record_success` converts milliseconds into (x1000, for ~3 decimal
/// digits), so one histogram range and significant-figure setting serves
/// both. Values are clamped to zero before scaling - HdrHistogram cannot
/// hold a negative count - and to `HISTOGRAM_MAX_LATENCY_US` after it, the
/// same ceiling the latency histograms share.
constexpr double CUSTOM_METRIC_VALUE_SCALE = 1000.0;
} // namespace metrics_collector

/**
 * @brief SSE request configuration (issue #573)
 *
 * The seeds and bounds of the six `sse*` settings. Every one of them exists
 * because a stream is unbounded by nature: it has no content length, no promise
 * to end, and no ceiling on how much it will send. These are where each of
 * those turns into a number the engine can hold a stream to.
 */
namespace sse {
/// Events retained in memory per run for replay and tail, seeding
/// `sseMaxRetainedEvents`. An LLM completion is a few hundred tokens, so the
/// stock ring holds a whole one and then some.
constexpr std::size_t MAX_RETAINED_EVENTS     = 2000;
constexpr std::size_t MIN_RETAINED_EVENTS     = 10;
constexpr std::size_t RETAINED_EVENTS_CEILING = 200000;

/// Bytes of one event's `data` kept, seeding `sseMaxEventBytes`. Also the cap
/// on any single unterminated line, which is what bounds the parser itself.
constexpr std::size_t MAX_EVENT_BYTES     = std::size_t{ 64 } * 1024;
constexpr std::size_t MIN_EVENT_BYTES     = 256;
constexpr std::size_t EVENT_BYTES_CEILING = std::size_t{ 8 } * 1024 * 1024;

/// Events written into a completed run's trace, seeding `sseMaxStoredEvents`.
/// Smaller than the ring: the ring is a live window that dies with the run,
/// this is on disk for as long as the run is retained.
constexpr std::size_t MAX_STORED_EVENTS     = 500;
constexpr std::size_t STORED_EVENTS_CEILING = 100000;

/// Default per-request caps, seeding `sseMaxStreamDurationMs` and
/// `sseMaxStreamEvents`. Ten minutes is longer than any single model response
/// and far shorter than a leaked worker thread.
constexpr int64_t MAX_STREAM_DURATION_MS     = 600000;
constexpr int64_t MIN_STREAM_DURATION_MS     = 1000;
constexpr int64_t STREAM_DURATION_MS_CEILING = 86400000;

constexpr int64_t MAX_STREAM_EVENTS     = 100000;
constexpr int64_t MIN_STREAM_EVENTS     = 1;
constexpr int64_t STREAM_EVENTS_CEILING = 10000000;

/// Grace between a load stream's duration cap and the whole-transfer timeout
/// that backstops it (issue #576). The cap is enforced from the progress
/// callback, which libcurl runs at least once a second, so the backstop has to
/// sit far enough past the cap that ordinary callback latency never beats it -
/// otherwise a stream that ended exactly as asked is reported as a timeout.
/// Reaching the backstop at all means the callback never ran, which is a real
/// failure and is reported as one.
constexpr int64_t LOAD_STREAM_TIMEOUT_GRACE_MS = 5000;

/// How long a stream may deliver nothing before it is ended as idle, seeding
/// `sseIdleTimeoutMs`. Enforced through `CURLOPT_LOW_SPEED_TIME`, whose
/// resolution is whole seconds, so a value is rounded up to the next second and
/// the floor is one second.
constexpr int64_t IDLE_TIMEOUT_MS         = 60000;
constexpr int64_t MIN_IDLE_TIMEOUT_MS     = 1000;
constexpr int64_t IDLE_TIMEOUT_MS_CEILING = 3600000;

/// How many keep-alive intervals a relay may go without a successful write
/// before its claim is considered dead and a reconnect may take it over - the
/// #506 rule, with the same two-interval window the inbox uses.
constexpr int RELAY_KEEPALIVE_MS          = 15000;
constexpr int RELAY_POLL_INTERVAL_MS      = 50;
constexpr int RELAY_CLAIM_STALE_INTERVALS = 2;
} // namespace sse

/**
 * @brief Webhook inbox configuration (issue #480)
 *
 * Rails rather than preferences: every one of these bounds what a *remote*
 * caller can make the engine hold or wait for, so none is user-settable. The
 * canned response a user actually tunes (status, headers, body, delay) is
 * per-inbox request state, not a constant.
 */
namespace inbox {
/// Stored bytes per capture, seeding the `inboxMaxBodyBytes` setting. A larger
/// body is truncated with the flag set.
constexpr int64_t MAX_BODY_BYTES = int64_t{ 64 } * 1024;
/// Bounds on that setting. The floor keeps a capture from being all flag and no
/// payload; the ceiling is the transport limit below, past which nothing is
/// read at all.
constexpr int64_t MIN_BODY_BYTES = 256;

/// Captures retained per inbox, seeding the `inboxMaxCaptures` setting; the
/// oldest are deleted as new ones arrive.
constexpr int64_t MAX_CAPTURES = 500;
/// Bounds on that setting. The ceiling is what one `GET /inbox/:id/requests`
/// page may ask for, so it also bounds how much a single read materialises.
constexpr int64_t MIN_CAPTURES     = 1;
constexpr int64_t CAPTURES_CEILING = 10000;

/// Poll cadence of `GET /inbox/:id/live` against the capture table, seeding the
/// `inboxLivePollIntervalMs` setting.
constexpr int LIVE_POLL_INTERVAL_MS = 250;
/// Bounds on that setting: below the floor the wakeups outweigh the latency
/// they save, above the ceiling a webhook visibly lags its arrival.
constexpr int MIN_LIVE_POLL_INTERVAL_MS = 25;
constexpr int MAX_LIVE_POLL_INTERVAL_MS = 5000;

/// How many poll intervals a live stream may go without a successful write
/// before its claim is considered dead and a reconnect may take it over. A
/// healthy stream writes at least a keep-alive every interval, so two elapsed
/// intervals means it is not writing - see InboxManager::try_claim_live.
constexpr int LIVE_CLAIM_STALE_INTERVALS = 2;
/// Floor under that window, so a 25ms cadence does not make ordinary scheduler
/// jitter look like a dead holder.
constexpr int MIN_LIVE_CLAIM_STALE_MS = 100;

/// Transport limit on one inbound request. Past this the listener answers 413
/// and records nothing - a payload this size is not a webhook. A rail rather
/// than a setting: it bounds what an unauthenticated *remote* caller can make
/// the engine buffer, which is not the local user's preference to spend.
constexpr size_t MAX_PAYLOAD_BYTES = size_t{ 8 } * 1024 * 1024;
/// Upper bound on the canned response's artificial delay. It occupies a
/// listener thread for its whole duration - and the teardown join waits for it
/// - so it is bounded well below any client timeout. A rail for the same
/// reason: it is how long a stop can be made to take, not a preference.
constexpr int MAX_RESPONSE_DELAY_MS = 30000;
/// Page size of `GET /inbox/:id/requests` when the caller names none. Not a
/// setting: the app always sends an explicit `limit`, so an engine-side default
/// would have no reader on the path the app takes.
constexpr int64_t DEFAULT_PAGE_LIMIT = 50;
/// Bounds on `POST /inbox/start`'s `allowedOrigins` (#2367): every inbound
/// request with an `Origin` is compared against the whole list, and an origin
/// (`scheme://host:port`, a 253-byte DNS name at most) never needs more bytes.
constexpr size_t MAX_ALLOWED_ORIGINS       = 32;
constexpr size_t MAX_ALLOWED_ORIGIN_LENGTH = 512;
} // namespace inbox

/**
 * @brief Script validation configuration
 */
namespace script_validation {
/// Maximum failure messages to store in validation results
constexpr size_t MAX_FAILURE_MESSAGES = 10;
} // namespace script_validation

/**
 * @brief Queue and Event Loop configuration
 */
namespace queue {
/// Default capacity for the SPSC queue (must be power of 2)
constexpr size_t CAPACITY = 65536;
/// Number of spins before sleeping in the worker loop
constexpr int SPIN_COUNT = 2000;
} // namespace queue

/**
 * @brief Local OAuth 2.0 mock issuer bounds
 *
 * Rails rather than preferences: every one of these bounds a resource the
 * *caller* does not pay for - listener threads, and two maps a long-lived
 * daemon would otherwise grow one entry per authorize call that never came
 * back for its code. The issuer's actual behaviour (expiry, claims, failure
 * mode, cadence of nothing) is per-issuer request payload, not config.
 */
namespace mock_issuer {
/// Concurrently running issuers. Each owns a listener thread plus cpp-httplib's
/// own accept loop, so this is a thread budget more than anything else.
constexpr size_t MAX_ISSUERS = 8;
/// Clients one issuer may be configured with.
constexpr size_t MAX_CLIENTS = 32;
/// Authorization codes held awaiting their exchange (oldest evicted first).
constexpr size_t MAX_PENDING_CODES = 256;
/// Live refresh tokens held per issuer (oldest evicted first). Rotation spends
/// one and mints one, so this only binds when many are issued and never used.
constexpr size_t MAX_REFRESH_TOKENS = 256;
/// How long an authorization code stays exchangeable. RFC 6749 §4.1.2 asks for
/// a short lifetime; this matches the interactive attempt TTL in
/// oauth_authorize.cpp so the two halves of one flow expire together.
constexpr int64_t CODE_TTL_MS = int64_t{ 5 } * 60 * 1000;
/// Ceiling on the `slow` failure mode's delay. Past a minute the caller is
/// testing its own timeout, and the sleep holds a cpp-httplib pool thread.
constexpr int64_t MAX_SLOW_MS = 60000;
/// Ceiling on a minted token's lifetime (31 days).
constexpr int64_t MAX_EXPIRES_IN_SECONDS = 31LL * 86400LL;
} // namespace mock_issuer

/**
 * @brief Saved example-response bounds (issue #481)
 *
 * A rail, not a preference: an example is stored verbatim in a TEXT column that
 * `GET /requests/:id/examples` returns in full, so the cap bounds what one
 * import - or one caller - can make every later read of that request pay for.
 * Generous enough for the recorded JSON payloads examples exist to hold, and
 * well under the point at which a list response stops being displayable.
 */
namespace request_example {
/// Body bytes per stored example. A larger body is a 400, never a silent
/// truncation: an example whose body is not what the caller sent would be
/// served as if it were (phase 2), and a half-body is worse than a refusal.
constexpr size_t MAX_BODY_BYTES = size_t{ 1024 } * 1024;
/// Examples one request may hold. Bounds the list read and the per-request
/// slice of a bulk import.
constexpr size_t MAX_PER_REQUEST = 100;
/// Bytes of one stored Postman saved response (`postman_response`, schema
/// version 2): the recorded request, its body included, rides in it, so it
/// gets the body's own bound. The importer leaves a larger one out (the
/// export then regenerates it) rather than failing the import; a write that
/// names one anyway is a 400.
constexpr size_t MAX_POSTMAN_RESPONSE_BYTES = MAX_BODY_BYTES;

/**
 * Who wrote the row (issue #588, consumed by the spec sync of #627).
 *
 * Two values and no more: `import` is every row an importer or a spec sync
 * produced, `user` is one a person saved from a live response. Sync may replace
 * the first kind wholesale and must never touch the second, so this is a stored
 * discriminator rather than something a later read could infer - nothing else
 * about the row says where it came from.
 *
 * `import` is the default because it is honest for every row that existed
 * before the column did: until the app could save one, import was the only
 * writer.
 */
constexpr const char* ORIGIN_IMPORT = "import";
constexpr const char* ORIGIN_USER   = "user";
} // namespace request_example

/**
 * @brief Bounds on a declared data contract (issue #599), stated here rather
 * than left implicit - read by the collection write route and by the import of
 * an exported collection's own contract (`vayu_extensions.hpp`).
 *
 * A column name is a `{{data.<name>}}` token's identifier and a header cell of a
 * CSV, so 256 characters is far past anything a real file carries; 1024 columns
 * likewise. They exist so a malformed or hostile payload cannot store a blob
 * that every later reader has to walk - the schema is read on every plan
 * resolution that refuses a data token.
 */
namespace data_schema {
constexpr size_t MAX_COLUMNS      = 1024;
constexpr size_t MAX_COLUMN_CHARS = 256;
} // namespace data_schema

/**
 * @brief Bounds on a collection's `specFile` / `dataFile` binding (issue
 * #2765), in UTF-8 bytes. Each sits just above the longest value any of the
 * three platforms can open, so no real file is refused: a Windows
 * extended-length path is at most 32,767 UTF-16 units of at most 3 UTF-8
 * bytes each (98,301; Linux stops at 4,096 and macOS at 1,024), and a file
 * name at most 255 units or characters (NTFS 765 bytes, APFS 1,020, ext4
 * 255).
 */
namespace file_binding {
constexpr size_t MAX_PATH_BYTES      = size_t{ 96 } * 1024;
constexpr size_t MAX_FILE_NAME_BYTES = 1024;
} // namespace file_binding

/**
 * @brief OpenAPI document bounds (issue #637).
 */
namespace spec_document {
/// Bytes one stored OpenAPI document may hold (config key
/// `maxSpecDocumentBytes`). Aligned with `json::MAX_FIELD_SIZE`, because every
/// later phase parses the stored text back as JSON and that is the ceiling the
/// parse path already carries. Engine-authored so an oversized document is
/// refused with a message naming the count and the cap, the way `MAX_DATA_BYTES`
/// is - the transport's `request_body::MAX_BYTES` refuses without naming it.
constexpr size_t MAX_BYTES = size_t{ 10 } * 1024 * 1024;

/// The largest value `maxSpecDocumentBytes` accepts (its config entry's
/// maximum). `request_body::MAX_BYTES` is derived from it, so raising the
/// setting to its limit never meets a transport bound below it.
constexpr size_t MAX_CONFIGURABLE_BYTES = size_t{ 100 } * 1024 * 1024;

/// Operation rows one stored `spec_documents.operations` index may declare, and
/// the same number of rows a coverage block reports (issue #629).
///
/// A cap on both halves rather than only the report's, because the index is
/// what a run holds in memory for its whole life: an enormous document must not
/// be able to make every scenario run of it carry a proportional allocation.
/// Both places that enforce it *name* what they dropped - the write refuses with
/// the count, the report carries `operationsTruncated` - because a silently
/// shortened coverage block reads as a contract that is smaller than it is.
constexpr size_t MAX_OPERATIONS = 2000;

/// Deepest a stored document may nest before the engine's reader refuses it
/// (issue #853). The reader walks the parsed tree recursively, so this is a
/// stack bound rather than a policy: an OpenAPI document nests tens of levels,
/// a schema that references itself through `$ref` nests none at all (the
/// reference is a string), and a document that nests a hundred is being written
/// at the reader rather than describing an API. A response body is bounded by
/// its own `elements::MAX_BODY_DEPTH`, not by this.
constexpr size_t MAX_READ_DEPTH = 100;

/// Nodes a stored document may expand to when it is read, over and above one
/// per byte of its own text - see `core/openapi_document.hpp`.
///
/// The budget is proportional to the input because that is the shape of what it
/// refuses: YAML aliases are the only way a document expands past its own size,
/// so an alias bomb (200 bytes resolving to millions of nodes) is refused while
/// the densest honest document - a flow sequence, about one node per two bytes
/// - passes with half the budget unspent.
constexpr size_t READ_NODES_FLOOR = 4096;

/// The absolute ceiling on that budget, whatever `maxSpecDocumentBytes` is
/// raised to. The DOM is held whole while the index is extracted, so this is
/// the memory bound of a single write.
constexpr size_t MAX_READ_NODES = size_t{ 4 } * 1000 * 1000;

/// Status codes one coverage row may list under `statusesSeen`/`undeclaredSeen`.
/// A misconfigured target can answer one operation with hundreds of distinct
/// codes; the row stays readable and says how many distinct codes it hides -
/// `statusesTruncated` counts what *neither* list carries, since the two are
/// capped separately and the undeclared one repeats codes from the other.
constexpr size_t MAX_STATUSES_PER_OPERATION = 50;
} // namespace spec_document

/**
 * @brief The URL-import proxy's bounds (issue #784).
 */
namespace import_fetch {
/// Bytes `POST /import/fetch` will read from a remote URL when the caller
/// states no `maxBytes` of its own - and the ceiling a stated one is clamped to.
///
/// A transport ceiling, deliberately not the document cap. The route is one
/// shared proxy for *every* URL import - Postman and Insomnia exports ride it
/// as well as OpenAPI documents - and a Postman collection is never stored as a
/// `spec_documents` row, so `maxSpecDocumentBytes` governs nothing about it;
/// capping the fetch there would refuse a collection that imports today with a
/// message naming a setting that has nothing to do with it. So the *caller*
/// states the bound it knows (the spec paths pass the live
/// `maxSpecDocumentBytes`), and this stands behind it, because a bound the
/// caller chooses is not a bound against a hostile URL.
///
/// Set above the largest `maxSpecDocumentBytes` a user can configure (100 MiB,
/// the config entry's own maximum) so that raising that setting to its limit
/// can never be silently narrowed by this one.
constexpr size_t MAX_BYTES = 256ULL * 1024 * 1024;

/// How rarely a streamed download's progress is worth saying out loud
/// (issue #882).
///
/// The client reports every curl write - roughly every 16 KiB - which for a
/// 10 MB spec is ~640 reports for a bar with a few hundred pixels to cross.
/// Either bound releases an SSE frame: the byte one keeps a fast download's bar
/// moving smoothly, and the time one keeps a slow one's from looking stalled.
constexpr uint64_t PROGRESS_EVERY_BYTES = 256ULL * 1024;
constexpr long PROGRESS_EVERY_MS        = 100;

/// How long a fetch may sit below a trickle before it is abandoned, and what
/// counts as a trickle (issue #882).
///
/// Replaces the 30s *total* this route inherited from `Request::timeout_ms`,
/// which bounded a download's size rather than its health - 10 MB needed better
/// than 340 KB/s just to arrive. 30s of near-silence is a dead transfer; 30s of
/// steady bytes is a large file. The floor is deliberately near zero, because
/// the question is whether anything is arriving at all and not whether it is
/// arriving quickly: a genuinely slow link should finish, slowly.
constexpr long STALL_TIMEOUT_MS          = 30000;
constexpr long STALL_FLOOR_BYTES_PER_SEC = 256;

/// The three events a streamed `/import/fetch` emits (issue #882).
///
/// A wire contract, so it is stated once on each side rather than spelled out at
/// the send and again at the read: the renderer mirrors these in
/// `app/src/constants/import.ts`, and a name that drifted would leave a download
/// reporting into a branch nothing takes - silently, because an unknown event is
/// an event a reader skips.
constexpr const char* EVENT_PROGRESS = "progress";
constexpr const char* EVENT_RESULT   = "result";
constexpr const char* EVENT_ERROR    = "error";
} // namespace import_fetch

/**
 * @brief What the management API reads as a request body (issue #1824).
 */
namespace request_body {
/// What an import route allows over its document for the JSON string the
/// document travels in: quotes and newlines grow it, so half the document cap
/// again plus this covers any real document. The route's exact check on
/// `content` stays the precise one.
constexpr size_t IMPORT_HEADROOM_BYTES = size_t{ 1 } * 1024 * 1024;

/// The body an import route (`POST /import`, `/import/parse`,
/// `/import/document`) admits under a given `maxSpecDocumentBytes`.
constexpr size_t import_limit (size_t document_cap) {
    return document_cap + (document_cap / 2) + IMPORT_HEADROOM_BYTES;
}

/// The largest body any management route reads, judged from `Content-Length`
/// before a byte of it is read and applied to cpp-httplib as its own read
/// bound. A fixed ceiling rather than a live one: cpp-httplib's limit is a
/// plain member its worker threads read unsynchronised, so it cannot follow a
/// setting changed while the server runs. Derived from the largest values the
/// two body-size settings accept, so raising either to its limit still fits;
/// the live, tighter bound on an import body is `import_limit`.
constexpr size_t MAX_BYTES = import_limit (spec_document::MAX_CONFIGURABLE_BYTES);
static_assert (MAX_BYTES > scenario::MAX_CONFIGURABLE_DATA_BYTES + IMPORT_HEADROOM_BYTES,
"a collection run carrying the largest data set maxScenarioDataBytes allows "
"must still fit under the body ceiling");

/// Deepest a JSON request body may nest where `parse_request_json` reads it
/// (#2417). A stack bound, not a policy: nlohmann parses iteratively but
/// `dump ()` and the copy constructor recurse, and the routes do each to the
/// whole body or to a field of it. A data cell
/// (`spec_document::MAX_READ_DEPTH`, #2362) sits up to four levels below the
/// body (`scenario` > `data` > row > cell), so a cell at its own bound must
/// still fit under this one.
constexpr size_t MAX_JSON_DEPTH = 128;
static_assert (MAX_JSON_DEPTH >= spec_document::MAX_READ_DEPTH + 4,
"a data cell nested to its own bound must not trip the body's");
} // namespace request_body

/**
 * @brief Response schema validation bounds (issue #628).
 *
 * Every value here bounds what one *response* can make the engine do or store,
 * because the schema comes from a document a user imported and the body comes
 * from a server neither of them controls.
 */
namespace schema_validation {
/// Failure messages one verdict carries. The whole count rides beside them as
/// `failuresTotal`, the `MAX_FAILURE_MESSAGES` discipline: a bounded list that
/// says what it is a list *of*, never a shortened one that reads as complete.
constexpr size_t MAX_FAILURES = 10;

/// Bytes one failure message may carry. The validator's messages quote the
/// offending instance, so a body of a megabyte can produce a message of one.
constexpr size_t MAX_FAILURE_MESSAGE_BYTES = 500;

/// Schema nodes the dialect walk visits before it stops counting. A cycle
/// guard already covers `$ref` loops; this covers a schema that is merely
/// enormous, so an imported document cannot make a single response walk
/// forever. Reaching it can only under-count a disclosure, never miss a
/// validation - the validator itself has already run.
constexpr size_t MAX_SCHEMA_NODES = 20000;
} // namespace schema_validation

/**
 * @brief What a run's `warnings` array bounds (issue #1503).
 *
 * A run is not refused for carrying a mistake it can still finish measuring -
 * an unresolved `{{token}}`, a script that never ran - only told about it, so
 * these bound what the telling costs rather than what the run does.
 */
namespace warnings {
/// Distinct unresolved-token names one warning line names. The count beside
/// them already says how many requests were affected; this only bounds how
/// long the list of names grows, the same "bounded list that says what it is
/// a list of" discipline `schema_validation::MAX_FAILURES` follows.
constexpr size_t MAX_UNRESOLVED_TOKEN_NAMES = 5;
} // namespace warnings

/**
 * @brief Local mock server bounds (issue #481 phase 2)
 *
 * Rails rather than preferences, the same split the inbox and the issuer draw:
 * every value here bounds a resource the *caller* of the mock does not pay for
 * - listener threads, and the route table one collection can make the engine
 * hold. What a user actually tunes per mock (latency, error rate) is request
 * payload, not config.
 */
namespace mock_server {
/// Concurrently running mocks. Each owns a listener thread plus cpp-httplib's
/// own accept loop, so this is a thread budget - the same one the issuer's
/// MAX_ISSUERS is.
constexpr size_t MAX_SERVERS = 8;
/// Routes one mock may hold. A collection tree is walked whole at start, so
/// this bounds what a single `POST /mock/start` materialises; past it the start
/// is refused rather than the tail silently dropped.
constexpr size_t MAX_ROUTES = 2000;
/// Ceiling on the injected per-response delay. It holds a cpp-httplib pool
/// thread for its whole duration - and the teardown join waits for it - so it
/// is bounded well below any client timeout, exactly as the inbox's canned
/// delay is.
constexpr int MAX_LATENCY_MS = 30000;

/// Activity entries kept per mock (issue #481 phase 3). A running mock's
/// own memory, not the database - bounded so a mock hammered by a load run
/// does not grow without limit for the whole time it stays up.
constexpr size_t MAX_ACTIVITY_ENTRIES = 200;

/// Bounds on `POST /mock/start`'s `allowedOrigins` (#2367), for the reason
/// the inbox's are bounded: every request with an `Origin` scans the list.
constexpr size_t MAX_ALLOWED_ORIGINS       = 32;
constexpr size_t MAX_ALLOWED_ORIGIN_LENGTH = 512;
} // namespace mock_server

/**
 * @brief Database optimization configuration
 */
namespace database {
/// SQLite cache size in bytes (67108864 = 64MB, converted to negative KB for SQLite PRAGMA)
constexpr int CACHE_SIZE_BYTES = 67108864;
/// SQLite temp store mode (0=default, 1=file, 2=memory)
constexpr int TEMP_STORE = 2;
/// SQLite memory-mapped I/O size in bytes: 0, off (#2433). An I/O error inside
/// a mapped region is a signal (SIGBUS on POSIX), not SQLITE_IOERR, so a failing
/// disk or an externally truncated file would kill the engine with no log line
/// and no 500. Mapping 256 MB cut SQLite's read time by 5-55%: 1-6 ms per
/// 1,000 result rows, about 50 ms at the default 10,000 stored errors (Windows,
/// OS cache warm; docs/engine/db-schema.md has the numbers) - not worth that.
/// Windows also refuses to truncate a mapped file, which `reclaim_freed_pages`
/// needs.
constexpr size_t MMAP_SIZE_BYTES = 0;
/// WAL autocheckpoint frequency in pages
constexpr int WAL_AUTOCHECKPOINT = 1000;
/// `journal_size_limit` in bytes (64 MiB): the size the `-wal` file is cut back
/// to once a checkpoint has emptied it and the next write restarts the log.
/// The autocheckpoint is passive and never shrinks the file, so one large
/// transaction (a run prune, a big import) would otherwise leave its
/// high-water mark on disk for the rest of the engine session; only a clean
/// shutdown or the startup VACUUM gives it back (#2433).
constexpr int64_t JOURNAL_SIZE_LIMIT_BYTES = 67108864;
/// SQLite busy timeout in milliseconds (10 seconds)
constexpr int BUSY_TIMEOUT_MS = 10000;
/// SQLite synchronous mode (0=OFF, 1=NORMAL, 2=FULL), the default for
/// `dbSynchronous` (#2419). In WAL, NORMAL syncs the WAL only at a checkpoint,
/// so a commit costs no fsync and the throughput matches OFF. It cannot
/// corrupt the file on power loss, but the last transactions since the final
/// checkpoint may be lost. FULL adds a sync per commit and loses nothing. OFF
/// hands the file to the OS and can corrupt it on power loss or an OS crash.
constexpr int SYNCHRONOUS = 1;
/// Rows `Database::add_results_batch` writes per transaction, releasing the
/// DB mutex between chunks so a report poll waits on one chunk rather than the
/// whole flush (#2548). 10,000 rows took ~270 ms in a Release build, so 250
/// hold the lock for about 7 ms.
constexpr size_t RESULTS_WRITE_CHUNK_ROWS = 250;
/// Run retention: keep at most N most-recent load and collection runs
/// (0 = unlimited). Design Sends are counted apart, under the cap below.
constexpr int MAX_RUNS_RETAINED = 200;
/// Run retention: keep at most N most-recent single-request Sends
/// (0 = unlimited, #2429). A separate count so an afternoon of Sends cannot
/// evict the load and collection runs `MAX_RUNS_RETAINED` keeps; half that cap
/// because a Send is cheap to repeat and a load run is not.
constexpr int MAX_DESIGN_RUNS_RETAINED = 100;
/// Run retention: delete runs older than N days (0 = unlimited).
constexpr int RUN_RETENTION_DAYS = 30;
/**
 * Trash retention: purge collections, requests, environments and saved
 * examples deleted more than N days ago (0 = keep them forever), swept at
 * startup (issue #988, environments #2970, examples #2971).
 *
 * Thirty days for the same reason runs get thirty: the mistake soft delete
 * exists to undo - a collection removed by a misclick - is usually noticed the
 * same day, and the tail is someone coming back from a month away. A stamped
 * subtree costs only the rows it already occupied, so the ceiling is about not
 * growing the file forever rather than about reclaiming space soon.
 */
constexpr int TRASH_RETENTION_DAYS = 30;
/**
 * Workspace backups: keep at most N snapshots in `backups/` (0 = unlimited).
 *
 * Five rather than one, because the failure a backup guards against is often
 * noticed late - a collection deleted last week is discovered missing today -
 * and a single slot would have been overwritten by then. Each snapshot is a
 * compacted copy of the whole workspace, so the ceiling is about disk: five is
 * a few times the live file for a workspace of any ordinary size.
 */
constexpr int MAX_BACKUPS_RETAINED = 5;
/**
 * The longest the shutdown refresh of `<db>.bak` may copy for (#2421), before
 * it is interrupted and the previous backup stands. A copy measured 177 ms
 * warm and 1.1 s cold on a 280 MB workspace; two seconds covers that inside
 * `server::SHUTDOWN_WINDOW_MS` with the rest of the teardown still to run. The
 * daemon passes what is left of that window and the smaller of the two wins.
 */
constexpr int64_t SHUTDOWN_BACKUP_DEADLINE_MS = 2000;
/**
 * How recently a stored OpenAPI document must have arrived to be spared by the
 * orphan sweep, whatever else says nothing references it (issue #718).
 *
 * Binding a collection is three writes over three requests, and the *document*
 * is the first of them: between `POST /specs` and the `PUT /collections/:id`
 * that names it, a document is bound by nobody and pinned by no run - exactly
 * the shape of an orphan. Ten minutes is far longer than that window and far
 * shorter than the interval between the passes that sweep, so a document this
 * spares is reclaimed by the next one rather than kept.
 */
constexpr int64_t SPEC_DOCUMENT_SWEEP_GRACE_MS = 600'000;
/**
 * Startup reclamation (issue #990): how much of the database must be free pages
 * before the startup sweep rewrites it to return them to the filesystem.
 *
 * Deleting rows only moves their pages to SQLite's freelist, where they are
 * reused but never given back, so a workspace that once held weeks of heavy
 * runs keeps that high-water mark forever. A `VACUUM` gives it back and costs a
 * rewrite of the whole file, which is why it is a threshold and not a policy.
 */
constexpr int VACUUM_MIN_FREELIST_PERCENT = 25;
/**
 * The second half of that threshold: how many bytes the free pages must hold.
 *
 * Both halves must be crossed, and each is what makes the other safe. The
 * fraction alone rewrites a nearly-empty workspace on every start, since a
 * database holding one collection is mostly freelist the moment anything is
 * deleted from it. The byte floor alone rewrites four gigabytes to win back
 * eleven megabytes.
 */
constexpr int64_t VACUUM_MIN_RECLAIMABLE_BYTES = 10LL * 1024 * 1024;
} // namespace database

/**
 * @brief Element pipeline configuration
 */
namespace elements {
/// Default value of the `maxElementBodyBytes` config entry (issue #1514). A
/// response past this is not parsed as JSON, and every JSON-reading kind on
/// that step (`extract.json`, `assert.jsonpath`, ...) reports `skipped`
/// rather than paying for - or failing on - a parse of an oversized body.
constexpr size_t MAX_BODY_BYTES = size_t{ 1024 } * 1024;

/// Deepest a response body may nest and still be handed to the JSON-reading
/// kinds (issue #2361). nlohmann's parser is iterative, so a body of any depth
/// parses; the recursion is in what the kinds do with the tree afterwards
/// (`dump`, a copy of a matched subtree), and a body of ~100 KB of `[` is enough
/// to overflow a worker's stack there. A deeper body is dropped as if it were
/// not JSON. Its own constant rather than `spec_document::MAX_READ_DEPTH`
/// because the two bound different things: that one is an OpenAPI document's
/// policy, this one is a stack bound on untrusted server output, and tuning
/// either should not move the other. Real API responses nest a handful of
/// levels; 100 leaves them every margin.
constexpr size_t MAX_BODY_DEPTH = 100;

/// The `skipped` reason every JSON-reading kind reports when
/// `ensure_parsed_body` returns null. One literal, so the kinds cannot drift
/// apart on what a skip means. `maxElementBodyBytes` stays in it: the setting
/// is the one a user can act on, and `element_body_bound_test.cpp` pins it.
constexpr std::string_view BODY_UNREADABLE_MESSAGE =
"response body is not JSON, nests too deeply, or exceeds maxElementBodyBytes";
} // namespace elements
} // namespace vayu::core::constants
