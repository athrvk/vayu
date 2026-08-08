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
 * Composition goes through `compose_request_core` / `build_request` and the
 * script join through `read_pre_request_script` / `read_post_request_script`,
 * which is what keeps a step byte-identical to what a Send of the same request
 * would run. There is deliberately no second copy of resolution here.
 */

#include <cstddef>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

#include "vayu/db/database.hpp"
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
    /// Joined script parts (collection chain, then the request's own).
    std::string pre_script;
    std::string post_script;
    /// The stored, uncomposed URL. Carried on the step so the snapshot manifest
    /// can record a URL that is safe to persist without re-reading the row -
    /// `request.url` has `{{vars}}` substituted and may carry an `apikey` auth
    /// with `in: "query"`, i.e. a live key.
    std::string stored_url;
};

/** An ordered, immutable sequence of composed steps. */
struct ScenarioPlan {
    std::vector<ScenarioStep> steps;
};

/**
 * The validated `scenario` block of a `POST /runs` payload.
 *
 * `data` rows themselves are deliberately absent: they are user data of unknown
 * sensitivity and are never snapshotted, so only their count survives
 * validation.
 */
struct ScenarioRequest {
    /// Only `"collection"` today. The discriminator exists so a future stored
    /// scenario resolves to the same plan; an unknown value is rejected rather
    /// than falling through to the collection path.
    std::string source;
    std::string collection_id;
    /// Descend into sub-collections, depth-first by `collections.order`.
    bool recursive = false;
    /// Resolved: an explicit count wins, otherwise the data row count, else 1.
    size_t iterations     = 1;
    size_t data_row_count = 0;
};

/**
 * A resolved scenario, ready to execute: what was asked for and what it
 * resolved to.
 *
 * The two travel together from the route to the run's worker thread because
 * neither is enough on its own - the plan is what executes, and the request is
 * what says how many times and (from phase 5) with which data rows. Held by
 * `shared_ptr<const>`: resolution happened once, before the run row existed,
 * and nothing may edit it afterwards.
 */
struct ScenarioExecution {
    ScenarioRequest request;
    ScenarioPlan plan;
};

/** Bounds a plan must respect, read from config by the caller. */
struct ScenarioLimits {
    size_t max_steps     = 0;
    size_t max_data_rows = 0;
};

/**
 * Everything resolution needs beyond the `scenario` block itself.
 *
 * `environment_id` is not part of the block: it is the *run's* environment, and
 * composition needs it or every `{{env var}}` in the plan resolves to "".
 */
struct ScenarioResolveOptions {
    std::string environment_id;
    /// Applied to every composed step, exactly as `POST /execute` applies it.
    int timeout_ms = 0;
    ScenarioLimits limits;
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
    ScenarioRequest request;
    ScenarioPlan plan;
};

/**
 * Validate a `scenario` block and resolve it into a plan.
 *
 * Ordering is a collection's direct requests by `requests.order`, then - when
 * `recursive` is set - descendant collections by `collections.order`,
 * depth-first. The `collections` tree is not constraint-enforced, so the walk
 * carries a visited set exactly as `Database::delete_collection`'s BFS does: a
 * `parent_id` cycle terminates instead of growing forever under the DB mutex.
 *
 * Every failure below is loud, never a silently smaller run: an unknown
 * `collectionId`, an empty sequence, a step whose composition fails, a plan
 * over `limits.max_steps`, a `data` array that is present and empty or over
 * `limits.max_data_rows`, and any `source` other than `"collection"`.
 */
ScenarioResolution resolve_scenario (vayu::db::Database& db,
const nlohmann::json& scenario,
const ScenarioResolveOptions& options);

/**
 * The `scenario` object a scenario run stores in `runs.config_snapshot`: the
 * request as validated, plus `{index, requestId, name, method, url}` per step.
 *
 * **`url` is the stored, uncomposed one and the composed plan is never
 * persisted.** The plan carries resolved `Authorization` headers, and an
 * `apikey` auth with `in: "query"` puts a live key in the composed URL;
 * `sanitize_config_snapshot` (`utils/json.cpp`) exists to keep exactly that out
 * of the run store, and persisting a composed plan would route around its
 * allowlist. The full plan lives in memory for the run's life and nowhere else.
 */
nlohmann::json build_scenario_manifest (const ScenarioRequest& request,
const ScenarioPlan& plan);

} // namespace vayu::core
