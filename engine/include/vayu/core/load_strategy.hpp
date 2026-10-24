#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "vayu/core/capacity_controller.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/event_loop.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

struct RunContext; // Forward declaration

/**
 * @brief The `data` rows a **single-request** load run binds, split once
 *        (issue #993).
 *
 * Before this, `{{data.column}}` bound on the scenario path alone, so the
 * canonical load shape - one request, N users, a row each - was expressible
 * only by wrapping the request in a one-step collection. The rows now ride the
 * run payload's top-level `data`, validated by the same `read_data_rows` the
 * scenario block goes through, and are claimed one per submission off a
 * run-wide cursor that wraps: a run longer than the set repeats it, exactly as
 * a scenario run's iterations do.
 *
 * **Null on the context for every run sent without rows**, and that emptiness
 * is the throughput guard made structural: the strategies test one pointer and
 * otherwise submit the shared request they always did - no copy, no claim, no
 * annotation. Nothing here is per-iteration work a token-free run can pay.
 *
 * The request's own bindable fields are **not** here: they are split off the
 * built request onto `RunContext::load_template`, because a run with no rows at
 * all still binds its `{{$vu}}` / `{{$iteration}}` identity (issue #994). Nor
 * are the credentials, for the same reason and since issue #1055 - see
 * @ref LoadAuthPlan. This carries what only a data set has: the rows, and the
 * bare names they answer.
 */
struct LoadDataSet {
    /// The validated rows, in payload order. Never empty - a present-but-empty
    /// `data` array is refused by the route, and a run without rows carries no
    /// set at all.
    std::vector<nlohmann::json> rows;
    /// The bare column names @ref rows can bind (issue #1007), read off the
    /// rows once by `core::bound_columns_of`. It is what the run's split is
    /// told, so a bare `{{username}}` this set answers is bound per iteration
    /// rather than sent as the literal token - and a run without rows carries
    /// no set at all, so it is told nothing and splits as it always did.
    vayu::http::BoundColumnNames bound_columns;
    /// The file @ref rows came from, as the caller named it (issue #2051,
    /// `core::read_data_file_fields`). Empty when none was named; recorded in
    /// the run's snapshot, never read by the run itself.
    DataFileProvenance file;
};

/**
 * How a *single-request* load run resolves its credentials (issue #1055).
 *
 * Beside @ref LoadDataSet rather than inside it, for the reason
 * `RunContext::load_template` is: a credential carrying `{{$vu}}` defers on a
 * run that has no rows at all, so a set that only exists when rows do cannot be
 * where this lives. That was the whole of the old rule - deferral keyed to the
 * run's shape rather than to what the credentials carry - and it is what made
 * an identity token in a credential go out written as it stood.
 *
 * Empty credentials and no @ref after_scripts are the ordinary run, whose auth
 * the build resolves once as it always did.
 */
struct LoadAuthPlan {
    /**
     * The parsed auth, read only when the request's build was deferred
     * (@ref auth_resolution) and so carries no credential until a submission
     * applies it. Unread for every run whose auth the build applied.
     */
    vayu::http::Auth auth;
    /// The credentials split around their `{{data.column}}` and
    /// `{{$vu}}` / `{{$iteration}}` tokens; empty when none carries one.
    StepDataTemplate credentials;
    /**
     * A credential holds a name only the variable scopes answer
     * (`credentials_await_scripts`, issue #2473) **and** the run declares
     * `requestElements` (@ref declares_request_elements), whose `step.before`
     * and residual pass are what can answer it after the build. Each
     * submission then joins its row into a copy of @ref auth without applying
     * it and applies it after that pass (`routes::resolve_load_residuals`).
     *
     * False on a run without `requestElements`: nothing after the build
     * answers such a name there, so the build encodes it as written, as it
     * always did, and the run keeps sending one shared request.
     */
    bool after_scripts = false;

    /// What `build_request` must be told: credentials bound or resolved after
    /// the build must not be encoded during it. Derived rather than stored, so
    /// it cannot disagree with @ref credentials or @ref after_scripts.
    [[nodiscard]] vayu::http::AuthResolution auth_resolution () const {
        return credentials.empty () && !after_scripts ?
        vayu::http::AuthResolution::Apply :
        vayu::http::AuthResolution::Defer;
    }
};

