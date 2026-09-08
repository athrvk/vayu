#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file elements.hpp
 * @brief The element registry (issue #1513) and the pipeline that runs a
 *        compiled element at a phase of a step (issue #1514): the kind a
 *        behaviour attached to a request or collection at a phase of a step
 *        is, never a column (issue #1512).
 *
 * A kind is one translation unit under `engine/src/core/elements/`, whose
 * `make_*_kind()` names it, its config schema and (once a kind runs one) its
 * behaviour; `Registry::instance()` holds the fixed, explicit list of them
 * (`engine/src/core/elements/registry.cpp`), the one place a kind name maps to
 * code (the extensibility contract's rule 1 in issue #1512). A namespace-scope
 * self-registering static initialiser - the issue's own wording - is declined:
 * `engine/CLAUDE.md` requires nothing at namespace scope be built at run time,
 * because a throwing initialiser before `main` has no frame to catch it and no
 * defined order against another translation unit's. An explicit call list
 * inside `Registry::instance()`'s function-local static keeps the same "one
 * new file, one new line" cost the issue asks for, on the same "explicit list,
 * never a glob" precedent `engine/tests/CMakeLists.txt` already uses.
 */

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "vayu/types.hpp"

namespace vayu::core {

/**
 * @brief Cross-instance shared clocks, one atomic per name (issue #1570) -
 *        `timer.pacing(perUser: false)`'s coordination for one cadence
 *        shared across every virtual user under a scenario load run, kept
 *        generic over what a "name" is so a future kind with the same
 *        shape (`timer.throughput`'s own shared-rate case, issue #1571,
 *        names this type as its intended reuse) never needs a second one.
 *
 * Sized once at construction from an explicit name list the caller already
 * knows - `std::atomic` is neither copyable nor movable, so growing this
 * afterwards is not an option - which keeps this type decoupled from
 * `ScenarioPlan` / `CompiledElement`: the scan for which names need a clock
 * lives with whoever builds that list (`ScenarioLoadState`'s constructor,
 * `scenario_load.cpp`), not here. `advance` is a compare-exchange retry
 * loop, never a mutex: the load path's completion callback runs on every
 * event-loop worker at once, and per `engine/CLAUDE.md`'s hot-path
 * discipline nothing on it blocks for a lock.
 */
class SharedPacingClocks {
    public:
    explicit SharedPacingClocks (const std::vector<std::string>& names);

    /// Advances @p name's shared deadline by @p every_ms from wherever it
    /// currently stands (0 = never started - the first pass is never
    /// delayed, the same convention a per-VU clock uses) and returns the
    /// resulting wait, clamped to never negative. Returns 0 for a name this
    /// instance was not sized for, which does not happen in practice - the
    /// caller sizes this from exactly the names it will ever pass - but a
    /// defensive default costs less than a crash on a future caller's
    /// mistake.
    [[nodiscard]] int64_t advance (const std::string& name, int64_t every_ms, int64_t now_ms);

    private:
    std::vector<std::atomic<int64_t>> clocks_;
    std::unordered_map<std::string, size_t> index_of_id_;
};

/**
 * One scope-spanning kind's first and last position in the plan (issue
 * #1515's `control.loop` / `control.transaction`): an element inherited from
 * a folder compiles once per member request, so each member's own instance
 * has to recognise "I am the folder's first member" or "I am its last"
 * independently. Keyed by the element's own `id` in `compute_element_spans`
 * (`scenario_plan.cpp`) - the same `id` string every one of a folder's
 * inherited members carries, since `compile_elements` compiles the same
 * source entry's `id` verbatim at each occurrence.
 */
struct ElementSpan {
    size_t first = 0;
    size_t last  = 0;
    /// `ScenarioStep::name` of `first` - what `control.loop` jumps back to
    /// through the same `resolve_next_step` a script's own `setNextRequest`
    /// resolves against, so a loop-back is an ordinary `Next` decision to
    /// every reader of the step list, not a second flow-control mechanism.
    std::string first_step_name;
};

/**
 * The run-level `elements.timers` override (issue #1498), read once at run
 * start (`RunContext`) and consulted by every `timer.*` kind's own wait
 * computation - never by the pipeline itself, which stays ignorant of what a
 * kind's config means. `AsConfigured` is the default: every `timer.*`
 * element runs its own stored config unchanged. `Off` silences every
 * `timer.*` element for the run. `Fixed` and `Range` replace every
 * `timer.*` element's own wait span with the same fixed value or uniform
 * range, whatever that element's own config says - the same "replaced, not
 * merged" rule `elements.scripts` already uses.
 */
struct TimersOverride {
    enum class Mode : std::uint8_t { AsConfigured, Off, Fixed, Range };
    Mode mode        = Mode::AsConfigured;
    int64_t fixed_ms = 0;
    int64_t min_ms   = 0;
    int64_t max_ms   = 0;
};

/**
 * Everything a compiled element's `apply` reads and writes (issue #1514).
 *
 * Deliberately decoupled from `vayu::runtime::ScriptEngine` and from
 * `vayu::http::routes::ScriptVariableScopes`: those live one layer up (in
 * `vayu_core`'s http-adjacent code, which itself depends on `core/elements`),
 * so a script kind reaches them through callbacks its caller binds rather than
 * through a type this header would have to include and create a cycle with. A
 * declarative kind (`extract.*`, `assert.*`, `timer.think`) touches none of
 * the script fields at all.
 */
struct ElementContext {
    /// Mutable, before send in `step.before` and unchanged (already sent) in
    /// `step.after` - a kind that reads it in `step.after` is reading what
    /// went out, not what could still change.
    vayu::Request& request;
    /// Null in `step.before`; set once the send has answered.
    vayu::Response* response = nullptr;

    /// Runs @p script as this step's pre-request script, exactly as
    /// `execute_exchange` always has, and returns its result. Unset only in a
    /// context with no script slot at all (there is none today - both callers
    /// always bind this).
    std::function<vayu::ScriptResult (const std::string& script)> run_pre_script;
    std::function<vayu::ScriptResult (const std::string& script)> run_post_script;
    /// Where `script.pre` / `script.post` write the result of the callbacks
    /// above, so the caller's `ExchangeOutcome`-shaped result carries it under
    /// the same two fields it always has - nothing the response view or the
    /// step trace's `scripts` node reads changes shape.
    vayu::ScriptResult& pre_script_result;
    vayu::ScriptResult& post_script_result;

    /// `extract.*`'s write, addressed by the schema's `scope` value
    /// (`"env"` | `"collection"` | `"globals"`) and variable name. The
    /// callback is the caller's: it knows which `ScriptVariableScopes` a
    /// design send or a sequential step's iteration is writing into.
    std::function<void (std::string_view scope, const std::string& name, const std::string& value)> set_variable;

    /// Polled by `timer.think`'s wait; returns true to abort it early (a
    /// design send has none - a single exchange has nothing to stop mid-wait -
    /// so only the sequential run's plan walk binds this).
    std::function<bool ()> should_stop;

    /// Resolves `{{name}}` tokens in @p text against this step's current
    /// variables - the same scopes and, under a data-driven run, the same
    /// row the request itself was bound against - through the caller's own
    /// `vayu::http::resolve_template`, never a copy of it here (issue
    /// #1515's `control.if` / `control.switch`, which read a condition or a
    /// dispatch variable that lives in config text rather than the request
    /// composition already resolved). Unset only where nothing needs it.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::function<std::string (const std::string& text)> resolve_template{};

    /// This element's own `id`, set by `ElementPipeline::run` before every
    /// `apply` call - never by a kind itself (issue #1515). A controller
    /// that needs to recognise its own occurrence (`control.once`'s
    /// fire-once flag, `control.transaction`'s span lookup) reads this
    /// rather than being handed its id as a constructor argument, so
    /// `Element::apply` keeps one signature for every kind.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::string element_id{};
    /// 0-based, as `pm.info.iteration` reports it - unset (0) for a design
    /// send, which has no iteration to report. Read only by a kind whose
    /// state must reset every iteration (`control.transaction`'s
    /// per-iteration accumulator, `control.loop`'s per-iteration pass
    /// count), through a key this iteration number is folded into rather
    /// than a value `controller_state` is cleared for - clearing on an
    /// iteration boundary would erase `control.once`'s fire-once flag too,
    /// which must survive every iteration of a run.
    size_t iteration = 0;
    /// This step's position in the plan, unset for a design send (which
    /// resolves no plan at all). A scope-spanning kind reads it against
    /// `element_spans` to tell its folder's first member from its last;
    /// every other kind ignores it.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<size_t> step_position{};
    /// The plan-wide first/last position of every scope-spanning element's
    /// id (issue #1515), computed once by `compute_element_spans` and
    /// shared read-only for the run's life. Null for a design send and for
    /// any plan that resolved no scope-spanning kind - neither needs one.
    const std::unordered_map<std::string, ElementSpan>* element_spans = nullptr;
    /// Where a kind's state must outlive one `apply` call and must not be
    /// shared between an inherited element's several independent
    /// occurrences (`control.once`'s fire-once flag, `control.throughput`'s
    /// producer-side counter, `control.transaction`'s running sum) - a
    /// fresh, empty map for a design send, one map for the whole sequential
    /// run (issue #1515's single implicit user), one map per virtual user
    /// under load, so one VU's count is never another's. Keyed by
    /// `element_id`, optionally folded with `iteration`. Null only where a
    /// caller resolves no element that reads it. A sibling of `pacing_state`
    /// below (issue #1498's identical shape for `timer.pacing`) rather than
    /// unified with it - kept separate rather than merged in this PR to
    /// avoid widening either issue's own change.
    std::unordered_map<std::string, int64_t>* controller_state = nullptr;

    /// True for the design send and the sequential run, where a `timer.*`
    /// kind's wait blocks the calling thread exactly as it always has; false
    /// on a scenario load run's own producer/completion hooks, where blocking
    /// would stall the shared event loop and a kind must instead report its
    /// intended wait through `Element::scheduled_ready_delay_ms` for the
    /// caller to apply through `VirtualUser::ready_at_ms` (issue #1498).
    bool blocking_allowed = true;

    /// A run's seeded generator (issue #1498), for a `timer.*` kind whose
    /// wait is randomised and wants to be reproducible with the run's
    /// `elements.seed`. Null for a design send, which has no run and no seed
    /// to be reproducible against - a kind falls back to its own unseeded
    /// generator there, exactly as before this field existed.
    std::mt19937_64* rng = nullptr;

    /// Per-node "when did this node last start" state for `timer.pacing`
    /// (issue #1498), keyed by the pacing element's own id (stamped by
    /// `compile_elements` as `config._elementId`) - not by kind, since a
    /// step can carry more than one `timer.pacing` element on different
    /// scopes. Bound to a run-local map for the sequential run (one VU, one
    /// map, alive for the run's whole life) and to `VirtualUser`'s own map
    /// under load (one map per VU, so two users pacing the same folder never
    /// share a cadence). Null for a design send, where pacing cannot mean
    /// anything - a pacing element then always reports its first-ever
    /// occurrence and never waits.
    std::unordered_map<std::string, int64_t>* pacing_state = nullptr;

    /// The run's `elements.timers` override (issue #1498), or null for a
    /// design send, which has no run-level override to read. Read-only: a
    /// kind consults it, never writes it.
    const TimersOverride* timers_override = nullptr;

    /// `script.setup` / `script.teardown` (#1499): runs @p script once, at
    /// `run.start` / `run.end`, against the run's own scopes rather than any
    /// step's. Trailing, like the `outcome_*` fields below, and for the same
    /// reason: every step-phase dispatch site predates #1499 and so skips both
    /// - only the two run-boundary dispatch sites bind either. `{}` is
    /// load-bearing on the same `Variable::created_at` precedent those fields
    /// cite.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::function<vayu::ScriptResult (const std::string& script)> run_setup_script{};
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::function<vayu::ScriptResult (const std::string& script)> run_teardown_script{};

    /// One JSON parse of the response body, shared by every `extract.*` /
    /// `assert.jsonpath` on the same step rather than paid per kind.
    /// `body_parse_attempted` distinguishes "not tried yet" from "tried and
    /// the body was not JSON" so a second kind does not retry a parse that
    /// already failed.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<nlohmann::json> parsed_body{};
    bool body_parse_attempted = false;
    /// `maxElementBodyBytes` - a response past this is not parsed, and every
    /// JSON-reading kind on the step reports `skipped` rather than paying for
    /// (or failing on) a parse of an oversized body.
    size_t max_body_bytes = size_t{ 1024 } * 1024;

    /// Filled by `Element::apply`, reset by `ElementPipeline::run` before each
    /// call and read back into the pushed `ElementOutcome` afterwards - the
    /// same "write through a bound reference, no return-shape per kind" split
    /// `ElementKind::compile` and `Element::apply` already use. The `{}` on
    /// each (not just a bare declaration) is load-bearing, on the
    /// `Variable::created_at` precedent: a designated-initializer call site
    /// that stops short of these trailing fields is otherwise a
    /// -Wmissing-field-initializers warning at every one of them.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::string outcome_status{}; ///< "ok" | "failed" | "missing" | "skipped" | "error"
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<std::string> outcome_message{};
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<int64_t> outcome_waited_ms{};
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::optional<bool> outcome_wrote{};
};

/**
 * The seven points of a step an element can run at (issue #1512's Model
 * section). Derived from a kind's registration, never stored on the element
 * instance itself.
 */
enum class Phase : std::uint8_t {
    RunStart,
    IterationStart,
    StepBefore,
    StepAfter,
    StepBetween,
    IterationEnd,
    RunEnd,
};

/**
 * Whether a compiled element is cheap enough to run inline on the load hot
 * path, or costly enough (a `script.*` kind) that the load paths defer it to
 * the replay by default (#1495). Phase 0 declares the split; nothing reads it
 * yet - no kind executes before #1514.
 */
enum class HotPathClass : std::uint8_t {
    Declarative,
    Script,
};

/** A compiled, runnable behaviour. No kind overrides `apply` before #1514. */
class Element {
    public:
    virtual ~Element ()                 = default;
    Element ()                          = default;
    Element (const Element&)            = delete;
    Element& operator= (const Element&) = delete;
    Element (Element&&)                 = delete;
    Element& operator= (Element&&)      = delete;

    [[nodiscard]] virtual Phase phase () const = 0;
    virtual void apply (ElementContext& ctx)   = 0;

    /**
     * Issue #1498: how long a scenario load run should hold the owning VU
     * back before this element's phase would otherwise dispatch it, or
     * `nullopt` for "nothing to schedule around" - the default every kind
     * but `timer.think` and `timer.pacing` keeps. Called by the load path's
     * own step-completion hook, before the VU is next considered ready, so a
     * kind that wants a non-blocking wait reports it here instead of
     * sleeping inside `apply` (which the load path never lets block). @p
     * pacing_state is the same per-VU map `ElementContext::pacing_state`
     * would bind for this VU; a kind that writes through it here must leave
     * `apply` free to run again without double-booking the wait. @p
     * shared_pacing (issue #1570) is the cross-VU sibling for a kind whose
     * own config asks for one cadence shared across every virtual user
     * (`timer.pacing`'s `perUser: false`) instead of one per VU; never null
     * on the load path, which always constructs one from the plan even when
     * nothing in it needs it.
     */
    [[nodiscard]] virtual std::optional<int64_t> scheduled_ready_delay_ms (
    std::unordered_map<std::string, int64_t>& pacing_state,
    SharedPacingClocks* shared_pacing,
    int64_t now_ms) const {
        (void)pacing_state;
        (void)shared_pacing;
        (void)now_ms;
        return std::nullopt;
    }
};

/**
 * What the registry knows about one kind, independent of any element instance
 * - the catalogue `GET /elements/kinds` serves is this struct, one per
 * registered kind.
 */
struct ElementKind {
    std::string kind; // e.g. "assert.status"; validated, never displayed alone.
    int version = 1;
    std::vector<Phase> phases;
    nlohmann::json config_schema; // A JSON Schema `config` must validate against.
    std::string label;
    std::string description;
    std::string category;
    HotPathClass hot_path = HotPathClass::Declarative;
    // `script.setup` / `script.teardown` (#1499): true refuses the kind on a
    // request's own `elements`, both at validate time and in the catalogue
    // (`GET /elements/kinds`' `collectionOnly`), because a once-per-run
    // element attached to one request in the tree would run once per request
    // that happened to declare it rather than once per run - a question the
    // model has no answer for. Every other kind stays request-and-collection,
    // the default.
    bool collection_only = false;
    /// Whether this kind needs to know its own first/last occurrence across
    /// the folder it is inherited into (issue #1515's `control.loop` /
    /// `control.transaction`, which each compile once per member request and
    /// must recognise their own folder's boundary independently). Read by
    /// `compute_element_spans` through the registry, never a `kind ==`
    /// comparison outside `core/elements` (#1512's extensibility contract,
    /// rule 1).
    bool needs_span = false;
    /// Whether this kind can redirect the plan walk to a step other than
    /// the next one (issue #1515's `control.loop` / `control.switch`). A
    /// scenario load run's virtual users only ever advance forward
    /// (`VirtualUser::step`), so `find_load_incompatible_controller`
    /// (`scenario_load.cpp`) reads this - through the registry, never a
    /// `kind ==` comparison outside `core/elements` (#1512's extensibility
    /// contract, rule 1) - to refuse a load run carrying one rather than
    /// silently running it once and ignoring what it asked for.
    bool jumps_or_repeats = false;
    /// Whether the plan compiler must track, across a whole iteration's step
    /// sequence, which occurrence of this kind's element id comes first
    /// (issue #1498). True only for `timer.pacing`: "the wait is measured
    /// from the previous start of the same node" needs to know which one
    /// occurrence - of the many a folder- or collection-scoped element is
    /// inherited into - is that node's actual start. Read by
    /// `scenario_plan.cpp` through the registry, never by a `kind ==`
    /// comparison, so the extensibility contract's rule 1 holds for a future
    /// kind that needs the same tracking. A sibling of `needs_span` above
    /// (which additionally needs the *last* occurrence, not only the
    /// first) rather than unified with it, for the same reason
    /// `controller_state` and `pacing_state` stay two fields above.
    bool tracks_scope_occurrence = false;
    // Absent for a kind that only validates (phase 0's `inherit.disable`);
    // present once a kind actually runs (#1514 onward).
    std::function<std::unique_ptr<Element> (const nlohmann::json& config)> compile;
};

/** Which stored row an `elements` array is being validated for (#1499): the
 *  one fact `collection_only` is checked against. */
enum class ElementOwner : std::uint8_t {
    Request,
    Collection,
};

/**
 * The one place a kind name maps to code (issue #1512's extensibility
 * contract, rule 1). A process-wide singleton behind a function-local static,
 * safe under the engine's worker-thread-per-connection model and free of the
 * static-initialisation-order problem a namespace-scope registry object would
 * have.
 */
class Registry {
    public:
    static Registry& instance ();

    /** Test-only: adds a kind beyond the fixed built-in list, e.g. `test.echo`. */
    void register_kind_for_test (ElementKind kind);

    [[nodiscard]] const ElementKind* find (const std::string& kind) const;
    [[nodiscard]] const std::vector<ElementKind>& kinds () const;

    /**
     * Validates the wire shape of an `elements` field: an array of objects,
     * each a known kind, each `config` against that kind's schema, with no
     * duplicate `id`, each honouring its kind's `collection_only` against
     * @p owner. Returns the first violation's message, or `nullopt` if the
     * whole array is well-formed - the same "pure validator, route converts
     * to a 400" split `core::validate_thresholds` uses.
     */
    [[nodiscard]] std::optional<std::string> validate (const nlohmann::json& elements,
    ElementOwner owner = ElementOwner::Request) const;

    Registry (const Registry&)            = delete;
    Registry& operator= (const Registry&) = delete;
    Registry (Registry&&)                 = delete;
    Registry& operator= (Registry&&)      = delete;

    private:
    Registry ()  = default;
    ~Registry () = default;

    void register_kind (ElementKind kind);

    std::vector<ElementKind> kinds_;
};

/** `GET /elements/kinds`' body: every registered kind, catalogue-shaped. */
[[nodiscard]] nlohmann::json elements_catalogue ();

/**
 * One compiled element's outcome, in the shape the step trace's `elements`
 * array and the `test.echo`-proved contract both serve (issue #1514).
 */
struct ElementOutcome {
    std::string id;
    std::string kind;
    nlohmann::json origin;
    std::string status; ///< "ok" | "failed" | "missing" | "skipped" | "error"
    std::optional<std::string> message;
    std::optional<int64_t> waited_ms;
    std::optional<bool> wrote;

    [[nodiscard]] nlohmann::json to_json () const;
};

/**
 * `script.setup` / `script.teardown`'s outcomes (#1499), in the shape both run
 * modes' summary stores under the `lifecycle` key: `{"setup": [...],
 * "teardown": [...] }`, each key present only when that phase ran at least one
 * element - an empty array would read as "a setup element ran and did
 * nothing" rather than "this collection declared none". An empty object comes
 * back when both are empty, which every caller treats as absent, the same
 * `coverage` / `schema_validation` rule `RunSummaryInputs` already follows.
 */
[[nodiscard]] nlohmann::json build_lifecycle_node (const std::vector<ElementOutcome>& run_start,
const std::vector<ElementOutcome>& run_end);

/**
 * One entry of a resolved `elements` array, compiled once (issue #1512's
 * "Pipeline" section - "compiled once per plan step").
 *
 * `config` is kept verbatim beside the compiled `element` (rather than only
 * inside the closure `compile` built) so a caller that needs the raw
 * configuration - the load path's deferred script replay reading a
 * `script.post` entry's `config.script` text (`run_manager.cpp`) - does not
 * have to invoke the element to get it.
 */
struct CompiledElement {
    std::string id;
    std::string kind;
    nlohmann::json origin;
    nlohmann::json config;
    bool enabled = true;
    /// Null for a kind with no `compile` (`inherit.disable` never reaches
    /// here - `compose_elements` already consumes it - but a kind the
    /// registry cannot find, which validation should already have refused,
    /// compiles to nothing rather than aborting the whole step).
    std::unique_ptr<Element> element;
};

/**
 * Compile a resolved `elements` array (as `request_composer.cpp`'s
 * `compose_elements` produces it - each entry stamped with `origin`) into the
 * ordered list `ElementPipeline::run` iterates.
 *
 * One entry in, one `CompiledElement` out, in the same order. A kind with no
 * runnable behaviour - unknown to this registry (the DB held a row a newer
 * engine wrote), or validate-only like `test.echo` - compiles to a null
 * `element`; with no phase to dispatch it at, `ElementPipeline::run` never
 * calls it and never reports an outcome for it, the same as a kind this build
 * has simply never heard of.
 */
[[nodiscard]] std::vector<CompiledElement> compile_elements (const nlohmann::json& elements);

/**
 * Applies the run's `elements.timers` override (issue #1498) to one
 * `timer.*` kind's own computed wait: `nullopt` means "run silenced by
 * `off`, do not wait at all"; a value means "wait this many milliseconds
 * instead of @p own_wait_ms". @p rng is the same generator
 * `ElementContext::rng` carries, drawn from for `Range`'s uniform pick;
 * null falls back to an unseeded draw, exactly as a kind with no run would.
 * A null @p override (a design send) returns @p own_wait_ms unchanged.
 */
[[nodiscard]] std::optional<int64_t> apply_timers_override (const TimersOverride* override_,
int64_t own_wait_ms,
std::mt19937_64* rng);

/**
 * The response body parsed as JSON, cached on @p ctx so `extract.json`,
 * `extract.regex`'s field="body" and `assert.jsonpath` on the same step share
 * one parse. Returns null when there is no response yet, the body is over
 * `ElementContext::max_body_bytes`, or it does not parse as JSON - a caller
 * that needs to tell those apart reads `ctx.body_parse_attempted` (true after
 * this returns) against whether a response is set.
 */
[[nodiscard]] const nlohmann::json* ensure_parsed_body (ElementContext& ctx);

/**
 * Runs every compiled element of @p elements whose kind's phase is @p phase,
 * in list order, appending one outcome to @p sink per element - including a
 * disabled one, reported `"skipped"` without calling `apply` (issue #1512's
 * extensibility contract, rule 1: the pipeline is the only thing that decides
 * whether a kind runs, never a caller re-implementing the phase filter).
 *
 * An exception `apply` lets escape is caught here and reported as this one
 * element's `"error"` outcome with the exception's `what()` as the message -
 * a kind that throws must not abort the rest of the step.
 */
class ElementPipeline {
    public:
    /**
     * @param skip_reason Consulted for an otherwise-runnable (enabled,
     *        phase-matching) element, before `apply` - `nullopt` from it means
     *        run as usual, a string means report `"skipped"` with that message
     *        instead of calling `apply` at all. Null (the default, both callers
     *        before #1495) runs every enabled element unconditionally, exactly
     *        as before this parameter existed.
     *
     *        This is a load run's one hook for "declarative kinds always run
     *        here; a `script.*` kind runs here only when it opted in" (#1495):
     *        the load path reads `HotPathClass` off the registry and a
     *        `script.*` element's own `config.inline`, never a `kind ==`
     *        comparison, which stays the extensibility contract's rule.
     */
    static void run (Phase phase,
    ElementContext& ctx,
    const std::vector<CompiledElement>& elements,
    std::vector<ElementOutcome>& sink,
    const std::function<std::optional<std::string> (const CompiledElement&)>& skip_reason = nullptr);
};

} // namespace vayu::core
