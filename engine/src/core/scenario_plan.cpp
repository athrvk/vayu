/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_plan.hpp"

#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>

#include "vayu/core/scenario_data.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/script_parts.hpp"

namespace vayu::core {

namespace {

ScenarioResolution invalid (std::string reason) {
    ScenarioResolution resolution;
    resolution.ok    = false;
    resolution.error = std::move (reason);
    return resolution;
}

/// The human-readable half of a compose error. `routes::error_message_of` is
/// the shared reader for this shape, but it lives behind `routes.hpp`, which
/// pulls in httplib - a dependency `vayu_core` deliberately does not carry. The
/// shape itself is `error_body`'s and is pinned by `error_shape_route_test`.
std::string compose_error_message (const nlohmann::json& body) {
    if (auto error = body.find ("error"); error != body.end () && error->is_object ()) {
        if (auto message = error->find ("message");
        message != error->end () && message->is_string ()) {
            return message->get<std::string> ();
        }
    }
    return body.dump ();
}

/// How a step is named in an error message: enough to find the row in the app
/// without opening the database.
std::string describe_step (size_t index, const vayu::db::Request& row) {
    return "step " + std::to_string (index) + " (request '" + row.name +
    "', id '" + row.id + "')";
}

/**
 * The tail the no-data refusal carries when the collection declares a data
 * contract (issue #599): ` (declared columns: id, email)`, or empty when it
 * declares none.
 *
 * The refusal already says "run the collection with a data file"; a user whose
 * collection has declared its columns can be told *which* file, which is the
 * difference between re-reading the request and picking one. Anything the
 * schema cannot be trusted to hold - it is a stored blob, and an older or
 * hand-edited row may hold anything - degrades to no tail rather than to a
 * message about column names that are not strings.
 */
std::string declared_columns_hint (const vayu::db::Collection& collection) {
    nlohmann::json schema;
    try {
        schema = nlohmann::json::parse (collection.data_schema);
    } catch (const std::exception&) {
        return {};
    }
    if (!schema.is_object () || !schema.contains ("columns") ||
    !schema["columns"].is_array ()) {
        return {};
    }
    std::string names;
    for (const auto& column : schema["columns"]) {
        if (!column.is_string ()) {
            continue;
        }
        if (!names.empty ()) {
            names += ", ";
        }
        names += column.get<std::string> ();
    }
    return names.empty () ? std::string{} : " (declared columns: " + names + ")";
}

/**
 * The ordered request rows a scenario covers, before anything is composed.
 *
 * Split from composition so the plan-size cap can reject an oversized folder
 * for the cost of the row reads rather than after composing every step - and
 * so the ordering rules are readable on their own.
 */
std::vector<vayu::db::Request>
collect_requests (vayu::db::Database& db, const std::string& root_id, bool recursive) {
    if (!recursive) {
        return db.get_requests_in_collection (root_id);
    }

    // One read of the collection table, grouped by parent. `get_collections`
    // orders by `order`, so each parent's children keep that order - and the
    // whole descent costs one query instead of one per node.
    std::unordered_map<std::string, std::vector<vayu::db::Collection>> children;
    for (auto& collection : db.get_collections ()) {
        if (collection.parent_id && !collection.parent_id->empty ()) {
            children[*collection.parent_id].push_back (std::move (collection));
        }
    }

    // Two entry kinds share one stack. `Descend` queues a collection's subtree,
    // `Emit` appends that collection's own requests - and because the marker is
    // pushed *underneath* the children, every subfolder's subtree is emitted
    // before the folder's own requests. That is the sidebar's order, which
    // renders `childCollections` above `requests` at every depth
    // (`CollectionItem.tsx`), and a recursive run has to execute in the order
    // the user is looking at (issue #431, the #360 rule one level up).
    enum class Step : std::uint8_t { Descend, Emit };
    struct Entry {
        Step step;
        std::string id;
    };

    std::vector<vayu::db::Request> ordered;
    std::unordered_set<std::string> visited;
    std::vector<Entry> stack{ { Step::Descend, root_id } };
    while (!stack.empty ()) {
        const Entry entry = std::move (stack.back ());
        stack.pop_back ();

        if (entry.step == Step::Emit) {
            for (auto& row : db.get_requests_in_collection (entry.id)) {
                ordered.push_back (std::move (row));
            }
            continue;
        }

        // The visited set is what makes a corrupted `parent_id` (a self-parent,
        // or an A -> B -> A loop written before write-time validation existed)
        // terminate rather than grow `ordered` forever under the DB mutex -
        // the same guard `Database::delete_collection`'s BFS carries. An `Emit`
        // is only queued past this point, so a cycle cannot double-emit either.
        if (!visited.insert (entry.id).second) {
            continue;
        }
        stack.push_back ({ Step::Emit, entry.id });

        if (auto it = children.find (entry.id); it != children.end ()) {
            // Reversed, so the stack pops them in `collections.order`: the
            // first child's whole subtree, then the second's, then - last -
            // this collection's own requests.
            for (auto child = it->second.rbegin (); child != it->second.rend (); ++child) {
                stack.push_back ({ Step::Descend, child->id });
            }
        }
    }
    return ordered;
}

/**
 * The `data` rows a *scenario* binds, through the shared reader below.
 *
 * They reach the run's worker (as `pm.iterationData`) but never the plan or the
 * snapshot - the app owns parsing the file they came from, and only their count
 * is persisted. A rejected set leaves no rows behind, never the ones before the
 * bad one, which would be a partial data set.
 */
std::optional<std::string> read_scenario_data (const nlohmann::json& data,
const ScenarioLimits& limits,
ScenarioRequest& out,
std::vector<nlohmann::json>& rows_out) {
    if (auto reason = read_data_rows (data, limits, "scenario.data", rows_out)) {
        return reason;
    }
    out.data_row_count = rows_out.size ();
    return std::nullopt;
}

/**
 * The iteration count: an explicit one wins and the row index wraps; absent, a
 * data set sets it to its row count (Postman's default) and everything else
 * runs once.
 */
std::optional<std::string> read_scenario_iterations (const nlohmann::json& scenario,
bool has_data,
ScenarioRequest& out) {
    if (auto iterations = scenario.find ("iterations");
    iterations != scenario.end () && !iterations->is_null ()) {
        constexpr double max_iterations =
        static_cast<double> (std::numeric_limits<int>::max ());
        const bool usable = iterations->is_number () &&
        std::isfinite (iterations->get<double> ()) && iterations->get<double> () >= 1.0 &&
        iterations->get<double> () <= max_iterations &&
        iterations->get<double> () == std::floor (iterations->get<double> ());
        if (!usable) {
            return "'scenario.iterations' must be a whole number between 1 and "
                   "2147483647 (got " +
            iterations->dump () + ")";
        }
        out.iterations = static_cast<size_t> (iterations->get<double> ());
    } else if (has_data) {
        out.iterations = out.data_row_count;
    }
    return std::nullopt;
}

/// Validate the block's own fields. The plan is not touched here; a malformed
/// payload must not cost a collection walk.
std::optional<std::string> parse_scenario_request (const nlohmann::json& scenario,
const ScenarioLimits& limits,
ScenarioRequest& out,
std::vector<nlohmann::json>& rows_out) {
    if (!scenario.is_object ()) {
        return "'scenario' must be a JSON object (got " +
        std::string (scenario.type_name ()) + ")";
    }

    const auto source = scenario.find ("source");
    if (source == scenario.end () || !source->is_string ()) {
        return "'scenario.source' is required and must be the string "
               "\"collection\"";
    }
    if (source->get<std::string> () != "collection") {
        return "'scenario.source' must be \"collection\" (got " + source->dump () +
        "). The discriminator exists for a future stored scenario; an unknown "
        "value is not a collection run.";
    }
    out.source = "collection";

    const auto collection_id = scenario.find ("collectionId");
    if (collection_id == scenario.end () || !collection_id->is_string () ||
    collection_id->get<std::string> ().empty ()) {
        return "'scenario.collectionId' is required and must be a non-empty "
               "string";
    }
    out.collection_id = collection_id->get<std::string> ();

    if (auto recursive = scenario.find ("recursive");
    recursive != scenario.end () && !recursive->is_null ()) {
        if (!recursive->is_boolean ()) {
            return "'scenario.recursive' must be a boolean (got " +
            std::string (recursive->type_name ()) + ")";
        }
        out.recursive = recursive->get<bool> ();
    }

    // `data` rows reach the run's worker (as `pm.iterationData`) but never the
    // plan or the snapshot - the app owns parsing the file they came from, and
    // only their count is persisted.
    bool has_data = false;
    if (auto data = scenario.find ("data"); data != scenario.end () && !data->is_null ()) {
        if (auto reason = read_scenario_data (*data, limits, out, rows_out)) {
            return reason;
        }
        has_data = true;
    }

    if (auto reason = read_scenario_iterations (scenario, has_data, out)) {
        return reason;
    }

    return std::nullopt;
}

} // namespace

namespace {

/**
 * The contract this run is measured against, and the schemas that go with it.
 *
 * Read once here and stamped into the snapshot by `build_scenario_manifest`
 * (issue #637). Any disagreement - no such document, no index on it, a hash
 * that does not match - leaves the operations empty, which is the engine's one
 * spelling of "not measured against a contract"; which disagreement it was is
 * recorded too (issue #681), and only the collection runner reads it.
 */
void resolve_bound_spec (vayu::db::Database& db,
const std::string& collection_id,
ScenarioResolution& resolution) {
    // The spec this run is measured against, read once here and stamped into the
    // snapshot by `build_scenario_manifest` (issue #637). Read from the
    // collection chain rather than looked up in `spec_documents`: the hash *on
    // the binding* is what the collection was last synced to, and that - not
    // whatever the document says today - is what the run was planned against.
    //
    // Resolved through `nearest_spec_binding`, the same walk design-mode
    // validation uses, because an import binds the root and files every request
    // under tag sub-collections: reading only the named collection's own column
    // left the natural "run this tag folder" measuring nothing at all, silently
    // (issue #716).
    if (const auto bound = nearest_spec_binding (db, collection_id)) {
        resolution.spec.spec_id   = bound->spec_id;
        resolution.spec.spec_hash = bound->spec_hash;
        resolution.spec.inherited = bound->collection_id != collection_id;
    }

    // The document's declared operations, read once here so contract coverage
    // (#629) counts against the contract this run was planned against. The hash
    // has to agree: the binding names a document *and a version of it*, and a
    // row whose hash has moved under the binding is a state no run should report
    // a contract from. Any disagreement - no such document, no index on it, a
    // hash that does not match - leaves the operations empty, which is the
    // engine's one spelling of "not measured against a contract".
    //
    // The response schemas ride the same read and the same hash check (issue
    // #682): the deferred pass at run end validates against them, and looking
    // them up then instead would be the one thing this read exists to prevent.
    // They are taken as text and parsed only by an executor that will use them.
    //
    // Which of the two disagreements happened is recorded as well (issue #681),
    // and only the collection runner reads it: that one emits a verdict per
    // step, so its `checked: false` has to name a reason the reader can act on -
    // "the document has moved under the binding" is fixed by a sync, and a
    // per-step chip that silently never appears is how they never learn of it.
    // The load pass needs none of that; an absent block is its whole answer.
    if (resolution.spec.bound ()) {
        const auto document = db.get_spec_document (resolution.spec.spec_id);
        if (!document) {
            resolution.spec.schema_reason = UncheckedReason::NoIndex;
        } else if (resolution.spec.spec_hash.empty ()) {
            // A binding that names no version is not a document that moved
            // (issue #709). Every write path stamps the version now and the
            // startup pass repairs the rows written before they did, so this is
            // a database edited from outside - and it is still worth its own
            // reason, because "sync the collection" is the wrong instruction
            // for it and a sync of an unchanged document would not repair it.
            resolution.spec.schema_reason = UncheckedReason::NeverStamped;
        } else if (document->hash != resolution.spec.spec_hash) {
            resolution.spec.schema_reason = UncheckedReason::HashMismatch;
        } else {
            if (auto declared = parse_declared_operations (document->operations)) {
                resolution.spec.declared_operations = std::move (*declared);
            }
            resolution.spec.response_schemas = document->response_schemas;
        }
    }
}

/**
 * One step of the plan: composed, built, and refused if it carries a token
 * nothing in this run could bind.
 *
 * @return the reason this scenario cannot run, or nothing.
 */
std::optional<std::string> resolve_step (vayu::db::Database& db,
const ScenarioResolveOptions& options,
const vayu::db::Collection& collection,
bool has_data,
size_t index,
const vayu::db::Request& row,
ScenarioPlan& plan) {
    // The by-id compose path: the same resolution a Send of this request
    // performs, so a step's request and scripts cannot drift from it.
    nlohmann::json compose_body{ { "requestId", row.id } };
    if (!options.environment_id.empty ()) {
        compose_body["environmentId"] = options.environment_id;
    }
    auto [status, payload] = vayu::http::compose_request_core (db, compose_body);
    if (status != 200) {
        return ("Cannot compose " + describe_step (index, row) + ": " +
        compose_error_message (payload));
    }

    // Auth is resolved into headers/url here, which is what makes the plan
    // credential-grade and the snapshot manifest necessary - unless the
    // credentials themselves come from the data file. `apply_auth`
    // collapses basic auth into one base64 `Authorization` value, so a
    // `{{data.user}}` resolved into the plan is unreadable by the time
    // anything scans the built request: it used to go out as base64 of the
    // literal token text, silently, and the refusal below could not see it
    // either (issue #591). Such a step keeps its credentials typed and
    // unbound and applies its auth per iteration instead - one base64 per
    // iteration, and only for the steps that need it.
    const vayu::http::Auth parsed_auth =
    vayu::http::parse_auth (payload.value ("auth", nlohmann::json ()));
    StepDataTemplate auth_template = tokenize_auth_fields (parsed_auth);

    // OAuth 2.0 is the one mode deferral cannot serve: its token is
    // acquired right here, once, against the token endpoint, so there is no
    // per-iteration acquisition for a row to reach - and adding one would
    // mean a network round trip per virtual user per iteration. Refused by
    // name in both directions, with or without a data set, rather than sent
    // to the token endpoint as the literal token text.
    if (auto token = first_oauth2_data_token (parsed_auth)) {
        return (describe_step (index, row) + " carries " + *token +
        " in its OAuth 2.0 configuration. That token is acquired once, "
        "when the run is planned, so a data column can never reach it - "
        "use a static credential there, or move the data token into the "
        "request itself.");
    }

    // Deferred through the builder's own option rather than by hiding the
    // `auth` key from it: one mechanism, named at the call site, shared
    // with the single send that defers for the same reason (issue #642).
    const auto auth_resolution = auth_template.empty () ?
    vayu::http::AuthResolution::Apply :
    vayu::http::AuthResolution::Defer;
    auto built =
    vayu::http::build_request (payload, &db, options.timeout_ms, auth_resolution);
    if (!built.ok || built.parse_failed) {
        return ("Cannot compose " + describe_step (index, row) + ": " + built.error_message);
    }

    // Split once, here, so no executor re-scans this step per iteration -
    // the load-mode one binds a row per iteration per virtual user, which
    // is a scan of every field of every step at the run's full rate.
    auto data_template = tokenize_bindable_fields (built.request);

    // A `{{data.*}}` token with no data set behind it can never bind. The
    // namespace is reserved, so composition deliberately left the token
    // written as it stands, and a run without rows has nothing to
    // substitute it from - it would reach the wire as the literal text
    // `{{data.id}}`, which is not a request anyone meant to send. Refused
    // here, beside every other unrunnable scenario and before a run row
    // exists, rather than rediscovered per step per iteration once it has
    // started (issue #415).
    if (!has_data) {
        auto token = data_template.first_data_token ();
        if (!token) {
            // The credentials are scanned too, and for the same reason: a
            // data token in a basic-auth field is exactly as unbindable as
            // one in the URL, and until it was kept out of the base64 above
            // this refusal could not see it at all.
            token = auth_template.first_data_token ();
        }
        if (token) {
            return (describe_step (index, row) + " carries " + *token +
            ", but this run has no 'scenario.data' set. A data token has "
            "no row to bind to and would reach the wire written as it "
            "stands - run the collection with a data file, or remove the "
            "token from the request (or from the variable value it was "
            "written into)." +
            declared_columns_hint (collection));
        }
    }

    ScenarioStep step;
    step.index          = index;
    step.request_id     = row.id;
    step.name           = row.name;
    step.request        = std::move (built.request);
    step.pre_script     = vayu::http::read_pre_request_script (payload);
    step.post_script    = vayu::http::read_post_request_script (payload);
    step.stored_url     = row.url;
    step.spec_operation = row.spec_operation.value_or (std::string ());
    step.data_template  = std::move (data_template);
    // Only ever reached with rows behind it: the refusal above returns for
    // a credential token in a run that has no data set, so a deferred step
    // cannot arrive at an executor with no row to bind.
    if (!auth_template.empty ()) {
        step.auth          = parsed_auth;
        step.auth_template = std::move (auth_template);
    }
    plan.steps.push_back (std::move (step));
    return std::nullopt;
}

} // namespace

std::optional<std::string> read_data_rows (const nlohmann::json& data,
const ScenarioLimits& limits,
std::string_view field,
std::vector<nlohmann::json>& rows_out) {
    const std::string name = "'" + std::string (field) + "'";
    if (!data.is_array ()) {
        return name + " must be an array of objects (got " +
        std::string (data.type_name ()) + ")";
    }
    if (data.empty ()) {
        return name +
        " is present but empty. A data set that binds "
        "nothing is a mistake, not an empty run - omit the field to "
        "run without one.";
    }
    if (data.size () > limits.max_data_rows) {
        return name + " has " + std::to_string (data.size ()) +
        " rows, over the limit of " + std::to_string (limits.max_data_rows) +
        " (raise the 'maxScenarioDataRows' setting to allow more)";
    }
    rows_out.reserve (data.size ());
    // Accumulated row by row rather than dumping the whole array: an
    // oversized set is refused as soon as it crosses the bound, so the
    // check never materializes a second copy of a payload that is already
    // too big to want one.
    size_t data_bytes = 0;
    for (size_t i = 0; i < data.size (); ++i) {
        if (!data[i].is_object ()) {
            // A rejected set leaves no rows behind - never the ones before
            // the bad one, which would be a partial data set.
            rows_out.clear ();
            return name + " row " + std::to_string (i) +
            " must be an object of name/value pairs (got " +
            std::string (data[i].type_name ()) + ")";
        }
        data_bytes += data[i].dump ().size ();
        if (data_bytes > limits.max_data_bytes) {
            rows_out.clear ();
            return name + " is larger than the limit of " +
            std::to_string (limits.max_data_bytes) +
            " bytes (raise the 'maxScenarioDataBytes' setting to allow "
            "more). The row count is within its own limit - a data set can "
            "exceed this one with few but large rows.";
        }
        rows_out.push_back (data[i]);
    }
    return std::nullopt;
}

ScenarioResolution resolve_scenario (vayu::db::Database& db,
const nlohmann::json& scenario,
const ScenarioResolveOptions& options) {
    ScenarioResolution resolution;
    if (auto reason = parse_scenario_request (
        scenario, options.limits, resolution.request, resolution.data_rows)) {
        return invalid (*reason);
    }
    const ScenarioRequest& request = resolution.request;

    // Captured, not just probed: the collection carries the declared data
    // contract, and the no-data refusal below is the reader that makes storing
    // one worth anything.
    const auto collection = db.get_collection (request.collection_id);
    if (!collection) {
        return invalid ("No collection with id '" + request.collection_id + "'");
    }

    resolve_bound_spec (db, request.collection_id, resolution);


    const auto rows = collect_requests (db, request.collection_id, request.recursive);
    if (rows.empty ()) {
        return invalid ("Collection '" + request.collection_id + "' has no requests" +
        std::string (request.recursive ? " in it or any sub-collection" : "") +
        ". An empty sequence is a mistake, not a zero-step run.");
    }
    if (rows.size () > options.limits.max_steps) {
        return invalid ("Scenario resolves to " + std::to_string (rows.size ()) +
        " steps, over the limit of " + std::to_string (options.limits.max_steps) +
        " (raise the 'maxScenarioSteps' setting to allow more)");
    }

    // A `data` array that is present and empty was already refused above, so an
    // empty `data_rows` here means the payload carried no `data` block at all.
    const bool has_data = !resolution.data_rows.empty ();

    resolution.plan.steps.reserve (rows.size ());
    for (size_t index = 0; index < rows.size (); ++index) {
        if (auto reason = resolve_step (db, options, *collection, has_data,
            index, rows[index], resolution.plan)) {
            return invalid (*reason);
        }
    }

    resolution.ok = true;
    return resolution;
}

CoverageTally make_coverage_tally (const ScenarioExecution& execution) {
    std::vector<std::string> step_operations;
    step_operations.reserve (execution.plan.steps.size ());
    for (const auto& step : execution.plan.steps) {
        step_operations.push_back (step.spec_operation);
    }
    return CoverageTally (execution.spec.declared_operations, step_operations);
}

DataBindResult bind_step_row (vayu::Request& request,
const ScenarioStep& step,
const nlohmann::json& row,
size_t row_index) {
    // The fields-then-credentials order lives in one place, shared with the
    // single-request load path that binds its own templates the same way
    // (issue #993); this is the step-shaped caller of it. The step's auth is
    // copied by the callee, which is what a plan shared by every virtual user
    // of the run requires.
    const IterationBinding binding{ &row, row_index, IterationIdentity{} };
    return bind_iteration (
    request, step.data_template, step.auth, step.auth_template, binding);
}

DataBindResult bind_step_iteration (vayu::Request& request,
const ScenarioStep& step,
const std::vector<nlohmann::json>& rows,
std::optional<size_t> row_index,
IterationIdentity identity) {
    // `.at()` rather than a subscript: the index was claimed off a cursor taken
    // modulo this vector's own size, so a mismatch is a broken invariant and a
    // throw names it instead of reading past the end.
    const IterationBinding binding{ row_index ? &rows.at (*row_index) : nullptr,
        row_index.value_or (0), identity };
    return bind_iteration (
    request, step.data_template, step.auth, step.auth_template, binding);
}

nlohmann::json build_scenario_manifest (const ScenarioRequest& request,
const ScenarioPlan& plan,
const SpecBinding& spec) {
    nlohmann::json steps = nlohmann::json::array ();
    for (const auto& step : plan.steps) {
        steps.push_back ({ { "index", step.index }, { "requestId", step.request_id },
        { "name", step.name }, { "method", to_string (step.request.method) },
        { "url", step.stored_url } });
    }

    nlohmann::json manifest{ { "source", request.source },
        { "collectionId", request.collection_id },
        { "recursive", request.recursive }, { "iterations", request.iterations },
        { "dataRowCount", request.data_row_count }, { "steps", std::move (steps) } };
    // Absent for an unbound collection, never `null` or `{}` - see the header.
    if (spec.bound ()) {
        manifest["openapi"] =
        nlohmann::json{ { "specId", spec.spec_id }, { "specHash", spec.spec_hash } };
        // Carried only when it happened, like every other finding in the report:
        // absent means the run's own collection binds the document (issue #716).
        if (spec.inherited) {
            manifest["openapi"]["inherited"] = true;
        }
    }
    return manifest;
}

} // namespace vayu::core
