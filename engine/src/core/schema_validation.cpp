/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/schema_validation.cpp
 * @brief Implementation of response schema validation (issue #628). See the
 *        header for the storage shape and the dialect-honesty rule.
 */

#include "vayu/core/schema_validation.hpp"

#include "vayu/core/constants.hpp"
#include "vayu/core/spec_coverage.hpp"
#include "vayu/utils/logger.hpp"

#include <algorithm>
#include <cctype>
#include <map>
#include <valijson/adapters/nlohmann_json_adapter.hpp>
#include <valijson/schema.hpp>
#include <valijson/schema_parser.hpp>
#include <valijson/validator.hpp>
#include <unordered_set>
#include <utility>

namespace vayu::core {

namespace {

namespace limits = vayu::core::constants::schema_validation;

std::string lower (std::string value) {
    std::transform (value.begin (), value.end (), value.begin (),
    [] (unsigned char c) { return static_cast<char> (std::tolower (c)); });
    return value;
}

std::string upper (std::string value) {
    std::transform (value.begin (), value.end (), value.begin (),
    [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
    return value;
}

std::string trim (const std::string& value) {
    const auto first = value.find_first_not_of (" \t");
    if (first == std::string::npos) {
        return {};
    }
    const auto last = value.find_last_not_of (" \t");
    return value.substr (first, last - first + 1);
}

/**
 * The media type of a `Content-Type` header - `application/json` out of
 * `application/json; charset=utf-8`.
 *
 * Lower-cased because media types are case-insensitive and the index stores
 * them lower-cased too, so the comparison is between two normalised forms
 * rather than one normalised and one as-typed.
 */
std::string media_type_of (const std::string& content_type) {
    return lower (trim (content_type.substr (0, content_type.find (';'))));
}

/// `METHOD path`, the second identity key - the spelling `OperationIndex` uses,
/// because both resolve the same stamped `spec_operation` text.
std::string method_path_key (const std::string& method, const std::string& path) {
    return upper (method) + " " + path;
}

/**
 * Keywords a draft-07 validator does not evaluate, and what each is from.
 *
 * The first group is JSON Schema 2019-09/2020-12 - what an OpenAPI **3.1**
 * document may legally use, and what this validator has never heard of. The
 * second is OpenAPI's own vocabulary: the app normalises `nullable` and
 * `discriminator` away when it extracts a 3.0 schema, so one arriving here is a
 * bug in that normalisation - and disclosing it is how the bug surfaces as a
 * named gap rather than as a body wrongly reported clean (or, for `nullable`,
 * wrongly reported broken).
 */
const std::unordered_set<std::string>& unevaluatable_keywords () {
    static const std::unordered_set<std::string> keywords = {
        // JSON Schema 2019-09 / 2020-12
        "unevaluatedProperties", "unevaluatedItems", "prefixItems",
        "dependentSchemas", "dependentRequired", "minContains", "maxContains",
        "$dynamicRef", "$dynamicAnchor", "$recursiveRef", "$recursiveAnchor",
        // OpenAPI's own, which should have been normalised app-side
        "nullable", "discriminator",
    };
    return keywords;
}

/// Where a schema keyword holds one subschema.
const std::vector<std::string>& subschema_keys () {
    static const std::vector<std::string> keys = { "not", "if", "then", "else",
        "contains", "additionalProperties", "propertyNames", "additionalItems",
        "unevaluatedItems", "unevaluatedProperties" };
    return keys;
}

/// Where a keyword holds a *map* of subschemas keyed by names that are data,
/// not keywords - walking these as if their keys were keywords is how a
/// property legitimately called "nullable" would be reported as a dialect gap.
const std::vector<std::string>& subschema_map_keys () {
    static const std::vector<std::string> keys = { "properties", "patternProperties",
        "definitions", "$defs", "dependentSchemas" };
    return keys;
}

/// Where a keyword holds a list of subschemas.
const std::vector<std::string>& subschema_list_keys () {
    static const std::vector<std::string> keys = { "allOf", "anyOf", "oneOf", "prefixItems" };
    return keys;
}

/// Resolve an in-document JSON Pointer (`#/components/schemas/Pet`) against the
/// merged validation root. Anything else - an external ref, a malformed pointer
/// - resolves to nothing, and the walk simply stops there rather than guessing.
const nlohmann::json* resolve_pointer (const nlohmann::json& root, const std::string& ref) {
    if (ref.empty () || ref.front () != '#') {
        return nullptr;
    }
    try {
        const nlohmann::json::json_pointer pointer (ref.substr (1));
        if (!root.contains (pointer)) {
            return nullptr;
        }
        return &root.at (pointer);
    } catch (const std::exception&) {
        return nullptr;
    }
}

/**
 * The validation root: the schema with the document's shared ref subtrees
 * merged in beside it, so `#/components/schemas/Pet` resolves.
 *
 * The schema's own keys win on a collision. A schema that itself declares a
 * `components` member is not a shape OpenAPI produces, and if one ever arrives
 * its own value is the one it meant.
 */
nlohmann::json validation_root (const nlohmann::json& schema, const nlohmann::json& ref_roots) {
    if (!schema.is_object () || !ref_roots.is_object () || ref_roots.empty ()) {
        return schema;
    }
    nlohmann::json root = ref_roots;
    for (const auto& [key, value] : schema.items ()) {
        root[key] = value;
    }
    return root;
}

/**
 * valijson reports a location as context segments - `<root>`, `["child"]`,
 * `[0]` - and a verdict reports a JSON Pointer, because that is what every
 * other path in this codebase is and what a reader can paste into a body
 * viewer. `<root>["child"]["name"]` becomes `/child/name`.
 */
std::string pointer_of_context (const std::vector<std::string>& context) {
    std::string pointer;
    for (const auto& segment : context) {
        if (segment == "<root>") {
            continue;
        }
        std::string name = segment;
        if (name.size () >= 2 && name.front () == '[' && name.back () == ']') {
            name = name.substr (1, name.size () - 2);
        }
        if (name.size () >= 2 && name.front () == '"' && name.back () == '"') {
            name = name.substr (1, name.size () - 2);
        }
        pointer += "/" + name;
    }
    return pointer;
}

/**
 * The prefix valijson gives its *structural* errors - the ones that say a
 * parent failed because a child did, once per level, alongside the leaf error
 * that actually names the problem.
 *
 * Dropping them is cosmetic and deliberately allowed to break: if an upstream
 * release rewords this, a verdict gains its wrapper lines back and reads
 * noisier. That is a different bargain from parsing a keyword out of a message
 * (which `SchemaFailure` refuses to do), because nothing here can become
 * *wrong* - and the fallback below keeps a body from ever being reported as
 * failing with nothing to show for it.
 */
constexpr const char* STRUCTURAL_ERROR_PREFIX = "Failed to validate against schema associated with";

} // namespace

std::string to_string (UncheckedReason reason) {
    switch (reason) {
    case UncheckedReason::NoOperation: return "no_operation";
    case UncheckedReason::NoIndex: return "no_index";
    case UncheckedReason::HashMismatch: return "hash_mismatch";
    case UncheckedReason::NeverStamped: return "never_stamped";
    case UncheckedReason::OperationNotDeclared: return "operation_not_declared";
    case UncheckedReason::NoSchemaForStatus: return "no_schema_for_status";
    case UncheckedReason::NoSchemaForContentType: return "no_schema_for_content_type";
    case UncheckedReason::NoResponse: return "no_response";
    case UncheckedReason::BodyNotJson: return "body_not_json";
    }
    return "no_index"; // unreachable; the enum is closed
}

nlohmann::json build_validation_payload (const ValidationVerdict& verdict) {
    nlohmann::json node;
    node["checked"] = verdict.checked;
    if (!verdict.checked) {
        // No `valid` key at all when nothing was checked: `valid: false` on an
        // unchecked response is the exact confusion this whole node exists to
        // avoid - a reader would show it as a contract failure.
        node["reason"] = verdict.reason ? to_string (*verdict.reason) :
                                          to_string (UncheckedReason::NoIndex);
        return node;
    }

    node["valid"] = verdict.valid;
    if (!verdict.matched_status.empty ()) {
        node["matchedStatus"] = verdict.matched_status;
    }
    if (!verdict.matched_content_type.empty ()) {
        node["matchedContentType"] = verdict.matched_content_type;
    }

    nlohmann::json failures = nlohmann::json::array ();
    for (const auto& failure : verdict.failures) {
        failures.push_back ({ { "path", failure.path }, { "message", failure.message } });
    }
    node["failures"] = failures;
    // Always present, even when nothing was dropped: a reader comparing
    // `failures.size()` against it needs the number to be there to compare.
    node["failuresTotal"] = verdict.failures_total;

    if (!verdict.unevaluated_keywords.empty ()) {
        nlohmann::json unevaluated = nlohmann::json::array ();
        for (const auto& [keyword, count] : verdict.unevaluated_keywords) {
            unevaluated.push_back ({ { "keyword", keyword }, { "count", count } });
        }
        node["unevaluatedKeywords"] = unevaluated;
    }
    return node;
}

void SampledValidationTotals::record (const ValidationVerdict& verdict,
const std::string& step,
int status) {
    ++sampled;

    if (!verdict.checked) {
        // Counted by reason rather than as a failure. A body a JSON Schema
        // cannot speak about is not a body that broke its contract, and folding
        // the two would make every HTML error page look like a schema failure.
        ++unchecked_reasons[to_string (verdict.reason.value_or (UncheckedReason::NoIndex))];
        return;
    }

    ++checked;
    if (verdict.valid) {
        ++valid;
    } else {
        ++failed;
    }

    if (!verdict.unevaluated_keywords.empty ()) {
        ++unevaluated;
        for (const auto& [keyword, count] : verdict.unevaluated_keywords) {
            unevaluated_keywords[keyword] += count;
        }
    }

    // The run-wide total counts every failure the verdicts found, including the
    // ones each verdict's own cap already hid - so the "shown of found" figure
    // is honest about both caps rather than only this one.
    failures_total += verdict.failures_total;
    for (const auto& failure : verdict.failures) {
        if (failure_examples.size () >= limits::MAX_FAILURES) {
            break;
        }
        failure_examples.push_back (
        FailureExample{ step, status, failure.path, failure.message });
    }
}

nlohmann::json build_sampled_validation_payload (const SampledValidationTotals& totals) {
    if (totals.sampled == 0) {
        return nlohmann::json::object ();
    }

    nlohmann::json node;
    // `sampled` first and always: it is the denominator that makes the rest
    // readable, and the one number that says these figures describe a sample.
    node["sampled"]     = totals.sampled;
    node["checked"]     = totals.checked;
    node["valid"]       = totals.valid;
    node["failed"]      = totals.failed;
    node["unevaluated"] = totals.unevaluated;

    if (!totals.unchecked_reasons.empty ()) {
        nlohmann::json reasons = nlohmann::json::object ();
        for (const auto& [reason, count] : totals.unchecked_reasons) {
            reasons[reason] = count;
        }
        node["uncheckedReasons"] = reasons;
    }

    if (!totals.unevaluated_keywords.empty ()) {
        nlohmann::json keywords = nlohmann::json::array ();
        for (const auto& [keyword, count] : totals.unevaluated_keywords) {
            keywords.push_back ({ { "keyword", keyword }, { "count", count } });
        }
        node["unevaluatedKeywords"] = keywords;
    }

    nlohmann::json failures = nlohmann::json::array ();
    for (const auto& example : totals.failure_examples) {
        nlohmann::json entry = { { "status", example.status },
            { "path", example.path }, { "message", example.message } };
        if (!example.step.empty ()) {
            entry["step"] = example.step;
        }
        failures.push_back (std::move (entry));
    }
    node["failures"] = failures;
    // Always present, like the per-response verdict's own: a reader comparing
    // the list's length against it needs the number to be there to compare.
    node["failuresTotal"] = totals.failures_total;
    return node;
}

std::vector<std::pair<std::string, size_t>>
collect_unevaluated_keywords (const nlohmann::json& schema, const nlohmann::json& ref_roots) {
    const nlohmann::json root = validation_root (schema, ref_roots);
    std::map<std::string, size_t> counts;
    std::unordered_set<std::string> visited_refs;

    // Iterative rather than recursive: a schema arrives from outside the
    // engine, and a deeply nested one must cost stack the process does not
    // have. The visited set covers `$ref` cycles; the node budget covers a
    // schema that is merely enormous.
    std::vector<const nlohmann::json*> pending = { &schema };
    size_t visited_nodes = 0;
    while (!pending.empty () && visited_nodes < limits::MAX_SCHEMA_NODES) {
        const nlohmann::json* node = pending.back ();
        pending.pop_back ();
        ++visited_nodes;
        if (!node->is_object ()) {
            continue;
        }

        for (const auto& [key, value] : node->items ()) {
            if (unevaluatable_keywords ().contains (key)) {
                ++counts[key];
            }
        }

        if (auto ref = node->find ("$ref"); ref != node->end () && ref->is_string ()) {
            const auto pointer = ref->get<std::string> ();
            if (visited_refs.insert (pointer).second) {
                if (const nlohmann::json* target = resolve_pointer (root, pointer)) {
                    pending.push_back (target);
                }
            }
        }
        for (const auto& key : subschema_keys ()) {
            if (auto found = node->find (key); found != node->end () && found->is_object ()) {
                pending.push_back (&*found);
            }
        }
        for (const auto& key : subschema_map_keys ()) {
            if (auto found = node->find (key); found != node->end () && found->is_object ()) {
                for (const auto& [_, child] : found->items ()) {
                    pending.push_back (&child);
                }
            }
        }
        for (const auto& key : subschema_list_keys ()) {
            if (auto found = node->find (key); found != node->end () && found->is_array ()) {
                for (const auto& child : *found) {
                    pending.push_back (&child);
                }
            }
        }
        // `items` is a subschema in draft-07 and a list in draft-04's tuple
        // form; both spellings reach schemas, so both are followed.
        if (auto items = node->find ("items"); items != node->end ()) {
            if (items->is_object ()) {
                pending.push_back (&*items);
            } else if (items->is_array ()) {
                for (const auto& child : *items) {
                    pending.push_back (&child);
                }
            }
        }
    }

    return { counts.begin (), counts.end () };
}

ValidationVerdict validate_body_against_schema (const nlohmann::json& schema,
const nlohmann::json& ref_roots,
const nlohmann::json& body) {
    ValidationVerdict verdict;
    verdict.unevaluated_keywords = collect_unevaluated_keywords (schema, ref_roots);

    const nlohmann::json root = validation_root (schema, ref_roots);
    valijson::Schema parsed;
    try {
        valijson::SchemaParser parser;
        const valijson::adapters::NlohmannJsonAdapter adapter (root);
        parser.populateSchema (adapter, parsed);
    } catch (const std::exception& e) {
        // A schema the validator refuses is not a body that failed: the
        // contract could not be read, so nothing was checked. Reported as
        // `no_index` - the index is there but unusable - with the reason in the
        // log, because the fix belongs to whoever wrote the index.
        vayu::utils::log_warning (
        "Response schema rejected by the validator: " + std::string (e.what ()));
        verdict.checked = false;
        verdict.reason  = UncheckedReason::NoIndex;
        return verdict;
    }

    valijson::ValidationResults results;
    try {
        valijson::Validator validator;
        const valijson::adapters::NlohmannJsonAdapter target (body);
        validator.validate (parsed, target, &results);
    } catch (const std::exception& e) {
        vayu::utils::log_warning (
        "Response schema validation failed: " + std::string (e.what ()));
        verdict.checked = false;
        verdict.reason  = UncheckedReason::NoIndex;
        return verdict;
    }

    std::vector<SchemaFailure> structural;
    valijson::ValidationResults::Error error;
    while (results.popError (error)) {
        SchemaFailure failure;
        failure.path = pointer_of_context (error.context);
        failure.message = error.description.size () > limits::MAX_FAILURE_MESSAGE_BYTES ?
        error.description.substr (0, limits::MAX_FAILURE_MESSAGE_BYTES) + "..." :
        error.description;

        if (failure.message.rfind (STRUCTURAL_ERROR_PREFIX, 0) == 0) {
            structural.push_back (std::move (failure));
            continue;
        }
        ++verdict.failures_total;
        if (verdict.failures.size () < limits::MAX_FAILURES) {
            verdict.failures.push_back (std::move (failure));
        }
    }

    // Every error was a structural wrapper: report them rather than a body that
    // failed with nothing to show. This is the guard that keeps the cosmetic
    // filter above from ever costing a reader the reason.
    if (verdict.failures_total == 0 && !structural.empty ()) {
        verdict.failures_total = structural.size ();
        structural.resize (std::min (structural.size (), limits::MAX_FAILURES));
        verdict.failures = std::move (structural);
    }

    verdict.checked = true;
    verdict.valid   = verdict.failures_total == 0;
    return verdict;
}

std::optional<ResponseSchemaIndex> ResponseSchemaIndex::parse (const std::string& stored) {
    if (stored.empty ()) {
        return std::nullopt;
    }
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (stored);
    } catch (const std::exception&) {
        return std::nullopt;
    }
    if (!parsed.is_object ()) {
        return std::nullopt;
    }
    auto operations = parsed.find ("operations");
    if (operations == parsed.end () || !operations->is_array ()) {
        return std::nullopt;
    }

    ResponseSchemaIndex index;
    if (auto roots = parsed.find ("refRoots"); roots != parsed.end () && roots->is_object ()) {
        index.ref_roots_ = *roots;
    }

    for (const auto& row : *operations) {
        if (index.operations_.size () >= constants::spec_document::MAX_OPERATIONS) {
            break;
        }
        if (!row.is_object ()) {
            continue;
        }
        const auto method = upper (row.value ("method", std::string ()));
        const auto path   = row.value ("path", std::string ());
        if (method.empty () || path.empty ()) {
            continue; // one unusable row must not cost the document its index
        }

        IndexedOperation operation;
        if (auto responses = row.find ("responses");
            responses != row.end () && responses->is_array ()) {
            for (const auto& response : *responses) {
                if (!response.is_object ()) {
                    continue;
                }
                DeclaredSchema declared;
                declared.status       = response.value ("status", std::string ());
                declared.content_type = lower (response.value ("contentType", std::string ()));
                auto schema           = response.find ("schema");
                if (declared.status.empty () || declared.content_type.empty () ||
                schema == response.end ()) {
                    continue;
                }
                declared.schema = *schema;
                operation.responses.push_back (std::move (declared));
            }
        }

        const size_t at = index.operations_.size ();
        // First writer wins in both maps, the rule `OperationIndex` states: a
        // document declaring one identity twice is malformed, and resolving to
        // whichever row came last would make a verdict depend on write order.
        if (auto id = row.find ("operationId");
            id != row.end () && id->is_string () && !id->get<std::string> ().empty ()) {
            index.by_operation_id_.emplace (id->get<std::string> (), at);
        }
        index.by_method_path_.emplace (method_path_key (method, path), at);
        index.operations_.push_back (std::move (operation));
    }

    return index;
}

ValidationVerdict ResponseSchemaIndex::check (const std::string& spec_operation,
int status_code,
const std::string& content_type,
const std::string& body) const {
    ValidationVerdict verdict;

    if (status_code <= 0) {
        verdict.reason = UncheckedReason::NoResponse;
        return verdict;
    }

    // Identity resolution, `operationId` first and `METHOD path` second - the
    // rule `core/operation_match.hpp` applies when binding and `OperationIndex`
    // applies when counting coverage, stated once more here because all three
    // must answer a rename the same way.
    std::optional<size_t> at;
    if (!spec_operation.empty ()) {
        try {
            const auto stamped = nlohmann::json::parse (spec_operation);
            if (stamped.is_object ()) {
                if (auto id = stamped.find ("operationId");
                    id != stamped.end () && id->is_string () &&
                    !id->get<std::string> ().empty ()) {
                    if (auto found = by_operation_id_.find (id->get<std::string> ());
                        found != by_operation_id_.end ()) {
                        at = found->second;
                    }
                }
                if (!at) {
                    const auto method = stamped.value ("method", std::string ());
                    const auto path   = stamped.value ("path", std::string ());
                    if (!method.empty () && !path.empty ()) {
                        if (auto found =
                            by_method_path_.find (method_path_key (method, path));
                            found != by_method_path_.end ()) {
                            at = found->second;
                        }
                    }
                }
            }
        } catch (const std::exception&) {
            // An unparseable stamp names no operation, which is what the
            // absent-identity branch below already answers.
        }
    }
    if (spec_operation.empty ()) {
        verdict.reason = UncheckedReason::NoOperation;
        return verdict;
    }
    if (!at) {
        verdict.reason = UncheckedReason::OperationNotDeclared;
        return verdict;
    }

    const auto& responses = operations_[*at].responses;

    // Which status pattern answers, decided by the same function coverage
    // counts with. Gathered per distinct pattern first so `2XX` declared for
    // three media types is one candidate status, not three.
    std::vector<std::string> patterns;
    for (const auto& declared : responses) {
        if (std::find (patterns.begin (), patterns.end (), declared.status) == patterns.end ()) {
            patterns.push_back (declared.status);
        }
    }
    const auto matched = match_status_pattern (patterns, status_code);
    if (!matched) {
        verdict.reason = UncheckedReason::NoSchemaForStatus;
        return verdict;
    }
    const std::string& status = patterns[*matched];

    const auto media = media_type_of (content_type);
    const DeclaredSchema* selected = nullptr;
    for (const auto& declared : responses) {
        if (declared.status != status) {
            continue;
        }
        if (declared.content_type == media) {
            selected = &declared;
            break;
        }
    }
    if (!selected) {
        // A `*/*` or `application/*` declaration, which OpenAPI allows and
        // generators emit, answers for a media type nothing else claimed.
        // Checked only after every exact match has been tried, so a document
        // declaring both keeps the specific one.
        for (const auto& declared : responses) {
            if (declared.status != status) {
                continue;
            }
            const auto slash = declared.content_type.find ('/');
            const bool wildcard = declared.content_type == "*/*" ||
            (slash != std::string::npos && declared.content_type.substr (slash) == "/*" &&
            media.rfind (declared.content_type.substr (0, slash + 1), 0) == 0);
            if (wildcard) {
                selected = &declared;
                break;
            }
        }
    }
    if (!selected) {
        verdict.reason = UncheckedReason::NoSchemaForContentType;
        return verdict;
    }

    nlohmann::json parsed_body;
    try {
        parsed_body = nlohmann::json::parse (body);
    } catch (const std::exception&) {
        // The contract declares a JSON schema and the server did not send
        // JSON. That is a finding, but it is not one a JSON Schema can state,
        // so it is reported as unchecked with the reason rather than as a
        // schema failure invented here.
        verdict.reason = UncheckedReason::BodyNotJson;
        return verdict;
    }

    verdict                      = validate_body_against_schema (selected->schema,
    ref_roots_, parsed_body);
    verdict.matched_status       = selected->status;
    verdict.matched_content_type = selected->content_type;
    return verdict;
}

} // namespace vayu::core
