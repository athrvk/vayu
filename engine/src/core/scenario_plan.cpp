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
#include "vayu/http/target_policy.hpp"
#include "vayu/utils/json.hpp"

namespace vayu::core {

namespace {

ScenarioResolution invalid (std::string reason, std::string code = {}) {
    ScenarioResolution resolution;
    resolution.ok         = false;
    resolution.error      = std::move (reason);
    resolution.error_code = std::move (code);
    return resolution;
}

/// Why one step cannot be planned, and the code when the refusal has its own
/// (a target policy's, #2521). A bare reason converts, so a refusal with no
/// code is written as it always was.
struct StepRefusal {
    std::string reason;
    std::string code;

    StepRefusal (std::string text, std::string refusal_code = {})
    : reason (std::move (text)), code (std::move (refusal_code)) {
    }
};

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
 * for the cost of the row reads rather than after composing every step. A
 * recursive run walks the subtree in the order the sidebar shows it, each
 * sub-folder's subtree where the sub-folder sits among its parent's requests
 * (#431, #2535; `Database::get_requests_in_subtree`).
 */
std::vector<vayu::db::Request>
collect_requests (vayu::db::Database& db, const std::string& root_id, bool recursive) {
    return recursive ? db.get_requests_in_subtree (root_id) :
                       db.get_requests_in_collection (root_id);
}

/**
 * The `data` rows a *scenario* binds, through the shared reader below.
 *
 * They reach the run's worker (as `pm.iterationData`) but never the plan or the
 * snapshot - the app owns parsing the file they came from, and only their count
 * (beside the file's name and hash) is persisted. A rejected set leaves no rows
 * behind, never the ones before the bad one, which would be a partial data set.
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

    // Refused rather than ignored (issue #1503): a key this block does not
    // read - a typo, or a knob from a version of the client ahead of this
    // engine - used to change nothing and answer 202 anyway, which is a
    // silence every future scenario field would inherit. The refusal lists
    // this set by hand, so the two change together.
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
 * How every step of the plan over @p rows composes its scope names (#2521).
 *
 * `Always` when one step's composed `elements` hold a kind the registry marks
 * `writes_variables` (`script.pre`, `script.post`, `script.setup`, every
 * `extract.*`) at a phase before some send: an earlier step's test script or
 * extractor can then set the token a later step reads, after the plan was
 * composed and before that step is sent. `script.teardown` alone does not
 * count, because it runs after the last send. The lists are composition's
 * own, so a disabled, blank or `inherit.disable`d element is already gone.
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
 * One step of the plan: composed, built, and refused if it carries a token
 * nothing in this run could bind.
 *
 * @return the reason this scenario cannot run, or nothing.
 *
 * @param raw_elements_out This step's resolved `elements` array exactly as
 *        `POST /compose` returned it, uncompiled. Issue #1498's
 *        `timer.pacing` needs a second pass over every step's array before
 *        any of them can be compiled - it marks, per element id across the
 *        *whole* iteration, which single occurrence is that node's actual
 *        start - so compiling here (as every kind before `timer.pacing`
 *        could) would compile a pacing element before it knew whether this
 *        was its node's first occurrence. `resolve_scenario` compiles every
 *        step's array only after that pass, from this output.
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
    // The dataset's columns travel into composition rather than being applied
    // after it (issue #1007): a bare `{{username}}` this run's rows answer must
    // survive composition to be bound per iteration, and a same-named
    // environment variable must not answer it first. Names only - the row is
    // per iteration and composition happens once.
    if (!bound_columns.empty ()) {
        compose_body["dataColumns"] = bound_columns;
    }
    // A plan step is composed once and *sent* per iteration, so the generator
    // family belongs to the send rather than to this composition (issue #995):
    // resolved here, `{{$randomUUID}}` would be one id repeated by every
    // iteration of every virtual user. Unconditionally, not only for a load
    // run - both executors join this step's template before every send, and a
    // rule that depended on which one was running is one nobody could hold in
    // their head. A step spelling no generator is unaffected: nothing survives
    // composition, so nothing is split and nothing is joined.
    compose_body["deferDynamicVariables"] = true;
    auto [status, payload] = vayu::http::compose_request_core (db, compose_body,
    options.oauth2_after_scripts ? vayu::http::OAuth2Resolution::AfterTheScript :
                                   vayu::http::OAuth2Resolution::AtComposition,
    deferral);
    if (status != 200) {
        return ("Cannot compose " + describe_step (index, row) + ": " +
        compose_error_message (payload));
    }

    // Auth is resolved into headers/url here, which is what makes the plan
    // credential-grade and the snapshot manifest necessary - unless the
    // credentials themselves come from the data file or wait on a script
    // (below). `apply_auth` collapses basic auth into one base64
    // `Authorization` value, so a `{{data.user}}` resolved into the plan is
    // unreadable by the time
    // anything scans the built request: it used to go out as base64 of the
    // literal token text, silently, and the refusal below could not see it
    // either (issue #591). Such a step keeps its credentials typed and
    // unbound and applies its auth per iteration instead - one base64 per
    // iteration, and only for the steps that need it.
    const vayu::http::Auth parsed_auth =
    vayu::http::parse_auth (payload.value ("auth", nlohmann::json ()));
    StepDataTemplate auth_template = tokenize_auth_fields (parsed_auth, bound_columns);

    // OAuth 2.0 is the one mode the row bind cannot serve: its token is
    // acquired against the token endpoint - here, once, for a load run, or at
    // each sequential step's send - never bound per iteration, and a bind per
    // virtual user per iteration would be a network round trip each. Refused
    // by name in both directions, with or without a data set, rather than sent
    // to the token endpoint as the literal token text.
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

    // A name composition found no scope for is one a pre-request script, an
    // inline element or a setup script may define before the send, and none
    // of them can reach it once `apply_auth` has encoded it (issue #2473). So
    // is any name composition deferred (#2521), OAuth 2.0 config included on
    // a sequential plan.
    const bool auth_after_scripts =
    vayu::core::credentials_await_scripts (parsed_auth, bound_columns);

    // Deferred through the builder's own option rather than by hiding the
    // `auth` key from it: one mechanism, named at the call site, shared
    // with the single send that defers for the same reason (issue #642).
    const auto auth_resolution = auth_template.empty () && !auth_after_scripts ?
    vayu::http::AuthResolution::Apply :
    vayu::http::AuthResolution::Defer;

    auto built = vayu::http::build_request (
    payload, &db, options.timeout_ms, auth_resolution, options.target_policy);
    if (!built.ok || built.parse_failed) {
        return StepRefusal{ "Cannot compose " + describe_step (index, row) +
            ": " + built.error_message,
            vayu::http::is_target_refusal_code (built.detail_code) ? built.detail_code : "" };
    }

    // Split once, here, so no executor re-scans this step per iteration -
    // the load-mode one binds a row per iteration per virtual user, which
    // is a scan of every field of every step at the run's full rate.
    auto data_template = tokenize_bindable_fields (built.request, bound_columns);

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
    step.index      = index;
    step.request_id = row.id;
    step.name       = row.name;
    step.request    = std::move (built.request);
    // The only script source since issue #1514's cut-over: `elements`
    // resolved the collection chain's and the request's own script.pre /
    // script.post entries beside every declarative kind, the same list
    // `POST /compose` returns. Left uncompiled here - see this function's
    // doc comment - and compiled once by `resolve_scenario` after every
    // step's array has been marked for #1498's `timer.pacing`; every
    // executor then reuses that one compiled list.
    raw_elements_out    = payload.value ("elements", nlohmann::json::array ());
    step.stored_url     = row.url;
    step.spec_operation = row.spec_operation.value_or (std::string ());
    step.data_template  = std::move (data_template);
    // A deferred step reaches an executor with a row behind it whenever it
    // needs one: the refusal above returns for a credential carrying a *data*
    // token in a run with no set. It does not for one carrying only the
    // `{{$vu}}` / `{{$iteration}}` identity (issue #1055), which is deliberate
    // and is why `first_data_token` is the scan there rather than the whole
    // template - the identity binds off the iteration, so that step is
    // perfectly runnable with no rows at all and must not be refused.
    if (auth_resolution == vayu::http::AuthResolution::Defer) {
        step.auth               = parsed_auth;
        step.auth_template      = std::move (auth_template);
        step.auth_after_scripts = auth_after_scripts;
    }
    plan.steps.push_back (std::move (step));
    return std::nullopt;
}

/**
 * Stamps `config._scopeEntry` onto every element, across every step, whose
 * kind the registry marks `tracks_scope_occurrence` (issue #1498's
 * `timer.pacing` only, today): `true` on the first occurrence of that
 * element's id in plan order, `false` on every later one - the folder- or
 * collection-scoped element compose_elements inherits into more than one
 * step is only ever *that node's own start* at the first of them.
 *
 * A registry lookup, never a `kind ==` comparison (the extensibility
 * contract's rule 1): a future kind that needs the same tracking opts in
 * through the same registry field, with no change here.
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

/// A SHA-256 digest as 64 lowercase hex characters. Lowercase only, so one
/// file's digest has exactly one spelling and two runs compare as strings.
bool is_sha256_hex (std::string_view text) {
    constexpr size_t SHA256_HEX_LENGTH = 64;
    return text.size () == SHA256_HEX_LENGTH &&
    std::all_of (text.begin (), text.end (),
    [] (char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

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
    if (!out.hash.empty () && !is_sha256_hex (out.hash)) {
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
    // empty `data_rows` here means the payload carried no `data` block at all -
    // and so an empty column set is exactly "this run binds no rows", which is
    // what every step below composes and splits against (issue #1007).
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
    // The fields-then-credentials order lives in one place, shared with the
    // single-request load path that binds its own templates the same way
    // (issue #993); this is the step-shaped caller of it. The step's auth is
    // copied, by the callee or into @p late_auth, which is what a plan shared
    // by every virtual user of the run requires.
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
