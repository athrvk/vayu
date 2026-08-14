/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

#include "vayu/core/scenario_plan.hpp"

#include <cmath>
#include <limits>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include "vayu/core/scenario_data.hpp"
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
    if (!schema.is_object () || !schema.contains ("columns") || !schema["columns"].is_array ()) {
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
    enum class Step { Descend, Emit };
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
        if (!data->is_array ()) {
            return "'scenario.data' must be an array of objects (got " +
            std::string (data->type_name ()) + ")";
        }
        if (data->empty ()) {
            return "'scenario.data' is present but empty. A data set that "
                   "binds "
                   "nothing is a mistake, not an empty run - omit the field to "
                   "run without one.";
        }
        if (data->size () > limits.max_data_rows) {
            return "'scenario.data' has " + std::to_string (data->size ()) +
            " rows, over the limit of " + std::to_string (limits.max_data_rows) +
            " (raise the 'maxScenarioDataRows' setting to allow more)";
        }
        rows_out.reserve (data->size ());
        // Accumulated row by row rather than dumping the whole array: an
        // oversized set is refused as soon as it crosses the bound, so the
        // check never materializes a second copy of a payload that is already
        // too big to want one.
        size_t data_bytes = 0;
        for (size_t i = 0; i < data->size (); ++i) {
            if (!(*data)[i].is_object ()) {
                // A rejected set leaves no rows behind - never the ones before
                // the bad one, which would be a partial data set.
                rows_out.clear ();
                return "'scenario.data' row " + std::to_string (i) +
                " must be an object of name/value pairs (got " +
                std::string ((*data)[i].type_name ()) + ")";
            }
            data_bytes += (*data)[i].dump ().size ();
            if (data_bytes > limits.max_data_bytes) {
                rows_out.clear ();
                return "'scenario.data' is larger than the limit of " +
                std::to_string (limits.max_data_bytes) +
                " bytes (raise the 'maxScenarioDataBytes' setting to allow "
                "more). The row count is within its own limit - a data set can "
                "exceed this one with few but large rows.";
            }
            rows_out.push_back ((*data)[i]);
        }
        has_data           = true;
        out.data_row_count = data->size ();
    }

    // An explicit count wins and the row index wraps; absent, a data set sets
    // it to its row count (Postman's default) and everything else runs once.
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
        const auto& row = rows[index];

        // The by-id compose path: the same resolution a Send of this request
        // performs, so a step's request and scripts cannot drift from it.
        nlohmann::json compose_body{ { "requestId", row.id } };
        if (!options.environment_id.empty ()) {
            compose_body["environmentId"] = options.environment_id;
        }
        auto [status, payload] = vayu::http::compose_request_core (db, compose_body);
        if (status != 200) {
            return invalid ("Cannot compose " + describe_step (index, row) +
            ": " + compose_error_message (payload));
        }

        // Auth is resolved into headers/url here, which is what makes the plan
        // credential-grade and the snapshot manifest necessary.
        auto built = vayu::http::build_request (payload, &db, options.timeout_ms);
        if (!built.ok || built.parse_failed) {
            return invalid ("Cannot compose " + describe_step (index, row) +
            ": " + built.error_message);
        }

        // Split once, here, so no executor re-scans this step per iteration -
        // the load-mode one binds a row per iteration per virtual user, which
        // is a scan of every field of every step at the run's full rate.
        auto data_template = tokenize_data_fields (built.request);

        // A `{{data.*}}` token with no data set behind it can never bind. The
        // namespace is reserved, so composition deliberately left the token
        // written as it stands, and a run without rows has nothing to
        // substitute it from - it would reach the wire as the literal text
        // `{{data.id}}`, which is not a request anyone meant to send. Refused
        // here, beside every other unrunnable scenario and before a run row
        // exists, rather than rediscovered per step per iteration once it has
        // started (issue #415).
        if (!has_data) {
            if (auto token = data_template.first_token ()) {
                return invalid (describe_step (index, row) + " carries " + *token +
                ", but this run has no 'scenario.data' set. A data token has "
                "no row to bind to and would reach the wire written as it "
                "stands - run the collection with a data file, or remove the "
                "token from the request." + declared_columns_hint (*collection));
            }
        }

        ScenarioStep step;
        step.index         = index;
        step.request_id    = row.id;
        step.name          = row.name;
        step.request       = std::move (built.request);
        step.pre_script    = vayu::http::read_pre_request_script (payload);
        step.post_script   = vayu::http::read_post_request_script (payload);
        step.stored_url    = row.url;
        step.data_template = std::move (data_template);
        resolution.plan.steps.push_back (std::move (step));
    }

    resolution.ok = true;
    return resolution;
}

nlohmann::json build_scenario_manifest (const ScenarioRequest& request,
const ScenarioPlan& plan) {
    nlohmann::json steps = nlohmann::json::array ();
    for (const auto& step : plan.steps) {
        steps.push_back ({ { "index", step.index }, { "requestId", step.request_id },
        { "name", step.name }, { "method", to_string (step.request.method) },
        { "url", step.stored_url } });
    }

    return nlohmann::json{ { "source", request.source },
        { "collectionId", request.collection_id },
        { "recursive", request.recursive }, { "iterations", request.iterations },
        { "dataRowCount", request.data_row_count }, { "steps", std::move (steps) } };
}

} // namespace vayu::core