/**
 * @brief Check every file a single-request load run can send, once, before it
 * starts (`http/file_ref.hpp`).
 *
 * @p request as it stands when its file paths hold no token - a binary body's
 * bytes are then read into it - and otherwise each distinct path @p data's rows
 * bind into it. Answers the refusal, naming the row where one is at fault.
 */
[[nodiscard]] std::optional<std::string> plan_load_files (vayu::http::FilePlan& files,
vayu::Request& request,
const LoadDataSet* data);

/**
 * @brief Closed-loop concurrency controller. Seeds target(0), then refills the
 * in-flight deficit toward target(t) - woken per completion via refill_cv with
 * a 50ms safety-net timeout (drives ramp growth + bounds stop latency).
 *
 * Shared by the single-request strategies and the scenario load executor, which
 * differ only in what @p submit_one submits: "another copy of the one request"
 * versus "the next step of virtual user *k*". Every other property - the
 * single-producer discipline, the pure `compute_refill_deficit`, the SPSC
 * submission path - is the same for both, so there is deliberately one copy of
 * this loop rather than one per executor.
 *
 * @param submit_one   attempts one submission and increments requests_sent;
 *                     returns whether it actually submitted (a scenario load
 *                     run's virtual users can all be deferred by a timer, in
 *                     which case it does neither - issue #1596)
 * @param target_fn    desired in-flight at elapsed_ms
 * @param budget_fn    remaining submission budget (SIZE_MAX for time-bounded)
 * @param should_continue  whether to keep refilling at elapsed_ms
 * @param deferred_wait_ms_fn  ms until the earliest candidate @p submit_one
 *                     skipped over is due, valid only right after it returned
 *                     false because every remaining candidate is deferred
 *                     rather than merely without budget; `nullopt` otherwise.
 *                     A deferred user is never in flight, so without this the
 *                     `in_flight() < target` wait predicate stays true for as
 *                     long as any user is deferred and the loop busy-spins
 *                     (issue #1596). Single-request strategies have no notion
 *                     of deferral and omit it.
 */
void maintain_concurrency (std::shared_ptr<RunContext> context,
const std::function<bool ()>& submit_one,
const std::function<size_t (int64_t)>& target_fn,
const std::function<size_t ()>& budget_fn,
const std::function<bool (int64_t)>& should_continue,
const std::function<std::optional<int64_t> ()>& deferred_wait_ms_fn = {});

/**
 * The moving parts of a capacity search that the pure controller deliberately
 * does not hold: the clock, the tick feed, and the level being measured.
 * Declared here rather than kept file-local so a test can drive it with ticks
 * it publishes itself.
 *
 * All of it is touched from the `maintain_concurrency` closures, which run on
 * the strategy thread and nowhere else - `target_fn` is evaluated inside the
 * refill condition-variable predicate, but a predicate runs on the waiting
 * thread, so there is one thread here and no lock is owed.
 */
class CapacitySearch {
    public:
    CapacitySearch (CapacityConfig config, std::shared_ptr<RunContext> context);

    /// The level to hold right now. Zero before the first level opens, which
    /// only happens if `advance` has not been called yet.
    [[nodiscard]] size_t level () const {
        return current_;
    }

    /**
     * Drive the search one step. Returns whether the run should keep going -
     * this is `maintain_concurrency`'s `should_continue`, so returning false
     * ends the run.
     */
    bool advance (int64_t elapsed_ms);

    /// What the search found. The level still being measured when the run ended
    /// is dropped: `levels[]` holds judged windows only, and a partial one
    /// would sit in the audit trail looking like a measurement.
    [[nodiscard]] CapacitySummary finish () const;

    private:
    void open_level (size_t level, int64_t now_ms);
    void collect_tick ();

    CapacityConfig config_;
    std::shared_ptr<RunContext> context_;
    std::vector<CapacityWindow> history_;
    size_t current_           = 0;
    int64_t level_started_ms_ = 0;
    uint64_t last_sequence_   = 0;
    size_t ticks_seen_        = 0;
    size_t rps_windows_       = 0;
    double rps_sum_           = 0.0;
    /// The epoch this level's reset request was answered with; 0 until the
    /// level has settled and asked for one.
    uint64_t level_epoch_ = 0;
    /// The newest tick's level reading under `level_epoch_`.
    size_t level_samples_    = 0;
    double level_p99_ms_     = 0.0;
    size_t level_completed_  = 0;
    size_t level_failed_     = 0;
    double level_error_pct_  = 0.0;
    const char* stop_reason_ = nullptr;
};

