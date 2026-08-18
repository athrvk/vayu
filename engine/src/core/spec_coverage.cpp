/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/spec_coverage.cpp
 * @brief Implementation of contract coverage (issue #629). See the header for
 *        why the operation index is supplied rather than parsed here.
 */

#include "vayu/core/spec_coverage.hpp"

#include "vayu/core/constants.hpp"

#include <algorithm>
#include <cctype>
#include <set>
#include <utility>

namespace vayu::core {

namespace {

namespace limits = vayu::core::constants::spec_document;

/// `"default"`, the pattern OpenAPI gives the response that catches what the
/// others do not. Compared rather than parsed, so it is spelled once.
constexpr const char* DEFAULT_PATTERN = "default";

std::string upper (std::string value) {
    std::transform (value.begin (), value.end (), value.begin (),
    [] (unsigned char c) { return static_cast<char> (std::toupper (c)); });
    return value;
}

bool all_digits (const std::string& value) {
    return std::all_of (value.begin (), value.end (),
    [] (unsigned char c) { return std::isdigit (c) != 0; });
}

/**
 * Whether @p pattern names @p status *exactly* - `"200"` for 200.
 *
 * Range and `default` patterns are deliberately not folded in here: matching is
 * layered most-specific-first below, which is the precedence OpenAPI itself
 * gives the three kinds. Folding them together would let a `2XX` declaration
 * count as hit by a status the operation's own `200` row already answered.
 */
bool matches_exact (const std::string& pattern, int status) {
    return pattern.size () == 3 && all_digits (pattern) && std::stoi (pattern) == status;
}

/// Whether @p pattern is a range (`"2XX"`) covering @p status.
bool matches_range (const std::string& pattern, int status) {
    if (pattern.size () != 3 || std::isdigit (static_cast<unsigned char> (pattern[0])) == 0) {
        return false;
    }
    if (upper (pattern.substr (1)) != "XX") {
        return false;
    }
    const int hundreds = pattern[0] - '0';
    return status >= hundreds * 100 && status < (hundreds + 1) * 100;
}

/// Serialize at most `MAX_STATUSES_PER_OPERATION` codes, ascending. Every code
/// it emits joins @p shown, which is what lets the row name the distinct
/// statuses it hides rather than the entries the two lists dropped between them
/// (issue #786): `undeclaredSeen` is a subset of `statusesSeen`, so a counter
/// shared by the two calls counts a code past both caps twice, and a code the
/// undeclared list still carries is not hidden at all.
nlohmann::json capped_statuses (const std::set<int>& codes, std::set<int>& shown) {
    nlohmann::json out = nlohmann::json::array ();
    for (const int code : codes) {
        // Ascending, so nothing after the cap can be emitted either.
        if (out.size () >= limits::MAX_STATUSES_PER_OPERATION) {
            break;
        }
        out.push_back (code);
        shown.insert (code);
    }
    return out;
}

/// The identity two declared operations are the same operation by, when neither
/// carries an `operationId`.
std::string method_path_key (const std::string& method, const std::string& path) {
    return method + " " + path;
}

} // namespace

std::optional<std::string> validate_operations_index (const nlohmann::json& operations) {
    if (!operations.is_array ()) {
        return "Invalid 'operations': must be an array of declared operations";
    }
    if (operations.size () > limits::MAX_OPERATIONS) {
        return "Spec declares " + std::to_string (operations.size ()) +
        " operations, over the limit of " + std::to_string (limits::MAX_OPERATIONS);
    }
    for (size_t i = 0; i < operations.size (); ++i) {
        const auto& row      = operations[i];
        const std::string at = "operations[" + std::to_string (i) + "]";
        if (!row.is_object ()) {
            return "Invalid '" + at + "': must be an object";
        }
        for (const char* required : { "method", "path" }) {
            auto found = row.find (required);
            if (found == row.end () || !found->is_string () ||
            found->get<std::string> ().empty ()) {
                return "Invalid '" + at + "." + required +
                "': a declared operation needs a non-empty string";
            }
        }
        if (auto id = row.find ("operationId");
            id != row.end () && !id->is_null () && !id->is_string ()) {
            return "Invalid '" + at + ".operationId': must be a string or null";
        }
        auto responses = row.find ("responses");
        if (responses == row.end ()) {
            continue;
        }
        if (!responses->is_array ()) {
            return "Invalid '" + at +
            ".responses': must be an array of declared status patterns";
        }
        for (const auto& pattern : *responses) {
            if (!pattern.is_string () || pattern.get<std::string> ().empty ()) {
                return "Invalid '" + at +
                ".responses': every declared status pattern must be a non-empty string";
            }
        }
    }
    return std::nullopt;
}

std::optional<size_t>
match_status_pattern (const std::vector<std::string>& patterns, int status) {
    for (size_t i = 0; i < patterns.size (); ++i) {
        if (matches_exact (patterns[i], status)) {
            return i;
        }
    }
    for (size_t i = 0; i < patterns.size (); ++i) {
        if (matches_range (patterns[i], status)) {
            return i;
        }
    }
    for (size_t i = 0; i < patterns.size (); ++i) {
        if (patterns[i] == DEFAULT_PATTERN) {
            return i;
        }
    }
    return std::nullopt;
}

std::optional<std::vector<DeclaredOperation>>
parse_declared_operations (const std::string& stored) {
    if (stored.empty ()) {
        return std::nullopt;
    }
    nlohmann::json parsed;
    try {
        parsed = nlohmann::json::parse (stored);
    } catch (const std::exception&) {
        return std::nullopt;
    }
    if (!parsed.is_array ()) {
        return std::nullopt;
    }

    std::vector<DeclaredOperation> declared;
    declared.reserve (std::min (parsed.size (), limits::MAX_OPERATIONS));
    for (const auto& row : parsed) {
        if (declared.size () >= limits::MAX_OPERATIONS) {
            break;
        }
        if (!row.is_object ()) {
            continue;
        }
        DeclaredOperation operation;
        operation.method = upper (row.value ("method", std::string ()));
        operation.path   = row.value ("path", std::string ());
        if (operation.method.empty () || operation.path.empty ()) {
            continue;
        }
        if (auto id = row.find ("operationId"); id != row.end () && id->is_string ()) {
            operation.operation_id = id->get<std::string> ();
        }
        if (auto responses = row.find ("responses");
            responses != row.end () && responses->is_array ()) {
            for (const auto& pattern : *responses) {
                if (pattern.is_string () && !pattern.get<std::string> ().empty ()) {
                    operation.responses.push_back (pattern.get<std::string> ());
                }
            }
        }
        declared.push_back (std::move (operation));
    }
    return declared;
}

OperationIndex::OperationIndex (const std::vector<DeclaredOperation>& declared) {
    for (size_t i = 0; i < declared.size (); ++i) {
        // First writer wins in both maps. A document that declares one
        // `operationId` (or one `METHOD path`) twice is malformed, and resolving
        // to whichever row was seen last would make coverage depend on the order
        // the index happened to be written in.
        if (!declared[i].operation_id.empty ()) {
            by_operation_id_.emplace (declared[i].operation_id, i);
        }
        by_method_path_.emplace (method_path_key (declared[i].method, declared[i].path), i);
    }
}

std::optional<size_t> OperationIndex::resolve (const std::string& spec_operation) const {
    if (spec_operation.empty ()) {
        return std::nullopt;
    }
    nlohmann::json stamped;
    try {
        stamped = nlohmann::json::parse (spec_operation);
    } catch (const std::exception&) {
        return std::nullopt;
    }
    if (!stamped.is_object ()) {
        return std::nullopt;
    }

    if (auto id = stamped.find ("operationId"); id != stamped.end () && id->is_string ()) {
        const auto operation_id = id->get<std::string> ();
        if (!operation_id.empty ()) {
            if (auto found = by_operation_id_.find (operation_id);
                found != by_operation_id_.end ()) {
                return found->second;
            }
        }
    }
    const auto method = upper (stamped.value ("method", std::string ()));
    const auto path   = stamped.value ("path", std::string ());
    if (method.empty () || path.empty ()) {
        return std::nullopt;
    }
    if (auto found = by_method_path_.find (method_path_key (method, path));
        found != by_method_path_.end ()) {
        return found->second;
    }
    return std::nullopt;
}

CoverageTally::CoverageTally (std::vector<DeclaredOperation> declared,
const std::vector<std::string>& step_operations)
: declared_ (std::move (declared)) {
    if (declared_.empty ()) {
        return;
    }
    const OperationIndex index (declared_);
    step_operation_.reserve (step_operations.size ());
    for (const auto& stamped : step_operations) {
        step_operation_.push_back (index.resolve (stamped));
    }
    counts_.reserve (step_operations.size ());
    for (size_t i = 0; i < step_operations.size (); ++i) {
        counts_.emplace_back (SLOTS);
    }
}

void CoverageTally::record (size_t step, int status_code) {
    if (step >= counts_.size ()) {
        return;
    }
    size_t slot = OTHER_SLOT;
    if (status_code == 0) {
        slot = TRANSPORT_SLOT;
    } else if (status_code >= static_cast<int> (FIRST_STATUS) &&
    status_code <= static_cast<int> (LAST_STATUS)) {
        slot = static_cast<size_t> (status_code) - FIRST_STATUS;
    }
    counts_[step][slot].fetch_add (1, std::memory_order_relaxed);
}

nlohmann::json CoverageTally::build () const {
    if (declared_.empty ()) {
        return nlohmann::json::object ();
    }

    std::vector<OperationObservation> observed (declared_.size ());
    size_t undeclared_operation_requests = 0;

    for (size_t step = 0; step < counts_.size (); ++step) {
        OperationObservation* row = nullptr;
        if (step < step_operation_.size () && step_operation_[step]) {
            row = &observed[*step_operation_[step]];
        }
        for (size_t slot = 0; slot < SLOTS; ++slot) {
            const size_t count = counts_[step][slot].load (std::memory_order_relaxed);
            if (count == 0) {
                continue;
            }
            if (row == nullptr) {
                undeclared_operation_requests += count;
                continue;
            }
            row->sent += count;
            if (slot == TRANSPORT_SLOT) {
                row->transport_errors += count;
            } else if (slot == OTHER_SLOT) {
                row->other_status_responses += count;
            } else {
                row->statuses[static_cast<int> (slot + FIRST_STATUS)] += count;
            }
        }
    }

    return build_coverage_payload (declared_, observed, undeclared_operation_requests);
}

nlohmann::json build_coverage_payload (const std::vector<DeclaredOperation>& declared,
const std::vector<OperationObservation>& observed,
size_t undeclared_operation_requests) {
    if (declared.empty ()) {
        return nlohmann::json::object ();
    }

    struct Row {
        nlohmann::json body;
        bool covered = false;
    };
    std::vector<Row> rows;
    rows.reserve (declared.size ());

    size_t operations_covered     = 0;
    size_t declared_total         = 0;
    size_t declared_hit_total     = 0;
    size_t undeclared_total       = 0;
    size_t transport_errors_total = 0;

    const OperationObservation nothing;
    for (size_t i = 0; i < declared.size (); ++i) {
        const auto& operation = declared[i];
        const OperationObservation& seen = i < observed.size () ? observed[i] : nothing;

        std::set<int> statuses_seen;
        std::set<int> undeclared;
        std::vector<bool> hit (operation.responses.size (), false);
        for (const auto& [status, count] : seen.statuses) {
            if (count == 0) {
                continue;
            }
            statuses_seen.insert (status);
            if (auto index = match_status_pattern (operation.responses, status)) {
                hit[*index] = true;
            } else {
                undeclared.insert (status);
            }
        }

        nlohmann::json declared_hit    = nlohmann::json::array ();
        nlohmann::json declared_missed = nlohmann::json::array ();
        for (size_t p = 0; p < operation.responses.size (); ++p) {
            (hit[p] ? declared_hit : declared_missed).push_back (operation.responses[p]);
        }

        // Braced initialization evaluates left to right, so both lists have
        // filled this by the time the row is read below.
        std::set<int> statuses_shown;
        nlohmann::json row{ { "method", operation.method }, { "path", operation.path },
            { "sent", seen.sent },
            { "statusesSeen", capped_statuses (statuses_seen, statuses_shown) },
            { "declaredHit", declared_hit }, { "declaredMissed", declared_missed },
            { "undeclaredSeen", capped_statuses (undeclared, statuses_shown) } };
        // Absent rather than "" for an operation the document gives no id - the
        // same absent-not-empty rule the binding itself follows.
        if (!operation.operation_id.empty ()) {
            row["operationId"] = operation.operation_id;
        }
        // Findings that are zero on most rows, carried only where they happened
        // rather than padding every row with counters nobody reads.
        if (seen.transport_errors > 0) {
            row["transportErrors"] = seen.transport_errors;
        }
        if (seen.other_status_responses > 0) {
            row["otherStatusResponses"] = seen.other_status_responses;
        }
        // Every emitted code is drawn from `statuses_seen` - the undeclared set
        // is a subset of it - so what neither list carries is one subtraction.
        const size_t statuses_hidden = statuses_seen.size () - statuses_shown.size ();
        if (statuses_hidden > 0) {
            row["statusesTruncated"] = statuses_hidden;
        }

        const bool covered = seen.sent > 0;
        operations_covered += covered ? 1 : 0;
        declared_total += operation.responses.size ();
        declared_hit_total += static_cast<size_t> (std::count (hit.begin (), hit.end (), true));
        undeclared_total += undeclared.size ();
        transport_errors_total += seen.transport_errors;
        rows.push_back ({ std::move (row), covered });
    }

    // Uncovered first - they are what the block exists to surface - and document
    // order within each group, so two runs of one contract agree.
    std::stable_sort (rows.begin (), rows.end (),
    [] (const Row& a, const Row& b) { return !a.covered && b.covered; });

    nlohmann::json operations = nlohmann::json::array ();
    for (auto& row : rows) {
        operations.push_back (std::move (row.body));
    }

    // The three plain numbers a CLI gate would threshold on sit at the top
    // level, shaped like `thresholdValidation`'s counts, so #473 can adopt them
    // without reshaping the block (documented, not implemented).
    nlohmann::json coverage{ { "operationsTotal", declared.size () },
        { "operationsCovered", operations_covered },
        { "declaredResponsesTotal", declared_total },
        { "declaredResponsesHit", declared_hit_total },
        { "declaredResponseCoveragePct",
        declared_total > 0 ? static_cast<double> (declared_hit_total) * 100.0 /
        static_cast<double> (declared_total) :
                             0.0 },
        { "undeclaredStatusesSeen", undeclared_total },
        { "operations", std::move (operations) } };
    if (transport_errors_total > 0) {
        coverage["transportErrors"] = transport_errors_total;
    }
    if (undeclared_operation_requests > 0) {
        coverage["undeclaredOperationRequests"] = undeclared_operation_requests;
    }
    return coverage;
}

} // namespace vayu::core
