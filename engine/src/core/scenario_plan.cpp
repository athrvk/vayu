/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_plan.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>

#include "vayu/core/constants.hpp"
#include "vayu/core/run_manager.hpp"
#include "vayu/core/scenario_data.hpp"
#include "vayu/core/spec_binding.hpp"
#include "vayu/http/auth_resolver.hpp"
#include "vayu/http/request_builder.hpp"
#include "vayu/http/request_composer.hpp"
#include "vayu/http/request_exchange.hpp"
#include "vayu/http/sse_stream.hpp"
#include "vayu/http/target_policy.hpp"
#include "vayu/utils/json.hpp"
#include "vayu/utils/sha256.hpp"

namespace vayu::core {

namespace {

ScenarioResolution invalid (std::string reason, std::string code = {}) {
    ScenarioResolution resolution;
    resolution.ok         = false;
    resolution.error      = std::move (reason);
    resolution.error_code = std::move (code);
    return resolution;
}

/// Why one step cannot be planned, and the code when the refusal has its own (a
/// target policy's, #2521). A bare reason converts, for a refusal with no code.
struct StepRefusal {
    std::string reason;
    std::string code;

    StepRefusal (std::string text, std::string refusal_code = {})
    : reason (std::move (text)), code (std::move (refusal_code)) {
    }
};

/// The human-readable half of a compose error. `routes::error_message_of` is
/// the shared reader, but it sits behind `routes.hpp`, which pulls in httplib,
/// a dependency `vayu_core` deliberately does not carry. The shape is
/// `error_body`'s, pinned by `error_shape_route_test`.
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
 * contract (#599): ` (declared columns: id, email)`, or empty when it declares
 * none. The refusal already says "run the collection with a data file"; naming
 * the declared columns says *which* file. The schema is a stored blob an older
 * or hand-edited row may fill with anything, so anything untrustworthy degrades
 * to no tail rather than a message about column names that are not strings.
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
 * The ordered request rows a scenario covers, before anything is composed:
 * split from composition so the plan-size cap rejects an oversized folder for
 * the cost of the row reads, not after composing every step. A recursive run
 * walks the subtree in sidebar order, each sub-folder's subtree where the
 * sub-folder sits among its parent's requests (#431, #2535;
 * `Database::get_requests_in_subtree`).
 */
std::vector<vayu::db::Request>
collect_requests (vayu::db::Database& db, const std::string& root_id, bool recursive) {
    return recursive ? db.get_requests_in_subtree (root_id) :
                       db.get_requests_in_collection (root_id);
}

/**
 * The `data` rows a *scenario* binds, through the shared reader below. They
 * reach the run's worker (as `pm.iterationData`) but never the plan or the
 * snapshot: the app owns parsing their file, and only their count (beside the
 * file's name and hash) is persisted. A rejected set leaves no rows, never the
 * ones before the bad one, which would be a partial data set.
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

    bool has_data = false;
    if (auto data = scenario.find ("data"); data != scenario.end () && !data->is_null ()) {
        if (auto reason = read_scenario_data (*data, limits, out, rows_out)) {
            return reason;
        }
        has_data = true;
    }
    if (auto reason =
        read_data_file_fields (scenario, "scenario.", has_data, out.data_file)) {
        return reason;
    }

    if (auto reason = read_scenario_iterations (scenario, has_data, out)) {
        return reason;
    }

    // Refused rather than ignored (#1503): a key this block does not read (a
    // typo, or a knob from a client ahead of this engine) would change nothing
    // and answer 202 anyway, a silence every future scenario field would
    // inherit. The refusal lists this set by hand, so the two change together.
    static const std::unordered_set<std::string> known_scenario_keys = {
        "source", "collectionId", "recursive", "data", "dataFileName",
        "dataFileHash", "dataFileCastNumbers", "iterations"
    };
    for (const auto& [key, value] : scenario.items ()) {
        (void)value;
        if (!known_scenario_keys.contains (key)) {
            return "'scenario." + key +
            "' is not a known field - expected one of source, collectionId, "
            "recursive, data, dataFileName, dataFileHash, dataFileCastNumbers, "
            "iterations";
        }
    }

    return std::nullopt;
}

} // namespace

namespace {

/**
 * The contract this run is measured against, and its schemas, read once here
 * and stamped into the snapshot by `build_scenario_manifest` (#637). Any
 * disagreement (no such document, no index on it, a hash that does not match)
 * leaves the operations empty, the engine's one spelling of "not measured
 * against a contract"; which one it was is recorded too (#681), and only the
 * collection runner reads it.
 */
void resolve_bound_spec (vayu::db::Database& db,
const std::string& collection_id,
ScenarioResolution& resolution) {
    // From the collection chain, not `spec_documents`: the hash *on the
    // binding* is what the collection was last synced to, and that, not the
    // document's current text, is what the run was planned against. Through
    // `nearest_spec_binding`, the walk design-mode validation uses, because an
    // import binds the root and files every request under tag sub-collections,
    // and reading only the named collection's column would leave "run this tag
    // folder" silently measuring nothing (#716).
    if (const auto bound = nearest_spec_binding (db, collection_id)) {
        resolution.spec.spec_id   = bound->spec_id;
        resolution.spec.spec_hash = bound->spec_hash;
        resolution.spec.inherited = bound->collection_id != collection_id;
    }

    // The declared operations, so contract coverage (#629) counts against the
    // contract the run was planned against. The hash must agree: the binding
    // names a document *and a version*, and a row whose hash moved under it is
    // no state to report a contract from.
    //
    // The response schemas ride the same read and hash check (#682): the
    // run-end deferred pass validates against them, and a lookup then is what
    // this read prevents. Taken as text, parsed only by an executor that uses
    // them.
    //
    // The collection runner reads the recorded disagreement (#681) because it
    // emits a verdict per step, so its `checked: false` must name a reason the
    // reader can act on: "the document has moved under the binding" is fixed by
    // a sync, and a per-step chip that silently never appears is how they never
    // learn of it. The load pass needs none; an absent block is its whole
    // answer.
    if (resolution.spec.bound ()) {
        const auto document = db.get_spec_document (resolution.spec.spec_id);
        if (!document) {
            resolution.spec.schema_reason = UncheckedReason::NoIndex;
        } else if (resolution.spec.spec_hash.empty ()) {
            // A binding that names no version is not a document that moved
            // (#709). Every write path stamps the version and the startup pass
            // repairs older rows, so this is a database edited from outside,
            // still worth its own reason: "sync the collection" is the wrong
            // instruction, and a sync of an unchanged document would not repair
            // it.
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
 * How every step of the plan over @p rows composes its scope names (#2521).
 * `Always` when one step's composed `elements` hold a kind the registry marks
 * `writes_variables` (`script.pre`, `script.post`, `script.setup`, every
 * `extract.*`) at a phase before some send: an earlier step's test script or
 * extractor can then set a token a later step reads, after composition and
 * before that send. `script.teardown` alone does not count: it runs after the
 * last send. The lists are composition's own, so disabled, blank and
 * `inherit.disable`d elements are already gone.
 */
vayu::http::VariableDeferral plan_variable_deferral (vayu::db::Database& db,
const std::vector<vayu::db::Request>& rows) {
    const auto& registry = Registry::instance ();
    const auto writes_before_a_send = [&registry] (const nlohmann::json& element) {
        const auto* kind = registry.find (element.value ("kind", std::string{}));
        return kind != nullptr && kind->writes_variables &&
        std::any_of (kind->phases.begin (), kind->phases.end (),
        [] (Phase phase) { return phase != Phase::RunEnd; });
    };
    for (const auto& row : rows) {
        const auto elements = vayu::http::stored_request_elements (db, row);
        if (std::any_of (elements.begin (), elements.end (), writes_before_a_send)) {
            return vayu::http::VariableDeferral::Always;
        }
    }
    return vayu::http::VariableDeferral::WhenScripted;
}

/**
 * A load step's `auth.config.privateKey` reference resolved in @p payload from
 * the scopes its composition read (#3632), before its token is acquired below.
 * The PEM stays in memory in the step's `oauth2_config` for the watchdog to
 * re-sign with; a sequential step leaves the reference to `apply_late_auth`.
 *
 * @return the refusal naming the reference when no variable answers it.
 */
std::optional<std::string> resolve_load_step_signing_key (vayu::db::Database& db,
const ScenarioResolveOptions& options,
const vayu::db::Request& row,
nlohmann::json& payload) {
    auto* config = vayu::http::config_naming_private_key (payload);
    if (config == nullptr) {
        return std::nullopt;
    }
    const std::optional<std::string> environment_id = options.environment_id.empty () ?
    std::nullopt :
    std::optional<std::string> (options.environment_id);
    return vayu::http::resolve_private_key_reference (*config,
    vayu::http::routes::flatten_variable_scopes (vayu::http::routes::load_script_variable_scopes (
    db, environment_id, row.collection_id)));
}

/**
 * The bounds a step whose stored request streams runs under: the run's caps,
 * and the row's own `streamTextPath` (#3773) and `streamFirstContentMarker`
 * (#3774) compiled here, once for every transfer of every user. Nothing for a
 * request that does not stream.
 */
std::optional<vayu::StreamBounds> step_stream_bounds (const vayu::db::Request& row,
const vayu::StreamBounds& run_bounds) {
    if (!row.stream) {
        return std::nullopt;
    }
    vayu::StreamBounds bounds = run_bounds;
    if (row.stream_text_path) {
        bounds.text_path = vayu::http::compile_stream_text_path (*row.stream_text_path);
    }
    if (row.stream_first_content_marker) {
        bounds.first_content_marker =
        vayu::http::compile_stream_content_marker (*row.stream_first_content_marker);
    }
    return bounds;
}

/**
 * One step of the plan: composed, built, and refused if it carries a token
 * nothing in this run could bind.
 *
 * @return the reason this scenario cannot run, or nothing.
 *
 * @param raw_elements_out This step's resolved `elements` array as
 *        `POST /compose` returned it, uncompiled. #1498's `timer.pacing` needs
 *        a pass over every step's array first, marking per element id across
 *        the *whole* iteration which occurrence is that node's start, so
 *        compiling here would compile a pacing element before knowing whether
 *        this is its node's first occurrence. `resolve_scenario` compiles every
 *        array after that pass.
 */
std::optional<StepRefusal> resolve_step (vayu::db::Database& db,
const ScenarioResolveOptions& options,
vayu::http::VariableDeferral deferral,
const vayu::db::Collection& collection,
bool has_data,
const vayu::http::BoundColumnNames& bound_columns,
size_t index,
const vayu::db::Request& row,
ScenarioPlan& plan,
nlohmann::json& raw_elements_out) {
    // The by-id compose path: the same resolution a Send of this request
    // performs, so a step's request and scripts cannot drift from it.
    nlohmann::json compose_body{ { "requestId", row.id } };
    if (!options.environment_id.empty ()) {
        compose_body["environmentId"] = options.environment_id;
    }
    // The dataset's columns go into composition rather than being applied after
    // it (#1007): a bare `{{username}}` the rows answer must survive
    // composition to bind per iteration, and a same-named environment variable
    // must not answer it first. Names only: the row is per iteration,
    // composition once.
    if (!bound_columns.empty ()) {
        compose_body["dataColumns"] = bound_columns;
    }
    // A plan step is composed once and *sent* per iteration, so generators
    // belong to the send (#995): resolved here, `{{$randomUUID}}` would be one
    // id repeated by every iteration of every virtual user. Unconditionally,
    // not only for a load run: both executors join this template before every
    // send, and a rule depending on the executor is one nobody could hold in
    // their head. A step with no generator is unaffected.
    compose_body["deferDynamicVariables"] = true;
    auto [status, payload] = vayu::http::compose_request_core (db, compose_body,
    options.oauth2_after_scripts ? vayu::http::OAuth2Resolution::AfterTheScript :
                                   vayu::http::OAuth2Resolution::AtComposition,
    deferral);
    if (status != 200) {
        return ("Cannot compose " + describe_step (index, row) + ": " +
        compose_error_message (payload));
    }
    if (!options.oauth2_after_scripts) {
        if (auto refusal = resolve_load_step_signing_key (db, options, row, payload)) {
            return describe_step (index, row) + ": " + *refusal;
        }
    }

    // Auth resolved into headers/url here is what makes the plan
    // credential-grade and the snapshot manifest necessary, unless the
    // credentials come from the data file or wait on a script (below).
    // `apply_auth` collapses basic auth into one base64 `Authorization` value,
    // so a `{{data.user}}` resolved into the plan is unreadable to any later
    // scan: it would go out silently as base64 of the literal token, invisible
    // to the refusal below too (#591). Such a step keeps its credentials typed
    // and unbound and applies auth per iteration, one base64 per iteration, for
    // only the steps that need it.
    const vayu::http::Auth parsed_auth =
    vayu::http::parse_auth (payload.value ("auth", nlohmann::json ()));
    StepDataTemplate auth_template = tokenize_auth_fields (parsed_auth, bound_columns);

    // OAuth 2.0 is the one mode the row bind cannot serve: its token is
    // acquired against the token endpoint (here, once, for a load run, or at
    // each sequential step's send), never per iteration, which would be a round
    // trip per virtual user per iteration. Refused by name in both directions,
    // with or without a data set, rather than sent to the token endpoint as the
    // literal token text.
    if (auto token = first_oauth2_deferrable_token (parsed_auth, bound_columns)) {
        return (describe_step (index, row) + " carries " + *token +
        " in its OAuth 2.0 configuration. That token is acquired against "
        "the token endpoint, never bound per iteration, so neither a data "
        "column nor the iteration identity can ever reach it - use a static "
        "credential there, or move the token into the request itself.");
    }
    // A load run acquires right here, before any script, so a name nothing
    // answered at composition would reach the token endpoint as written.
    if (!options.oauth2_after_scripts) {
        if (auto token = first_oauth2_scope_token (parsed_auth, bound_columns)) {
            return (describe_step (index, row) + " carries " + *token +
            " in its OAuth 2.0 configuration, and no variable answers it. A "
            "load run acquires the token once, when the run is planned and "
            "before any script runs - define the variable in the "
            "environment, the collection or the globals, or write the value "
            "into the configuration.");
        }
    }

    // A name composition found no scope for may be defined by a pre-request
    // script, an inline element or a setup script before the send, and none can
    // reach it once `apply_auth` encoded it (#2473). So is any name composition
    // deferred (#2521), OAuth 2.0 config included on a sequential plan.
    const bool auth_after_scripts =
    vayu::core::credentials_await_scripts (parsed_auth, bound_columns);

    // Deferred through the builder's own option rather than by hiding the
    // `auth` key from it: one mechanism, named at the call site, shared
    // with the single send that defers for the same reason (issue #642).
    const auto auth_resolution = auth_template.empty () && !auth_after_scripts ?
    vayu::http::AuthResolution::Apply :
    vayu::http::AuthResolution::Defer;

    // A step's own stored `timeout` (#2937) wins over the run's; a step that
    // states none takes the run's, itself the run's `timeout` or the setting.
    auto built = vayu::http::build_request (payload, &db,
    vayu::http::routes::resolve_request_timeout_ms (payload, options.timeout_ms),
    auth_resolution, options.target_policy, options.cancel);
    if (!built.ok || built.parse_failed) {
        return StepRefusal{ "Cannot compose " + describe_step (index, row) +
            ": " + built.error_message,
            vayu::http::is_target_refusal_code (built.detail_code) ? built.detail_code : "" };
    }

    // Split once, here, so no executor re-scans this step per iteration -
    // the load-mode one binds a row per iteration per virtual user, which
    // is a scan of every field of every step at the run's full rate.
    auto data_template = tokenize_bindable_fields (built.request, bound_columns);

    // A `{{data.*}}` token with no data set can never bind: the namespace is
    // reserved, so composition left it written, and it would reach the wire as
    // the literal `{{data.id}}`. Refused here with every other unrunnable
    // scenario, before a run row exists, rather than rediscovered per step per
    // iteration (#415).
    if (!has_data) {
        auto token = data_template.first_data_token ();
        if (!token) {
            // The credentials too: a data token in a basic-auth field is as
            // unbindable as one in the URL, and the base64 above would hide it
            // from this refusal.
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
    step.index      = index;
    step.request_id = row.id;
    step.name       = row.name;
    step.request    = std::move (built.request);
    // A stored stream runs as one under either executor (#3235), ended by a
    // cap or by the server's close rather than by the step's timeout.
    step.request.stream_bounds = step_stream_bounds (row, options.stream_bounds);
    // The only script source (#1514): `elements` resolves the collection
    // chain's and the request's script.pre / script.post entries beside every
    // declarative kind, the list `POST /compose` returns. Uncompiled here (see
    // the docblock) and compiled once by `resolve_scenario` after every step's
    // array is marked for #1498's `timer.pacing`; every executor reuses that
    // list.
    raw_elements_out    = payload.value ("elements", nlohmann::json::array ());
    step.stored_url     = row.url;
    step.spec_operation = row.spec_operation.value_or (std::string ());
    step.data_template  = std::move (data_template);
    step.collection_id  = row.collection_id;
    // A deferred step has a row behind it whenever it needs one: the refusal
    // above returns for a credential carrying a *data* token in a run with no
    // set. Not for one carrying only the `{{$vu}}` / `{{$iteration}}` identity
    // (#1055), deliberately, which is why `first_data_token` scans there rather
    // than the whole template: the identity binds off the iteration, so such a
    // step runs with no rows and must not be refused.
    if (auth_resolution == vayu::http::AuthResolution::Defer) {
        step.auth               = parsed_auth;
        step.auth_template      = std::move (auth_template);
        step.auth_after_scripts = auth_after_scripts;
    } else if (const auto* oauth2 = std::get_if<vayu::http::OAuth2Auth> (&parsed_auth)) {
        step.oauth2_config = oauth2->config;
    }
    plan.steps.push_back (std::move (step));
    return std::nullopt;
}

/**
 * Stamps `config._scopeEntry` onto every element, across every step, whose kind
 * the registry marks `tracks_scope_occurrence` (#1498's `timer.pacing` is the
 * only one): `true` on the first occurrence of its id in plan order, `false` on
 * every later one, since a folder- or collection-scoped element
 * compose_elements inherits into several steps starts *that node* only at the
 * first.
 *
 * A registry lookup, never a `kind ==` comparison (the extensibility contract's
 * rule 1), so a future kind opts in through the same field with no change here.
 */
void mark_scope_entries (std::vector<nlohmann::json>& raw_elements_per_step) {
    std::unordered_map<std::string, size_t> first_seen_at_step;
    for (size_t index = 0; index < raw_elements_per_step.size (); ++index) {
        for (const auto& entry : raw_elements_per_step[index]) {
            if (!entry.is_object () || !entry.contains ("id")) {
                continue;
            }
            const auto* kind = vayu::core::Registry::instance ().find (
            entry.value ("kind", std::string{}));
            if (kind == nullptr || !kind->tracks_scope_occurrence) {
                continue;
            }
            first_seen_at_step.try_emplace (entry["id"].get<std::string> (), index);
        }
    }

    for (size_t index = 0; index < raw_elements_per_step.size (); ++index) {
        for (auto& entry : raw_elements_per_step[index]) {
            if (!entry.is_object () || !entry.contains ("id") || !entry.contains ("config")) {
                continue;
            }
            const auto found = first_seen_at_step.find (entry["id"].get<std::string> ());
            if (found == first_seen_at_step.end ()) {
                continue; // Not a scope-tracked kind.
            }
            entry["config"]["_scopeEntry"] = found->second == index;
        }
    }
}

} // namespace

std::optional<std::string> refuse_overdeep_cell (const nlohmann::json& row,
std::string_view field,
std::optional<size_t> row_index) {
    if (!row.is_object ()) {
        return std::nullopt;
    }
    constexpr size_t max_depth = constants::spec_document::MAX_READ_DEPTH;
    for (const auto& [column, cell] : row.items ()) {
        if (!vayu::json::exceeds_depth (cell, max_depth)) {
            continue;
        }
        std::string where = "'" + std::string (field) + "'";
        if (row_index) {
            where += " row " + std::to_string (*row_index);
        }
        where += " column '";
        where += column;
        where += "' is nested deeper than " + std::to_string (max_depth) + " levels";
        return where;
    }
    return std::nullopt;
}

std::optional<std::string>
refuse_overdeep_data (const nlohmann::json& data, std::string_view field) {
    constexpr size_t max_depth = constants::spec_document::MAX_READ_DEPTH;
    const std::string where    = "'" + std::string (field) + "'";
    const std::string bound =
    " is nested deeper than " + std::to_string (max_depth) + " levels";
    if (!data.is_array ()) {
        if (vayu::json::exceeds_depth (data, max_depth)) {
            return where + bound;
        }
        return std::nullopt;
    }
    for (size_t i = 0; i < data.size (); ++i) {
        // A row that is not an object is read_data_rows' to refuse, but only
        // once it is shallow enough to be dumped.
        if (!data[i].is_object ()) {
            if (vayu::json::exceeds_depth (data[i], max_depth)) {
                std::string refusal = where + " row ";
                refusal += std::to_string (i);
                refusal += bound;
                return refusal;
            }
            continue;
        }
        if (auto refusal = refuse_overdeep_cell (data[i], field, i)) {
            return refusal;
        }
    }
    return std::nullopt;
}

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
    // Accumulated row by row, not by dumping the array: an oversized set is
    // refused once it crosses the bound, never materializing a second copy of a
    // payload already too big.
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
        // Ahead of the dump and the copy below, both of which recurse.
        if (auto refusal = refuse_overdeep_cell (data[i], field, i)) {
            rows_out.clear ();
            return refusal;
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

namespace {

constexpr std::string_view DATA_FILE_CAST_NUMBERS_KEY = "dataFileCastNumbers";

/// The refusal for a data-file key sent on a run that carries no rows.
std::string sent_without_data (const std::string& name, std::string_view prefix) {
    return name + " describes the file '" + std::string (prefix) +
    "data' came from, and was sent without it - send the rows beside it, "
    "or drop the field.";
}

/// One of the two data-file string keys as a non-empty string, or the
/// refusal. Absent or `null` leaves @p out empty.
std::optional<std::string> read_data_file_string (const nlohmann::json& block,
std::string_view prefix,
const std::string& key,
bool has_data,
std::string& out) {
    const auto field = block.find (key);
    if (field == block.end () || field->is_null ()) {
        return std::nullopt;
    }
    const std::string name = "'" + std::string (prefix) + key + "'";
    if (!field->is_string () || field->get_ref<const std::string&> ().empty ()) {
        return name + " must be a non-empty string (got " +
        (field->is_string () ? std::string ("an empty one") :
                               std::string (field->type_name ())) +
        ")";
    }
    if (!has_data) {
        return sent_without_data (name, prefix);
    }
    out = field->get<std::string> ();
    return std::nullopt;
}

/// `dataFileCastNumbers` as a boolean, or the refusal, on the string keys'
/// rules: absent or `null` leaves @p out false, and any value without rows is
/// refused, `false` included.
std::optional<std::string> read_data_file_cast (const nlohmann::json& block,
std::string_view prefix,
bool has_data,
bool& out) {
    const auto field = block.find (DATA_FILE_CAST_NUMBERS_KEY);
    if (field == block.end () || field->is_null ()) {
        return std::nullopt;
    }
    const std::string name =
    "'" + std::string (prefix) + std::string (DATA_FILE_CAST_NUMBERS_KEY) + "'";
    if (!field->is_boolean ()) {
        return name + " must be a boolean (got " + std::string (field->type_name ()) + ")";
    }
    if (!has_data) {
        return sent_without_data (name, prefix);
    }
    out = field->get<bool> ();
    return std::nullopt;
}

} // namespace

std::optional<std::string> read_data_file_fields (const nlohmann::json& block,
std::string_view prefix,
bool has_data,
DataFileProvenance& out) {
    if (auto reason =
        read_data_file_string (block, prefix, "dataFileName", has_data, out.name)) {
        return reason;
    }
    if (auto reason =
        read_data_file_string (block, prefix, "dataFileHash", has_data, out.hash)) {
        return reason;
    }
    if (auto reason = read_data_file_cast (block, prefix, has_data, out.cast_numbers)) {
        return reason;
    }
    // A display name, never a path: the engine opens nothing, and a path here
    // would be stored and listed back to every reader of the run.
    if (out.name.find_first_of ("/\\") != std::string::npos) {
        return "'" + std::string (prefix) +
        "dataFileName' is the file's name, never a path: send the name alone "
        "(got one containing a path separator)";
    }
    if (!out.hash.empty () && !vayu::utils::is_sha256_hex (out.hash)) {
        return "'" + std::string (prefix) +
        "dataFileHash' must be the SHA-256 of the file's bytes as 64 "
        "lowercase hex characters";
    }
    return std::nullopt;
}

void stamp_data_file_fields (nlohmann::json& snapshot, const DataFileProvenance& file) {
    if (!file.name.empty ()) {
        snapshot["dataFileName"] = file.name;
    }
    if (!file.hash.empty ()) {
        snapshot["dataFileHash"] = file.hash;
    }
    if (file.cast_numbers) {
        snapshot[DATA_FILE_CAST_NUMBERS_KEY] = true;
    } else {
        snapshot.erase (DATA_FILE_CAST_NUMBERS_KEY);
    }
}

std::optional<std::string> plan_request_files (vayu::http::FilePlan& files,
vayu::Request& request,
const std::vector<nlohmann::json>& rows,
const std::function<DataBindResult (vayu::Request&, size_t row)>& bind) {
    if (!vayu::http::has_file_refs (request.body)) {
        return std::nullopt;
    }
    if (rows.empty () || !vayu::http::has_templated_file_path (request.body)) {
        return files.prepare (request, vayu::http::OpenFiles::KeptByPlan);
    }
    for (size_t row = 0; row < rows.size (); ++row) {
        vayu::Request bound = request;
        if (!bind (bound, row).ok) {
            continue;
        }
        if (auto refusal = files.prepare (bound)) {
            return "data row " + std::to_string (row) + ": " + *refusal;
        }
    }
    return std::nullopt;
}

DataBindResult fill_bound_files (const vayu::http::FilePlan* files,
const vayu::Request& tmpl,
vayu::Request& request) {
    if (files == nullptr || !vayu::http::has_templated_file_path (tmpl.body)) {
        return DataBindResult{ true, {} };
    }
    if (auto refusal = files->fill (request)) {
        return DataBindResult{ false, std::move (*refusal) };
    }
    return DataBindResult{ true, {} };
}

namespace {

/// Every step's files, through one plan over the stored allowed folders.
std::optional<std::string>
plan_step_files (vayu::db::Database& db, ScenarioResolution& resolution) {
    const bool names_a_file = std::any_of (resolution.plan.steps.begin (),
    resolution.plan.steps.end (), [] (const ScenarioStep& step) {
        return vayu::http::has_file_refs (step.request.body);
    });
    if (!names_a_file) {
        return std::nullopt;
    }
    auto files = std::make_shared<vayu::http::FilePlan> (
    vayu::http::FileAccessPolicy::from_database (db));
    for (auto& step : resolution.plan.steps) {
        auto refusal = plan_request_files (*files, step.request,
        resolution.data_rows, [&] (vayu::Request& bound, size_t row) {
            // Checking a file sends nothing, so auth held for the scripts is
            // never applied here.
            std::optional<vayu::http::Auth> unapplied;
            return bind_step_iteration (bound, step, resolution.data_rows, row,
            IterationIdentity{}, unapplied);
        });
        if (refusal) {
            return "Step " + std::to_string (step.index + 1) + " ('" +
            step.name + "'): " + *refusal;
        }
    }
    resolution.files = std::move (files);
    return std::nullopt;
}

} // namespace

ScenarioResolution resolve_scenario (vayu::db::Database& db,
const nlohmann::json& scenario,
const ScenarioResolveOptions& options) {
    ScenarioResolution resolution;
    if (auto reason = parse_scenario_request (
        scenario, options.limits, resolution.request, resolution.data_rows)) {
        return invalid (*reason);
    }
    const ScenarioRequest& request = resolution.request;

    // Kept, not just probed: the collection carries the declared data contract
    // the no-data refusal below reads.
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

    // A present, empty `data` array was refused above, so empty `data_rows`
    // means no `data` block, and an empty column set is exactly "this run binds
    // no rows", what every step below composes and splits against (#1007).
    const bool has_data = !resolution.data_rows.empty ();
    const vayu::http::BoundColumnNames bound_columns =
    bound_columns_of (resolution.data_rows);

    // One answer for the whole plan, decided before any step composes: the
    // plan's structure is fixed here, and only values wait for the send.
    const auto deferral = plan_variable_deferral (db, rows);
    resolution.plan.steps.reserve (rows.size ());
    std::vector<nlohmann::json> raw_elements (rows.size ());
    for (size_t index = 0; index < rows.size (); ++index) {
        if (auto refusal = resolve_step (db, options, deferral, *collection, has_data,
            bound_columns, index, rows[index], resolution.plan, raw_elements[index])) {
            return invalid (std::move (refusal->reason), std::move (refusal->code));
        }
    }
    mark_scope_entries (raw_elements);
    for (size_t index = 0; index < raw_elements.size (); ++index) {
        resolution.plan.steps[index].elements =
        std::make_shared<const std::vector<vayu::core::CompiledElement>> (
        vayu::core::compile_elements (raw_elements[index]));
    }

    if (auto reason = plan_step_files (db, resolution)) {
        return invalid (*reason);
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

namespace {

/// Whether @p element runs at a run's own boundary rather than at a step.
bool runs_at_run_boundary (const CompiledElement& element) {
    return element.element &&
    (element.element->phase () == Phase::RunStart ||
    element.element->phase () == Phase::RunEnd);
}

/// @p collection's `run.start` / `run.end` elements, stamped as @p is_root
/// says, onto @p out; nothing when it declares neither.
void append_lifecycle_collection (std::vector<LifecycleCollection>& out,
const vayu::db::Collection& collection,
bool is_root) {
    auto elements = nlohmann::json::parse (collection.elements, nullptr, false);
    if (!elements.is_array ()) {
        return;
    }
    const auto origin = vayu::http::collection_element_origin (collection, is_root);
    for (auto& element : elements) {
        if (element.is_object ()) {
            element["origin"] = origin;
        }
    }
    auto compiled = compile_elements (elements);
    std::erase_if (compiled, [] (const CompiledElement& element) {
        return !runs_at_run_boundary (element);
    });
    if (!compiled.empty ()) {
        out.push_back ({ collection.id, std::move (compiled) });
    }
}

/// Positions in @p collections of every folder beneath @p root_id, depth-first
/// in the order @p collections lists siblings, a parent before its own
/// sub-folders. @p visited holds what is already placed and gains each folder
/// reached, so a `parent_id` cycle ends.
std::vector<size_t> folders_beneath (const std::vector<vayu::db::Collection>& collections,
const std::string& root_id,
std::unordered_set<std::string>& visited) {
    std::unordered_map<std::string, std::vector<size_t>> children_of;
    for (size_t i = 0; i < collections.size (); ++i) {
        if (const auto& parent = collections[i].parent_id; parent && !parent->empty ()) {
            children_of[*parent].push_back (i);
        }
    }
    std::vector<size_t> stack;
    const auto push_children = [&] (const std::string& parent_id) {
        if (const auto found = children_of.find (parent_id);
        found != children_of.end ()) {
            stack.insert (stack.end (), found->second.rbegin (), found->second.rend ());
        }
    };
    std::vector<size_t> ordered;
    push_children (root_id);
    while (!stack.empty ()) {
        const size_t index = stack.back ();
        stack.pop_back ();
        const auto& id = collections.at (index).id;
        if (!visited.insert (id).second) {
            continue;
        }
        ordered.push_back (index);
        push_children (id);
    }
    return ordered;
}

} // namespace

std::vector<LifecycleCollection> resolve_lifecycle_collections (vayu::db::Database& db,
const std::string& run_collection_id,
bool recursive) {
    std::vector<LifecycleCollection> lifecycle;
    const auto chain = vayu::http::collection_chain (db, run_collection_id);
    std::unordered_set<std::string> visited;
    for (size_t i = 0; i < chain.size (); ++i) {
        visited.insert (chain[i].id);
        append_lifecycle_collection (lifecycle, chain[i], i == 0);
    }
    if (!recursive || chain.empty ()) {
        return lifecycle;
    }
    // Live rows only, each parent's sub-folders in sibling order.
    const auto collections = db.get_collections ();
    for (const size_t index : folders_beneath (collections, run_collection_id, visited)) {
        append_lifecycle_collection (lifecycle, collections.at (index), false);
    }
    return lifecycle;
}

DataBindResult bind_step_iteration (vayu::Request& request,
const ScenarioStep& step,
const std::vector<nlohmann::json>& rows,
std::optional<size_t> row_index,
IterationIdentity identity,
std::optional<vayu::http::Auth>& late_auth) {
    // `.at()` rather than a subscript: the index was claimed off a cursor taken
    // modulo this vector's own size, so a mismatch is a broken invariant and a
    // throw names it instead of reading past the end.
    const IterationBinding binding{ row_index ? &rows.at (*row_index) : nullptr,
        row_index.value_or (0), identity };
    // The fields-then-credentials order lives in `bind_iteration`, shared with
    // the single-request load path (#993); this is its step-shaped caller. The
    // step's auth is copied, by the callee or into @p late_auth, as a plan
    // shared by every virtual user requires.
    if (!step.auth_after_scripts) {
        return bind_iteration (
        request, step.data_template, step.auth, step.auth_template, binding);
    }
    auto& auth = late_auth.emplace (step.auth);
    return bind_iteration_holding_auth (
    request, step.data_template, auth, step.auth_template, binding);
}

nlohmann::json build_scenario_manifest (const ScenarioRequest& request,
const ScenarioPlan& plan,
const SpecBinding& spec) {
    nlohmann::json steps = nlohmann::json::array ();
    for (const auto& step : plan.steps) {
        nlohmann::json entry{ { "index", step.index }, { "requestId", step.request_id },
            { "name", step.name }, { "method", to_string (step.request.method) },
            { "url", step.stored_url } };
        // The file a binary step sends, as checked when the plan resolved:
        // name, size and digest, never the bytes or the path. A path a data
        // row binds names a different file per row, so it has no one entry.
        if (!vayu::http::has_templated_file_path (step.request.body)) {
            if (auto file = vayu::http::routes::body_file_node (step.request)) {
                entry["bodyFile"] = std::move (*file);
            }
        }
        steps.push_back (std::move (entry));
    }

    nlohmann::json manifest{ { "source", request.source },
        { "collectionId", request.collection_id },
        { "recursive", request.recursive }, { "iterations", request.iterations },
        { "dataRowCount", request.data_row_count }, { "steps", std::move (steps) } };
    stamp_data_file_fields (manifest, request.data_file);
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

bool step_has_script (const ScenarioStep& step, std::string_view kind) {
    if (!step.elements) {
        return false;
    }
    // A blank script.pre/post is inert (#1609): it carries no behaviour, so a
    // step whose only match is blank does not count as carrying one.
    return std::any_of (step.elements->begin (), step.elements->end (),
    [&] (const CompiledElement& element) {
        return element.kind == kind &&
        !is_blank_script_element (element.kind, element.config);
    });
}

std::optional<vayu::StreamBounds> longest_stream_bounds (const ScenarioPlan& plan) {
    std::optional<vayu::StreamBounds> longest;
    for (const auto& step : plan.steps) {
        const auto& bounds = step.request.stream_bounds;
        if (bounds && (!longest || bounds->max_duration_ms > longest->max_duration_ms)) {
            longest = bounds;
        }
    }
    return longest;
}

bool step_has_deferred_script (const ScenarioStep& step,
std::string_view kind,
ScriptsOverrideMode scripts_mode) {
    if (!step.elements) {
        return false;
    }
    return std::any_of (step.elements->begin (), step.elements->end (),
    [&] (const CompiledElement& element) {
        return element.kind == kind && element.enabled &&
        !is_blank_script_element (element.kind, element.config) &&
        !RunContext::script_element_runs_inline (element.config, scripts_mode);
    });
}

std::unordered_map<std::string, vayu::core::ElementSpan> compute_element_spans (
const ScenarioPlan& plan) {
    std::unordered_map<std::string, ElementSpan> spans;
    const auto& registry = Registry::instance ();
    for (size_t position = 0; position < plan.steps.size (); ++position) {
        const auto& step = plan.steps[position];
        if (!step.elements) {
            continue;
        }
        for (const auto& element : *step.elements) {
            // Read through the registry's own `needs_span`, never a `kind ==`
            // comparison outside `core/elements` (#1512's extensibility
            // contract, rule 1).
            const auto* kind = registry.find (element.kind);
            if (kind == nullptr || !kind->needs_span) {
                continue;
            }
            auto [it, inserted] = spans.try_emplace (element.id, ElementSpan{});
            if (inserted) {
                it->second.first           = position;
                it->second.last            = position;
                it->second.first_step_name = step.name;
            } else {
                it->second.last = position;
            }
        }
    }
    return spans;
}

} // namespace vayu::core
