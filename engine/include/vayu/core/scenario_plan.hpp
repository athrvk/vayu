#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/scenario_plan.hpp
 * @brief Resolve a collection into an immutable, fully composed ordered plan -
 *        the collection-runner primitive (design doc: "The sequence model").
 *
 * Nothing in the engine held an ordered sequence of requests before this: the
 * MCP smoke handler walks a collection in TypeScript over independent
 * `POST /execute` calls, and a load run repeats one composed request. Every
 * later phase of the collection runner - the sequential runner, flow control,
 * data-driven iterations, load-mode scenarios - consumes the object built here,
 * so it exists and is tested on its own before anything executes it.
 *
 * **Resolution happens exactly once, before the first send.** No step is
 * composed lazily and no execution path touches SQLite for request data
 * afterwards. Two reasons, and the second is load-bearing:
 *
 *  - A collection edited mid-run would otherwise change the sequence underneath
 *    itself. A run is a record of what ran; it must resolve to one answer.
 *  - The load-mode executor cannot query SQLite per step per virtual user. A
 *    fully composed plan is what makes a per-VU state machine possible at all,
 *    so resolving lazily in design mode would be a stopgap load mode has to
 *    undo.
 *
 * Composition goes through `compose_request_core` / `build_request` and each
 * step's elements are `compose_elements`' resolved list, compiled once
 * (issue #1514) - which is what keeps a step what a Send of the same request
 * would run. There is deliberately no second copy of resolution here.
 *
 * The structure is fixed here; a value may not be (#2521). A plan in which
 * any step carries an element that writes a variable before some send
 * (`ElementKind::writes_variables`: a script, an extractor) composes every
 * step with its scope names left written, for the send to resolve against
 * what the earlier steps set. A plan with none resolves them here.
 */

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "vayu/core/elements.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/schema_validation.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/db/database.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/file_ref.hpp"
#include "vayu/types.hpp"

namespace vayu::core {

/** One resolved step of a scenario plan: execute-ready, and never re-read. */
struct ScenarioStep {
    /// Position in the plan, stable for the run.
    size_t index = 0;
    /// The stored request this came from.
    std::string request_id;
    /// `requests.name` - the `setNextRequest` target a later phase resolves.
    std::string name;
    /// Composed and auth-resolved. Credential-grade; see `build_scenario_manifest`.
    vayu::Request request;
    /// This step's resolved element list, compiled once here rather than per
    /// iteration (issue #1514) - `extract.*` / `assert.*` / `timer.think` /
    /// `script.pre` / `script.post`, in the order `compose_elements` resolved
    /// them (collection chain, then the request's own). A `shared_ptr` to a
    /// `const` vector rather than the vector itself: `CompiledElement` holds
    /// a `unique_ptr<Element>`, so a step carrying one is move-only unless the
    /// list itself is shared by pointer, and every iteration of this step
    /// reuses the same compiled list rather than recompiling it.
    std::shared_ptr<const std::vector<vayu::core::CompiledElement>> elements;
    /// The stored, uncomposed URL. Carried on the step so the snapshot manifest
    /// can record a URL that is safe to persist without re-reading the row -
    /// `request.url` has `{{vars}}` substituted and may carry an `apikey` auth
    /// with `in: "query"`, i.e. a live key.
    std::string stored_url;
    /// `request`'s reserved tokens - `{{data.column}}`, the `{{$vu}}` /
    /// `{{$iteration}}` identity, and the `{{$guid}}` family this step's
    /// composition deferred (issue #995) - split once here so no executor has
    /// to re-scan the step per iteration. Empty for a step that carries none,
    /// which is what both executors test before doing any join work at all.
    ///
    /// Every field from here down carries a `{}`: the plan tests build steps by
    /// aggregate init and stop at `stored_url`, so a trailing field without a
    /// default member initializer is a -Wmissing-field-initializers warning at
    /// each of those sites. The defaults are what default construction already
    /// produced.
    StepDataTemplate data_template{};
    /// The step's parsed auth, kept **only** when its build was deferred: its
    /// credentials carry a `{{data.column}}` or the identity (`auth_template`),
    /// or a name only the scopes answer (`auth_after_scripts`). `NoAuth` for
    /// every other step, whose auth is already resolved into `request` above.
    /// The `{}` here and below is load-bearing:
    /// aggregate initializations of a step that stop short of these trailing
    /// fields are each a -Wmissing-field-initializers error under clang
    /// otherwise (#946 measured the removal) - redundant to the default
    /// constructor, not to that warning.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    vayu::http::Auth auth{};
    /// The stored `requests.spec_operation` text, "" for a step whose request
    /// names no operation. Carried on the step so contract coverage (#629) can
    /// resolve each step's identity **once**, when the tally is built, rather
    /// than parsing it per completion on the load path.
    // NOLINTNEXTLINE(readability-redundant-member-init)
    std::string spec_operation{};
    /// `auth`'s tokens, split once here like `data_template`.
    ///
    /// **Non-empty means this step's auth was deferred**: `request` carries no
    /// credential yet, and an executor must call `bind_step_auth` before
    /// sending or the request goes out unauthenticated. An executor does *not*
    /// always have a row for it: since issue #1055 a credential carrying only
    /// the `{{$vu}}` / `{{$iteration}}` identity defers too, and the identity
    /// needs no data set. A data token with no data set is still refused when
    /// the plan resolves, so a row is there whenever a token wants one.
    StepDataTemplate auth_template{};
    /// A credential still holds a name only the variable scopes answer
    /// (`credentials_await_scripts`, issue #2473), so this step's auth was
    /// deferred too and `request` carries none of it. `bind_step_iteration`
    /// joins the row into a copy of `auth` and hands it back unapplied; the
    /// executor applies it with `http::routes::apply_late_auth` after
    /// `step.before` and the residual pass. Decided here, once per step, so a
    /// step whose credentials hold no such name pays nothing per iteration.
    /// An OAuth 2.0 config only reaches this on a sequential plan
    /// (`ScenarioResolveOptions::oauth2_after_scripts`), whose executor hands
    /// `apply_late_auth` the token cache.
    bool auth_after_scripts = false;
};

/** An ordered, immutable sequence of composed steps. */
struct ScenarioPlan {
    std::vector<ScenarioStep> steps;
};

/**
 * The first and last plan position every scope-spanning element's `id`
 * occupies (issue #1515), for `control.loop` and `control.transaction`: both
 * compile once per member of the folder they are inherited into, and each
 * member's own instance has to recognise its folder's boundary independently
 * rather than being told it.
 *
 * A folder's whole subtree is a contiguous run of plan positions
 * (`resolve_scenario`'s depth-first, subtree-before-own-requests walk), so
 * one pass over `plan.steps` recording each such element id's minimum and
 * maximum position is the whole answer - no separate folder identity is
 * read or needed. Empty for a plan that resolved no `needs_span` kind, which
 * is what leaves `ElementContext::element_spans` null for every run that
 * carries none.
 */
[[nodiscard]] std::unordered_map<std::string, vayu::core::ElementSpan>
compute_element_spans (const ScenarioPlan& plan);

/**
 * Whether @p step carries a `script.pre` / `script.post` element (issue
 * #1514's cut-over - `ScenarioStep::pre_script` / `post_script` are gone).
 * Says nothing about whether it ran inline: reporting a script a load run
 * left behind is @ref step_has_deferred_script. The deferred replay reads a
 * step's script *text*, which is `find_step_post_script` in `run_manager.cpp`.
 */
[[nodiscard]] bool step_has_script (const ScenarioStep& step, std::string_view kind);

/**
 * A load run's `elements.scripts` override (issue #1495): "asMarked" leaves
 * each `script.*` element's own `config.inline` to decide, "allInline" /
 * "allDeferred" force every one regardless of its own marking. Declared here,
 * not on `RunContext` (which aliases it), so the plan and summary helpers
 * below can take the mode without including `run_manager.hpp`, which includes
 * this header.
 */
enum class ScriptsOverrideMode : std::uint8_t {
    AsMarked,
    AllInline,
    AllDeferred
};

/**
 * Whether @p step carries a non-blank `script.<kind>` element that did **not**
 * run inline under @p scripts_mode - the script a load run leaves behind, as
 * opposed to @ref step_has_script, which cannot tell the two apart. Decided by
 * `RunContext::script_element_runs_inline`, the one rule the load hooks and
 * the deferred replay (`find_step_post_script`) share, so the run-level
 * `pre_request_script_skipped` warning and the per-step `preRequestScript`
 * marker read the same answer (issue #1938).
 */
[[nodiscard]] bool step_has_deferred_script (const ScenarioStep& step,
std::string_view kind,
ScriptsOverrideMode scripts_mode);

/**
 * The validated `scenario` block of a `POST /runs` payload.
 *
 * `data` rows themselves are deliberately absent, and their absence here is
 * structural rather than a convention to remember: this is the object
 * `build_scenario_manifest` serializes into `runs.config_snapshot`, and the
 * rows are user data of unknown sensitivity that the snapshot never records.
 * They live on `ScenarioExecution`, which nothing writes to disk; what survives
 * into the snapshot is their count plus the file's name and content hash
 * (issue #2051), never its path or rows.
 *
 * That is a statement about the row *set*, not about every value in it: a cell
 * bound into a request is stored with that request in the step's trace, the
 * same way any other request material is (`build_result_trace`, issue #731).
 * The step view discloses it; do not read this comment as a promise that a
 * credentials file leaves nothing behind.
 */
struct ScenarioRequest {
    /// Only `"collection"` today. The discriminator exists so a future stored
    /// scenario resolves to the same plan; an unknown value is rejected rather
    /// than falling through to the collection path.
    std::string source;
    std::string collection_id;
    /// Descend into sub-collections depth-first, each sub-folder's subtree
    /// where it sits among its parent's requests - the sidebar's order.
    bool recursive = false;
    /// Resolved: an explicit count wins, otherwise the data row count, else 1.
    size_t iterations     = 1;
    size_t data_row_count = 0;
    /// The file `data` came from, as the caller named it - see
    /// @ref read_data_file_fields. Empty when none was named.
    DataFileProvenance data_file;
};

/**
 * The OpenAPI document a run's collection was bound to when the run was planned
 * (issue #637).
 *
 * Both halves or neither: the id says *which* document and the hash says *which
 * version of it*, and a report that carried only the id would claim a run was
 * measured against a spec that may have been replaced since. `bound()` is false
 * for a collection that binds nothing, and a run of one stamps no `openapi`
 * object at all - absent, rather than an empty one that reads as "bound to
 * nothing in particular".
 *
 * Captured at resolution rather than read back at report time for the same
 * reason the whole plan is: a run is a record of what ran, and the binding is
 * free to move afterwards.
 */
struct SpecBinding {
    std::string spec_id;
    std::string spec_hash;
    /**
     * Whether the binding came from an **ancestor** of the collection this run
     * names, rather than from that collection itself (issue #716).
     *
     * Stamped into the manifest, and through it into `metadata.openapi`, because
     * it changes what the coverage numbers beside it mean. An import binds the
     * root and files requests under tag sub-collections, so running one tag
     * folder is measured against the *whole* document: most of its operations
     * are honestly uncovered, and "4 of 618 covered" reads as a catastrophe
     * unless the report says the contract is the ancestor's. The reader is the
     * app's coverage block, which prints one line when this is set.
     *
     * False for an unbound run as well as for a collection carrying its own
     * binding - neither has anything to disclose.
     */
    bool inherited = false;
    /**
     * The bound document's declared operations, read once here (issue #629).
     *
     * Read at resolution rather than at run end for the reason the whole plan
     * is: a sync that lands mid-run stores a *new* document and moves the
     * binding, and a run that looked the index up afterwards would report itself
     * against a contract it never ran. Empty for an unbound collection, for a
     * document stored before the index existed, and for a binding whose stored
     * hash no longer matches the document it names - all three are "not
     * measured", which leaves the coverage block out entirely.
     */
    std::vector<DeclaredOperation> declared_operations;
    /**
     * The bound document's stored `response_schemas`, verbatim (issue #682).
     *
     * Carried as **text**, not as a parsed `ResponseSchemaIndex`: parsing a
     * document's whole schema index is the expensive half, so each executor
     * pays for it once and only if it will use it - the load run at the end, in
     * its deferred pass, and the collection runner once before its first step
     * (issue #681), because that one checks per step and would otherwise
     * reparse the largest column in the schema per response. That is the same
     * bargain `core/schema_validation.hpp` states for why the schemas are a
     * column of their own rather than folded into `operations`.
     *
     * Read here, at resolution, under the same hash check the operations are -
     * a run is judged against the document it was *planned* against, and a sync
     * landing mid-run moves the binding to a document this run never saw. Empty
     * for every case that leaves the schema-validation block out entirely.
     */
    std::string response_schemas;
    /**
     * Why there is no index to validate against, set **exactly when** `bound()`
     * and `response_schemas` is empty for a reason the run can name (issue
     * #681).
     *
     * The load-mode pass (#682) does not need this: it reports an absent block,
     * and a run whose reservoirs were never checked has nothing per-response to
     * explain. A collection run does - it emits a verdict per step, and
     * `checked: false` there must carry a reason, because "the document has
     * moved under the binding" is a state the reader can fix (sync it) while a
     * chip that silently never appears is how they never learn of it.
     *
     * Unbound sets nothing, on both sides: a run nobody measured against a
     * contract is not a run that could not be measured.
     */
    std::optional<UncheckedReason> schema_reason;
    [[nodiscard]] bool bound () const {
        return !spec_id.empty ();
    }
};

/**
 * A resolved scenario, ready to execute: what was asked for and what it
 * resolved to.
 *
 * The three travel together from the route to the run's worker thread because
 * none is enough on its own - the plan is what executes, the request is what
 * says how many times, and the rows are what each iteration binds to
 * `pm.iterationData`. Held by `shared_ptr<const>`: resolution happened once,
 * before the run row existed, and nothing may edit it afterwards.
 */
struct ScenarioExecution {
    ScenarioRequest request;
    ScenarioPlan plan;
    /**
     * The `data` rows, in payload order - each a JSON object, already validated
     * as one. Empty for a run sent without `data`, which is what makes
     * `pm.iterationData` `undefined` for its steps.
     *
     * They live here and nowhere else: `ScenarioRequest` feeds the snapshot and
     * must not carry them, and the engine never reads them from disk because it
     * never writes them there.
     */
    std::vector<nlohmann::json> data_rows;
    /**
     * The spec binding this run was planned against (issue #629), including the
     * document's declared operations. Unbound for most runs, which is what makes
     * both executors write no `coverage` section at all.
     *
     * Here rather than only on the manifest because the manifest is what the
     * *snapshot* records and this is what the run *counts against* - two readers
     * of one resolution, and only the second needs the index.
     */
    SpecBinding spec;
    /**
     * Every file the plan's steps can name, checked once when the plan
     * resolved (`http/file_ref.hpp`): each step's own, and each distinct path a
     * data row binds into one. Null for a plan that names no file. Both
     * executors `fill` a bound step from it; neither re-checks a path.
     */
    std::shared_ptr<vayu::http::FilePlan> files;
};

/** Bounds a plan must respect, read from config by the caller. */
struct ScenarioLimits {
    size_t max_steps     = 0;
    size_t max_data_rows = 0;
    /// Sum of the serialized rows - the array's brackets and separators are not
    /// counted, because the check accumulates row by row to refuse an oversized
    /// set without dumping the whole array. Bounds what the row count cannot: a
    /// single row is free to carry a megabyte in one cell.
    size_t max_data_bytes = 0;
};

/**
 * Everything resolution needs beyond the `scenario` block itself.
 *
 * `environment_id` is not part of the block: it is the *run's* environment, and
 * composition needs it or every `{{env var}}` in the plan keeps its braces
 * (issue #1009) instead of resolving.
 */
struct ScenarioResolveOptions {
    std::string environment_id;
    /// The run's timeout, applied to every composed step that states none of
    /// its own: a stored request's `timeout` wins (#2937), as on `POST /execute`.
    int timeout_ms = 0;
    ScenarioLimits limits;
    /// Whether a step's OAuth 2.0 token is acquired at its send, after its
    /// pre-request script, so a scripted step's config waits for that script
    /// (#2521): the sequential runner, whose `execute_exchange` holds the
    /// token cache. False for a load run, which acquires each step's token
    /// once, here, before any script, and refuses a config name nothing
    /// answers by then.
    bool oauth2_after_scripts = false;
    /// The run's caller's host rule (#2521), judged on the token endpoints of
    /// every OAuth 2.0 token acquired here, before any is posted. Null for none.
    const vayu::http::TargetPolicy* target_policy = nullptr;
    /// Ends an oauth2 token request a step's auth makes while resolving
    /// (`build_request`): `POST /runs` passes its `server_stopping` (#2683).
    const std::atomic<bool>* cancel = nullptr;
};

/**
 * The outcome of resolving a `scenario` block.
 *
 * Failure is always a caller-facing `400` message naming what was wrong and,
 * where a step is at fault, which step. There is no partial plan: a resolution
 * that cannot produce every step produces none.
 */
struct ScenarioResolution {
    bool ok = false;
    std::string error;
    /// The code a refusal carries when it has its own (`target_not_allowed`,
    /// `target_host_unknown`, #2521); empty for every other refusal, which the
    /// route answers as `invalid_scenario`.
    std::string error_code;
    ScenarioRequest request;
    ScenarioPlan plan;
    /// The validated `data` rows, for `ScenarioExecution::data_rows`.
    std::vector<nlohmann::json> data_rows;
    /// The collection's spec binding as of resolution; unbound for most runs.
    /// Read straight into `build_scenario_manifest`, which is the only thing
    /// that needs it - nothing about *executing* the plan depends on it.
    SpecBinding spec;
    /// For `ScenarioExecution::files`.
    std::shared_ptr<vayu::http::FilePlan> files;
};

/**
 * @brief Check every file @p request can send, once, at plan time.
 *
 * A request whose file paths hold no token is checked as it stands, and a
 * binary body's bytes are read into @p request itself, so every copy a run
 * makes shares them; a file part's open file, or a binary body's too large to
 * read inline, is kept by the plan (`OpenFiles::KeptByPlan`). One whose path a
 * data row binds is bound against each of @p rows through @p bind and each
 * distinct result checked, keeping no file open (`fill` opens it per request);
 * the refusal names the row (`data row N`). A path a row cannot bind is left
 * to the run's own bind, which refuses that row when it is reached.
 */
[[nodiscard]] std::optional<std::string> plan_request_files (vayu::http::FilePlan& files,
vayu::Request& request,
const std::vector<nlohmann::json>& rows,
const std::function<DataBindResult (vayu::Request&, size_t row)>& bind);

/**
 * @brief The per-iteration half of `plan_request_files`: fill a bound copy of
 * @p tmpl from what the plan already checked.
 *
 * A no-op unless @p tmpl's file path is one a row binds - every other request
 * was filled at plan time and its copies share that. A path the plan never saw
 * (one a per-iteration value produced) is refused, never read on the hot path.
 */
[[nodiscard]] DataBindResult fill_bound_files (const vayu::http::FilePlan* files,
const vayu::Request& tmpl,
vayu::Request& request);

/**
 * Validate a run's `data` rows against @p limits and copy them into
 * @p rows_out, or answer the caller-facing refusal that says why not.
 *
 * One reader for both shapes a run can carry rows in - a collection run's
 * `scenario.data` and a single-request load run's top-level `data` (issue
 * #993) - so the two cannot come to disagree about what a row is. @p field
 * names the payload field in every refusal, because the caller has to be told
 * which one of theirs was wrong.
 *
 * Every refusal is loud, for the reason the whole `{{data.column}}` namespace
 * exists: a token says the value came from the file, so a set the engine could
 * not read must never become a run that sends the token as it stands. A present
 * but **empty** array is refused too - a data set that binds nothing is a
 * mistake, not an empty run.
 *
 * A rejected set leaves @p rows_out empty, never holding the rows before the
 * bad one, which would be a partial data set.
 */
[[nodiscard]] std::optional<std::string> read_data_rows (const nlohmann::json& data,
const ScenarioLimits& limits,
std::string_view field,
std::vector<nlohmann::json>& rows_out);

/**
 * The refusal for a data row whose cell nests past
 * `constants::spec_document::MAX_READ_DEPTH` levels (issue #2362), or nothing.
 *
 * nlohmann parses a payload iteratively, but `dump ()` and a copy recurse, so
 * a cell nested far past any real value would overflow the stack the moment a
 * row is measured or kept. This is the one place that decides, and it only
 * walks with `vayu::json::exceeds_depth`. @p field names the payload field as
 * `read_data_rows` does; @p row_index is the row's raw 0-based index, absent
 * for the one row `POST /execute` takes. A @p row that is not an object has no
 * cells and is nothing to refuse here.
 */
[[nodiscard]] std::optional<std::string> refuse_overdeep_cell (const nlohmann::json& row,
std::string_view field,
std::optional<size_t> row_index);

/**
 * The same refusal over the whole of @p data whatever its shape, for a caller
 * that must know before it touches the payload at all: `POST /runs` snapshots
 * the whole body ahead of `read_data_rows`. An array is walked row by row
 * (`refuse_overdeep_cell` for an object row; a row of any other type is refused
 * as `'<field>' row <i> is nested deeper than 100 levels` when it is itself
 * too deep); a @p data that is not an array is refused as `'<field>' is nested
 * deeper than 100 levels` when it is too deep. A shape wrong but within the
 * bound is no refusal here and is left to `read_data_rows`, in its own words
 * and its own order.
 */
[[nodiscard]] std::optional<std::string>
refuse_overdeep_data (const nlohmann::json& data, std::string_view field);

/**
 * Read which file a run's `data` rows came from (issue #2051): `dataFileName`,
 * a display name, `dataFileHash`, the SHA-256 of the file's bytes as 64
 * lowercase hex characters, and `dataFileCastNumbers` (issue #2540), a boolean
 * saying the client read the file's unquoted numeric cells as numbers. Each is
 * optional and independent of the others; absent or `null` leaves its output
 * empty (false for the flag). All are stored verbatim and never acted on; a
 * name holding a `/` or `\` is refused, so the engine never stores a path.
 *
 * One reader for both shapes, like @ref read_data_rows: @p prefix is
 * `"scenario."` for a collection run's block and empty for a single-request
 * run's top level, and every refusal names the field with it. A key sent
 * without rows (@p has_data false) is refused rather than ignored (#1503).
 */
[[nodiscard]] std::optional<std::string> read_data_file_fields (const nlohmann::json& block,
std::string_view prefix,
bool has_data,
DataFileProvenance& out);

/// Write @p file into @p snapshot as `dataFileName` / `dataFileHash`, each only
/// when non-empty, and `dataFileCastNumbers` only when true: absent for a run
/// that named no file or read none as numbers, never `null` or `false`. A false
/// flag erases the key, so a body's own copy cannot outlive the validated one.
void stamp_data_file_fields (nlohmann::json& snapshot, const DataFileProvenance& file);

/**
 * Validate a `scenario` block and resolve it into a plan.
 *
 * Ordering is the order the sidebar displays, top to bottom (issue #431). A
 * collection's direct requests run by `requests.order`; with `recursive` set,
 * a collection's sub-folders and requests are one sibling list
 * (`vayu/db/sibling_order.hpp`, #2535), and the walk runs a request where it
 * sits and a sub-folder's whole subtree where the sub-folder sits,
 * depth-first (`Database::get_requests_in_subtree`). The `collections` tree is
 * not constraint-enforced, so the walk carries a visited set exactly as
 * `Database::delete_collection`'s BFS does: a `parent_id` cycle terminates
 * instead of growing forever under the DB mutex.
 *
 * Every failure below is loud, never a silently smaller run: an unknown
 * `collectionId`, an empty sequence, a step whose composition fails, a plan
 * over `limits.max_steps`, a `data` array that is present and empty or over
 * `limits.max_data_rows` or `limits.max_data_bytes`, and any `source` other
 * than `"collection"`. A step carrying a `{{data.*}}` token in a run sent
 * *without* `data` joins that list (issue #415): nothing would bind it, so it
 * would be sent as the literal token - and a step's *credentials* are scanned
 * for one as well as its request, because a data token in a basic-auth field is
 * exactly as unbindable and used to be base64-encoded where nothing could see
 * it (issue #591). A `{{data.*}}` in an **OAuth 2.0** config is refused
 * outright, with or without a data set: that token is acquired here, once, so
 * there is no iteration for a row to reach.
 */
ScenarioResolution resolve_scenario (vayu::db::Database& db,
const nlohmann::json& scenario,
const ScenarioResolveOptions& options);

/**
 * @brief The contract-coverage tally for @p execution (issue #629).
 *
 * Inactive - and therefore silent in the summary - for a run that is not
 * measured against a contract. One builder for both executors, so a design run
 * and a load run of one collection can never come to resolve their steps'
 * identities differently.
 */
[[nodiscard]] CoverageTally make_coverage_tally (const ScenarioExecution& execution);

/**
 * Bind one iteration's whole per-iteration state into @p step's @p request:
 * @p row where the step has one, then @p identity.
 *
 * Both executors call this rather than the two binds in sequence, so a step
 * cannot bind differently depending on which one ran it - fields first, then
 * the credentials the plan deliberately left unresolved, which is the order
 * `apply_auth` makes load-bearing (issue #591), and the identity last. The row goes first because the identity cannot fail on
 * its own account and a row can, so the more specific refusal is the one a
 * caller reports.
 *
 * `nullopt` @p row is a run sent without `data` - the identity still binds,
 * which is the whole point of it being independent of the data set. A no-op
 * returning success for the ordinary step, which carries neither kind of token.
 *
 * A step whose auth waits on its scripts (`ScenarioStep::auth_after_scripts`,
 * issue #2473) gets its credentials joined into @p late_auth instead, and
 * nothing applied: the executor owes `http::routes::apply_late_auth` after
 * `step.before` and the residual pass, or the step goes out unauthenticated.
 * @p late_auth is left alone for every other step.
 */
[[nodiscard]] DataBindResult bind_step_iteration (vayu::Request& request,
const ScenarioStep& step,
const std::vector<nlohmann::json>& rows,
std::optional<size_t> row_index,
IterationIdentity identity,
std::optional<vayu::http::Auth>& late_auth);

/**
 * The `scenario` object a scenario run stores in `runs.config_snapshot`: the
 * request as validated, plus `{index, requestId, name, method, url}` per step.
 *
 * **`url` is the stored, uncomposed one and the composed plan is never
 * persisted.** The plan carries resolved `Authorization` headers, and an
 * `apikey` auth with `in: "query"` puts a live key in the composed URL;
 * `sanitize_config_snapshot` (`utils/json.cpp`) withholds credentials from the
 * one composed request a snapshot holds, and reads neither a plan's steps nor
 * their built auth. The full plan lives in memory for the run's life and
 * nowhere else.
 *
 * A spec-bound collection also stamps `openapi: {specId, specHash}` here
 * (issue #637), which `GET /runs/:id/report` echoes under `metadata` and #629's
 * coverage report reads as its anchor. @p spec unbound stamps **nothing** - the
 * key is absent rather than null, so "this run was not measured against a spec"
 * is one answer with one spelling.
 */
nlohmann::json build_scenario_manifest (const ScenarioRequest& request,
const ScenarioPlan& plan,
const SpecBinding& spec = {});

} // namespace vayu::core