/**
 * @brief Read a run-config duration field ("30s", "500ms", "5m", "2h") as
 *        milliseconds; @p default_ms when the key is absent or null.
 *
 * A JSON number is read as seconds. Anything else - an unknown unit, a
 * non-numeric string, a negative - throws `std::invalid_argument`, which the
 * run thread's caller turns into a Failed run naming the value. The old parser
 * silently ran for 60s instead, so a mistyped duration looked like a run that
 * simply took longer; every executor reads durations through here so none can
 * reintroduce that.
 */
[[nodiscard]] int64_t
duration_field_ms (const nlohmann::json& config, const std::string& key, int64_t default_ms);

/**
 * @brief The rule `duration_field_ms` reads one present, non-null value by:
 *        milliseconds, or `nullopt` where that function throws.
 *
 * Exposed so the route can refuse a value before the run row exists by asking
 * the reader itself (#1893), rather than through a second grammar that could
 * disagree with it about a spelling.
 */
[[nodiscard]] std::optional<int64_t> duration_value_ms (const nlohmann::json& value);

/**
 * @brief The arrival rate a run config asks for: `rps`, or `targetRps` when
 *        `rps` is absent, null or 0; 0 when neither names one.
 *
 * Every reader of the two fields goes through here (the route's refusals, the
 * scenario validator, the report), so none can disagree about what "asked for
 * a rate" means. Whether the run *paces* at it is `open_loop_rate`'s answer.
 * A non-numeric value throws, as `json::value` would.
 */
[[nodiscard]] double requested_rps (const nlohmann::json& config);

/**
 * @brief Whether @p config's `mode` is `constant_rps`, the one mode a rate
 *        paces (#2396). An absent or null `mode` is, because
 *        `LoadStrategy::create` reads it so.
 */
[[nodiscard]] bool is_constant_rps_mode (const nlohmann::json& config);

/**
 * @brief The rate a run paces at: `requested_rps` on a `constant_rps` run, 0 on
 *        every other mode whatever the config carries (#2396).
 *
 * The one switch for both halves of open loop: `ConstantLoadStrategy`'s
 * rate-limited path and the event loop's per-worker token bucket. The route
 * refuses a rate on another mode, so a non-zero rate reaching a closed-loop
 * mode here is a stored or hand-built config, and it must not change the load
 * model the run is labelled with.
 */
[[nodiscard]] double open_loop_rate (const nlohmann::json& config);

/**
 * @brief Whether the executor a run config selects returns at a submission
 *        deadline (#2392): every mode bounded by `duration`, on either load
 *        shape.
 *
 * False for `iterations`, single-request (including an unrecognised mode
 * carrying `iterations`, which `LoadStrategy::create` reads as one) and
 * scenario alike: that closed loop
 * returns on its last submission while the batch before it is still in flight,
 * so a window measured to the return counts that batch without the service
 * time that paced every earlier one. The run's sending window is then its
 * whole duration instead.
 */
[[nodiscard]] bool returns_at_send_deadline (const nlohmann::json& config);

/**
 * @brief Why a run payload's top-level `elements` override cannot run, or
 *        `nullopt` if it can (issue #1495).
 *
 * `{ timers: "asConfigured" | "off", scripts: "asMarked" | "allInline" |
 * "allDeferred", includeScriptTime: false }` - every key optional, an unknown
 * key or an out-of-set value refused by name rather than ignored, the same
 * `known_scenario_keys` discipline issue #1503 gave the `scenario` block.
 * Validated for both load-run shapes - the check does not distinguish them -
 * though only a scenario load run's element pipeline reads what it resolves
 * to; a single-request payload has no `elements` attachment point yet (see
 * `docs/engine/elements.md`'s Load paths section). Checked by the route
 * before the run row exists; `RunContext`'s constructor re-derives the same
 * three fields from a payload this has already accepted, so it never has to
 * throw over one this validator would have refused first.
 */
[[nodiscard]] std::optional<std::string> validate_elements_run_override (
const nlohmann::json& config);

