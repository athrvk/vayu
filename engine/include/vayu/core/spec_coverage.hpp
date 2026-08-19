#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/spec_coverage.hpp
 * @brief Which operations of a bound contract a run exercised, and which of
 *        their declared responses it saw (issue #629).
 *
 * **The engine does not parse OpenAPI, and this file does not either.** That is
 * the division of labour #625 decided, and it is load-bearing rather than
 * tidiness: a stored document is the bytes the app imported, which are YAML as
 * often as JSON, and a C++ reader of them would be a second opinion about what a
 * document declares - disagreeing with the parser that stamped every request's
 * `spec_operation` in exactly the cases that matter (a `$ref`-ed path item, a
 * response inherited from a component). So the app extracts the operation index
 * once, at the moment it stores the document, and this file counts against it.
 *
 * What that index costs is one column (`spec_documents.operations`) and one
 * honest gap: a document stored before the index existed has none, and a run of
 * it reports **no coverage block at all** rather than a total of zero
 * operations. "Not measured" and "measured nothing" are different answers and
 * the report gives them different spellings, the rule every conditional section
 * of the report already follows.
 *
 * The index is read **once, when the plan resolves**, and carried on the
 * execution - never re-read at run end. That is the same rule the plan itself
 * follows, and it is what pins coverage to the document the run was planned
 * against: a sync that lands mid-run stores a *new* document and moves the
 * binding, and a run that re-read at the end would report itself against a
 * contract it never saw.
 *
 * Every number here is **exact, never sampled.** Coverage counts what each step
 * sent and what came back, at the moment it happened, through a tally that is
 * not the bounded result store - so a load run whose `results[]` were thinned to
 * a reservoir still reports every operation it touched. That is why the tally
 * lives here rather than being derived from stored rows at report time, and it
 * is what `docs/app/openapi.md`'s total-vs-sampled table records.
 */

#include <atomic>
#include <cstddef>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace vayu::core {

/**
 * One operation the bound document declares, as the app extracted it.
 *
 * `responses` holds the status *patterns* the document declares, verbatim and in
 * document order - `"200"`, `"4XX"`, `"default"`. Patterns rather than codes
 * because that is what OpenAPI declares, and flattening `2XX` into a hundred
 * codes would report a contract the document never wrote.
 */
struct DeclaredOperation {
    /// `operationId`, or "" for an operation that declares none.
    std::string operation_id;
    /// Upper-case, as the identity is stamped on a request.
    std::string method;
    /// The path *template* (`/pets/{petId}`), never a concrete URL.
    std::string path;
    std::vector<std::string> responses;
};

/**
 * @brief Parse a stored `spec_documents.operations` index.
 *
 * `std::nullopt` for an absent, unparseable or non-array value, which is what
 * makes the report leave the section out entirely. A *row* that is unusable
 * (not an object, no `method`, no `path`) is skipped rather than failing the
 * whole index: one bad row must not cost a run its whole coverage report.
 *
 * At most `spec_document::MAX_OPERATIONS` rows are kept; the write path refuses
 * more, so a longer stored value can only come from an older or a tampered
 * writer, and truncating it here keeps a run's memory bounded either way.
 */
[[nodiscard]] std::optional<std::vector<DeclaredOperation>>
parse_declared_operations (const std::string& stored);

/**
 * @brief Validate an `operations` index on the way in.
 *
 * Returns the caller-facing `400` sentence, or `std::nullopt` when the value is
 * an acceptable index. Invalid input fails loudly here rather than being stored
 * and quietly ignored at run end - a client that sends a malformed index has a
 * bug, and the write is the only place that can name it.
 */
[[nodiscard]] std::optional<std::string>
validate_operations_index (const nlohmann::json& operations);

/**
 * @brief The one declared status pattern @p status answers to, most specific
 *        first - exact (`"200"`), then range (`"2XX"`), then `"default"`.
 *
 * `std::nullopt` when the document declares nothing covering @p status.
 *
 * Exactly one match, and the most specific: a 200 seen against an operation
 * declaring both `200` and `2XX` hits the `200` row and leaves `2XX` unhit,
 * which is the honest reading - the document declared two distinct responses
 * and the run produced one of them.
 *
 * Exported rather than kept private to this file because response schema
 * validation (#628) has to pick a schema by the same rule coverage counts a
 * response by. Two copies would let a status be "covered" here and
 * "no schema for this status" there, on one document.
 */
[[nodiscard]] std::optional<size_t>
match_status_pattern (const std::vector<std::string>& patterns, int status);

/**
 * @brief Resolve an executed request's stamped identity to a declared operation.
 *
 * `operationId` first, `METHOD path` second - the rule `operation_match.hpp`
 * already applies when binding, stated once on each side because both sides must
 * answer a rename the same way. `std::nullopt` means the run exercised something
 * the document does not declare, which the tally counts as its own finding
 * rather than inventing a row for.
 */
class OperationIndex {
    public:
    explicit OperationIndex (const std::vector<DeclaredOperation>& declared);

    /// The declared operation that @p spec_operation (the stored
    /// `requests.spec_operation` JSON text) names, as an index into the
    /// `declared` vector this was built from.
    [[nodiscard]] std::optional<size_t> resolve (const std::string& spec_operation) const;

    private:
    std::unordered_map<std::string, size_t> by_operation_id_;
    std::unordered_map<std::string, size_t> by_method_path_;
};

/**
 * @brief Per-plan-step response tallies, exact and written on every completion.
 *
 * One counter array per step, indexed by status code, because the alternative -
 * a map behind a mutex - would put a lock on the load-mode completion path,
 * which refills concurrency per completion. Codes are bucketed on a fixed range
 * (`100`-`599`, the whole of HTTP's), with a transport-error slot for code `0`
 * and one more for a response outside that range; both are reported by name
 * rather than folded into a status the server never sent.
 *
 * Identity resolution happens **once per plan step**, when the tally is built,
 * so a completion costs one atomic increment rather than a JSON parse. That is
 * the difference between coverage a load run can afford and one it cannot.
 */
class CoverageTally {
    public:
    /**
     * @param declared        The bound document's operation index; empty means
     *                        the run is not measured against a contract, and
     *                        `active()` is false.
     * @param step_operations Per plan step, in plan order, the stored
     *                        `requests.spec_operation` text ("" for a step whose
     *                        request names no operation).
     */
    CoverageTally (std::vector<DeclaredOperation> declared,
    const std::vector<std::string>& step_operations);

    /// False for a run of an unbound collection, or one whose document was
    /// stored before the index existed. Callers write no `coverage` at all then.
    [[nodiscard]] bool active () const {
        return !declared_.empty ();
    }

    /// One completed step. @p status_code is `0` for a transport error, which is
    /// counted as a request sent but never as a response the contract answered.
    /// Out-of-range @p step is ignored rather than crashing a run over a
    /// bookkeeping mistake; the counts stay honest for every other step.
    void record (size_t step, int status_code);

    /// The `coverage` object for `runs.summary`. See `build_coverage_payload`.
    [[nodiscard]] nlohmann::json build () const;

    private:
    /// Slot layout of one step's counter array.
    static constexpr size_t FIRST_STATUS = 100;
    static constexpr size_t LAST_STATUS  = 599;
    static constexpr size_t STATUS_SLOTS = LAST_STATUS - FIRST_STATUS + 1;
    static constexpr size_t TRANSPORT_SLOT = STATUS_SLOTS;
    static constexpr size_t OTHER_SLOT     = STATUS_SLOTS + 1;
    static constexpr size_t SLOTS          = STATUS_SLOTS + 2;

    std::vector<DeclaredOperation> declared_;
    /// Per step: the declared operation it exercises, or `nullopt` for a step
    /// whose identity the document does not declare.
    std::vector<std::optional<size_t>> step_operation_;
    /// Per step, `SLOTS` counters. Steps of an inactive tally allocate none.
    std::vector<std::vector<std::atomic<size_t>>> counts_;
};

/** What a run observed while exercising one operation. */
struct OperationObservation {
    /// Requests sent for this operation, including the ones that never got a
    /// response back - so `sent` is always the honest denominator.
    size_t sent = 0;
    /// Response status -> how many times it came back. Code 0 is never a key
    /// here; a connection that failed is not a response the contract answered.
    std::map<int, size_t> statuses;
    size_t transport_errors = 0;
    /// Responses whose status fell outside 100-599. Counted, never rounded into
    /// a code the server did not send.
    size_t other_status_responses = 0;
};

/**
 * @brief The `coverage` object a run stores in `runs.summary`.
 *
 * Written in the report's own camelCase - the `stream` and `monitor` sections'
 * rule (#576), for their reason: the report route passes it through verbatim, so
 * there is one description of the shape rather than a writer and a translator
 * that can drift.
 *
 * Rows come back **uncovered first**, because an operation nothing exercised is
 * the finding a reader opened the block for; within each group they keep
 * document order, so two runs of one contract print their rows the same way.
 *
 * @param undeclared_operation_requests Requests the run sent against an identity
 *        the document does not declare - a collection that has drifted off its
 *        contract, which is exactly what this block is asked to notice.
 *
 * Returns an empty object when @p declared is empty: a document that declares no
 * operation gives a reader nothing to act on, and the caller leaves the section
 * out rather than reporting zero of zero covered.
 */
[[nodiscard]] nlohmann::json build_coverage_payload (
const std::vector<DeclaredOperation>& declared,
const std::vector<OperationObservation>& observed,
size_t undeclared_operation_requests);

} // namespace vayu::core