/**
 * @brief Why a run payload's top-level `lifecycleElements` cannot run, or
 *        `nullopt` if it can (issue #1573).
 *
 * A single-request `POST /runs` payload's own place to declare `script.setup`
 * / `script.teardown`: it has no collection row to declare them on, and the
 * top-level `elements` key is already the load-run override object
 * `validate_elements_run_override` reads. An array of element descriptors,
 * the same shape a collection's own `elements` column holds - every entry
 * `{id?, kind, config, enabled?}` - restricted by name to the two kinds that
 * dispatch at a run's own boundary rather than a step's; any other kind is
 * refused naming the index and kind, not silently ignored or run as if it
 * were one of the two. Refused outright beside a `scenario` block, whose
 * collection already has a real `elements` column for this. Placement is
 * checked with `ElementOwner::Collection`, the same owner
 * `script.setup`/`.teardown`'s `collection_only` flag already expects.
 */
[[nodiscard]] std::optional<std::string>
validate_lifecycle_elements_run_override (const nlohmann::json& config);

/**
 * @brief Why a run payload's top-level `requestElements` cannot run, or
 *        `nullopt` if it can (issue #1594).
 *
 * A single-request `POST /runs` payload's own place to declare its request's
 * step-level elements (`extract.*`, `assert.*`, `timer.think`, `script.pre`,
 * `script.post`, ...) - a distinct key from `elements`, which is already the
 * run-level `timers`/`scripts`/`seed`/`includeScriptTime` override object
 * `validate_elements_run_override` reads, and a flat single-request payload
 * has no `request` sub-object to nest a request-shaped `elements` array
 * under. An array of element descriptors, the same shape a stored request's
 * own `elements` column holds, validated with `ElementOwner::Request` (no
 * kind restricted the way `lifecycleElements`' two kinds are). Refused
 * outright beside a `scenario` block, whose steps already carry their own
 * resolved `elements` from the plan.
 */
[[nodiscard]] std::optional<std::string>
validate_request_elements_run_override (const nlohmann::json& config);

/**
 * @brief Whether a single-request run @p config declares any
 *        `requestElements` (issue #1594): a non-empty array.
 *
 * The one test `RunContext::step_elements` is compiled under and the route's
 * auth plan (@ref LoadAuthPlan::after_scripts) is decided under, so a run whose
 * auth waits on its submissions' residual pass always has one.
 */
[[nodiscard]] bool declares_request_elements (const nlohmann::json& config);

/**
 * @brief How long a `constant_rps` tick sleeps before it spins out the rest of
 *        @p remainder_us, in microseconds. 0 means spin the whole remainder.
 *
 * The tick's wait is split because a Windows `sleep_for` overshoots by ~0.6-1.8
 * ms typical whatever it is asked for, so a tick that sleeps its whole
 * remainder always lands late and the next one dispatches two requests at once
 * to catch up - the rate stays exact, the arrival interval does not (issue
 * #1370). Sleeping all but the last `pacing::spin_tail_us (remainder_us)`
 * puts the overshoot inside the spin instead of inside the gap, and bounds
 * the spin at the tail however slow the rate.
 *
 * Every platform's `wait_for_next_tick` calls this now (issue #1667 extended
 * the Windows-only #1370 shape to Linux/macOS's own precise-sleep primitive,
 * `platform::sleep_until_precise`); only the *tail* size
 * (`constants::pacing::spin_tail_us`) is platform-specific, because each
 * platform's sleep call overshoots by a different amount, and on macOS by a
 * different shape (flat on Windows/Linux, proportional-with-cap on macOS).
 * Declared unconditionally because the arithmetic is the whole of the
 * decision and is worth testing on any host.
 */
[[nodiscard]] constexpr int64_t tick_sleep_leg_us (int64_t remainder_us, int64_t spin_tail_us) {
    return remainder_us > spin_tail_us ? remainder_us - spin_tail_us : 0;
}

// The rule itself, checked by every build that reaches this header rather than
// only by the one CI leg whose test binary links. The literals are the stock
// tail: 400 RPS, 200 RPS, the boundary, a ~500 RPS tick, and a remainder a
// slow caller has already overrun.
static_assert (tick_sleep_leg_us (2500, 2000) == 500);
static_assert (tick_sleep_leg_us (5000, 2000) == 3000);
static_assert (tick_sleep_leg_us (2000, 2000) == 0);
static_assert (tick_sleep_leg_us (1000, 2000) == 0);
static_assert (tick_sleep_leg_us (-100, 2000) == 0);

/**
 * @brief Facts about a completion that only the executor knows, attached to
 *        whatever record the completion produces.
 *
 * A scenario load run binds a data row per iteration (issue #449); without the
 * row on the record, a failure is unattributable - "which row produced this
 * 400" is the question a data-driven run exists to answer. A struct rather than
 * a parameter, so a second such fact does not move every call site again.
 */
struct ResultAnnotations {
    /// Absent for a run sent without `data` - the record then carries no
    /// `dataRowIndex` at all rather than a zero that reads like row 0. Carried
    /// by either shape since issue #993: a single-request run binds rows too.
    std::optional<size_t> data_row_index;
    /**
     * The plan step this completion belongs to. Set by the scenario load
     * executor and by nothing else, so its presence *is* how `handle_result`
     * tells a scenario completion from a single-request one - which is what
     * routes the response to the step's own sample reservoir instead of the
     * run's (issue #450).
     */
    std::optional<size_t> step_index;
    /**
     * The iteration this completion ran in, 0-based: a virtual user's own on
     * the scenario path, and the submission index on the single-request one
     * (issue #994). Set by both load executors now, which is what lets a
     * deferred script read `pm.info.iteration` whichever shape the run took.
     */
    std::optional<size_t> iteration;
    /**
     * The virtual user this completion belongs to, **1-based**. `1` for every
     * submission of a single-request run - one request repeated is one user's
     * iterations, whatever the concurrency - and the user's own index on the
     * scenario path.
     */
    std::optional<size_t> vu;
    /**
     * Element-pipeline time to fold into the run's latency population beside
     * the transfer (#2792). Non-zero only on a scenario load run under
     * `elements.includeScriptTime`, set to what that step's own histogram
     * folded, so the run and its steps measure one population. The stored
     * trace's `totalMs` and the slow decision stay on the transfer, the
     * figure the trace's phase breakdown describes.
     */
    double script_ms = 0.0;
};

/**
 * @brief Whether @p error is a transfer a user Stop cancelled (#2136).
 *
 * The event loop cancels with `ErrorCode::Cancelled` on both of a run's ways
 * out: a Stop (`should_stop` set, `stop(false)`) and the natural end's drain
 * deadline. Only the first is not an error. A request still in flight past its
 * own bound plus the grace (`natural_end_drain_ms`) never answered, and is
 * counted as the failure it is.
 */
[[nodiscard]] bool is_stop_cancellation (const RunContext& context, const vayu::Error& error);

/**
 * @brief Record a completed transfer into the run's in-memory MetricsCollector.
 *
 * Every completion - success, a Response carrying a client-side error, and a
 * transport-level Error alike - must land here: the collector's counters are
 * what drive in_flight() accounting and the closed-loop refill wakeup, so a
 * dropped completion is a permanently leaked in-flight slot.
 *
 * Declared here (rather than kept file-local) so the failure paths can be
 * tested directly; production callers are the strategies in load_strategy.cpp.
 *
 * @param db Unused, kept for API compatibility - metrics are batch-written
 *           to the database after the run completes, not from here.
 * @param annotations Reaches the stored record only where one is stored: an
 *           unsampled success keeps no trace, so there is nothing to annotate.
 */
void handle_result (const std::shared_ptr<RunContext>& context,
vayu::db::Database& db,
const vayu::Result<vayu::Response>& result,
const ResultAnnotations& annotations = {});

/**
 * @brief Interface for load testing strategies
 */
class LoadStrategy {
    public:
    LoadStrategy ()          = default;
    virtual ~LoadStrategy () = default;
    // Deleted rather than protected: nothing copies a strategy - they are held
    // by pointer and run in place - and deleting is what stops a derived one
    // being sliced back to this interface.
    LoadStrategy (const LoadStrategy&)            = delete;
    LoadStrategy& operator= (const LoadStrategy&) = delete;
    LoadStrategy (LoadStrategy&&)                 = delete;
    LoadStrategy& operator= (LoadStrategy&&)      = delete;

    /**
     * @brief Execute the load test strategy
     * @param context The run context
     * @param db Database for storing results
     * @param request The request to execute
     */
    virtual void execute (std::shared_ptr<RunContext> context,
    vayu::db::Database& db,
    const vayu::Request& request) = 0;

    /**
     * @brief Create a strategy instance based on configuration
     */
    static std::unique_ptr<LoadStrategy> create (const nlohmann::json& config);
};

} // namespace vayu::core
