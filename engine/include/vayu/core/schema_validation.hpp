#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/schema_validation.hpp
 * @brief Checking a response body against the schema its contract declares
 *        (issue #628, phase 3 of #625).
 *
 * **The engine does not parse OpenAPI, and this file does not either** - the
 * same division of labour `core/spec_coverage.hpp` states at length, for the
 * same reason. What arrives here is already JSON Schema: the app extracts each
 * operation's declared response schemas when it stores the document, normalises
 * the OpenAPI-only spellings (3.0's `nullable`, its draft-04 boolean
 * `exclusiveMinimum`, `discriminator`) into the dialect a validator can read,
 * and stores the result in `spec_documents.response_schemas`. This file matches
 * a response to one of those schemas and validates it.
 *
 * ### Why the schemas are a column of their own
 *
 * `spec_documents.operations` (#629) already lists every operation and the
 * status *patterns* it declares, and folding the schemas into it would have
 * saved a column. It would also have made every scenario run pay for them: that
 * index is parsed when a plan resolves and held for the life of the run, while
 * schemas are read only when a response comes back with a body to check. They
 * are also two orders of magnitude larger. Two columns, each read by whoever
 * needs it.
 *
 * ### Why schemas are stored as written, beside one shared ref root
 *
 * A response schema is stored exactly as the document wrote it - `$ref`s
 * included - next to a single `refRoots` object holding the document's
 * `components` / `definitions` / `x-vayu-bundled` subtrees. Validation merges
 * the two into one root document, so an in-document pointer resolves against
 * the real target.
 *
 * The alternative was to dereference app-side and store each schema whole. It
 * duplicates a shared `Error` schema into every operation that names it, and a
 * recursive schema (a tree node whose child is itself) has no finite expansion
 * at all - it would have needed a cycle guard that reintroduces `$ref` anyway.
 * One shared root costs one copy of the components per *document*, and a
 * recursive schema is simply a pointer that resolves.
 *
 * ### Which validator, and why not the one the issue named
 *
 * `valijson` (v1.1.0, BSD-2), not `json-schema-validator` (pboettch) which
 * #625/#628 named first and #628 recorded valijson as the fallback for. The
 * fallback was taken, and the reason is not taste: pboettch's `set_root_schema`
 * **segfaults on a recursive schema** - a `Node` whose `child` is a `Node`,
 * which is what a tree, a comment thread or a nested category is in every real
 * document that has one. It is reproducible in six lines against v2.4.0 and it
 * takes the daemon's whole process with it, which is a worse outcome than
 * having no validation at all. valijson validates the same schemas, reports a
 * location and a description per failure, and collects every failure in one
 * pass rather than throwing at the first.
 *
 * ### Dialect honesty
 *
 * The validator targets **draft-07**. OpenAPI 3.0's dialect normalises into it
 * cleanly; 3.1 is JSON Schema 2020-12, which has keywords draft-07 has never
 * heard of - `unevaluatedProperties`, `prefixItems`, `dependentSchemas`. A
 * validator that has not heard of a keyword ignores it, so a schema that meant
 * to forbid something silently permits it. Every such keyword is therefore
 * **counted and named** in the verdict (`unevaluatedKeywords`), the truncation
 * disclosure discipline applied to a dialect gap: nothing here ever reports a
 * body as clean when part of its contract went unread.
 */

#include <cstddef>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace vayu::core {

/**
 * Why a response was not checked. A code rather than a sentence: the app owns
 * the wording it shows a user, and a sentence built here would be a second
 * place to change it. `docs/engine/api-reference.md` lists them all.
 *
 * Absent-vs-`checked:false` is the distinction that matters and it is decided
 * by the caller, not here: a collection bound to no document produces **no
 * verdict node at all**, because a run that was never judged against a contract
 * did not fail one. Every reason below describes a run that *is* bound and
 * still could not be judged.
 */
enum class UncheckedReason {
    /// The request carries no `spec_operation` - it is not an operation.
    NoOperation,
    /// The bound document carries no response-schema index (stored before the
    /// index existed, or by a client that sends none).
    NoIndex,
    /// The document behind the binding no longer hashes to what the binding
    /// recorded, so what it declares is not what this request was bound to.
    HashMismatch,
    /// The identity is not one the index declares.
    OperationNotDeclared,
    /// The operation declares responses, none matching this status.
    NoSchemaForStatus,
    /// The status matched, none of its media types did.
    NoSchemaForContentType,
    /// There was no response to check - a transport error.
    NoResponse,
    /// The body is not JSON, so no JSON Schema can speak about it.
    BodyNotJson,
};

[[nodiscard]] std::string to_string (UncheckedReason reason);

/** One thing wrong with a body, at a location inside it. */
struct SchemaFailure {
    /// JSON Pointer into the *body*, `""` for the body itself.
    std::string path;
    /**
     * The validator's message.
     *
     * There is deliberately no `keyword` field beside it. #628 asked for one,
     * and the validator does not expose it: an error carries a context path and
     * a rendered description, and recovering "required" or "type" from that
     * description means pattern-matching English the library is free to reword.
     * A field that is wrong after an upstream release is worse than a field
     * that was never promised; the description names the keyword in prose.
     */
    std::string message;
};

/** What one response check found. */
struct ValidationVerdict {
    bool checked = false;
    /// Meaningful only when `checked`. A body with no failures is valid.
    bool valid = false;
    /// Set exactly when `!checked`.
    std::optional<UncheckedReason> reason;

    /// Bounded by `constants::schema_validation::MAX_FAILURES`.
    std::vector<SchemaFailure> failures;
    /// Every failure found, including the ones past the cap - so a reader can
    /// tell "three problems" from "three shown of ninety".
    size_t failures_total = 0;

    /// Schema keywords the validator could not evaluate, by name, with how many
    /// times each appeared in the schema this response was checked against.
    /// Non-empty means part of the contract went unread - see the file comment.
    std::vector<std::pair<std::string, size_t>> unevaluated_keywords;

    /// The status pattern and media type the response matched, verbatim as the
    /// document declared them (`"2XX"`, `"default"`, `"application/json"`).
    std::string matched_status;
    std::string matched_content_type;
};

/**
 * @brief The `validation` node a client reads, live and restored alike.
 *
 * camelCase, like every other node a route passes through verbatim (`stream`,
 * `coverage`), so there is one description of the shape rather than a writer
 * and a translator that can drift.
 */
[[nodiscard]] nlohmann::json build_validation_payload (const ValidationVerdict& verdict);

/**
 * @brief Validate a stored `response_schemas` index on the way in.
 *
 * Returns the caller-facing `400` sentence, or `std::nullopt` for an acceptable
 * index. The engine cannot check that the schemas *describe* the document - it
 * does not read the document - but it can refuse a shape no reader could use,
 * and refusing at the write is the only place that can name the client's bug.
 * A malformed index accepted here would instead go missing weeks later as a
 * chip that never appears.
 *
 * @param cap Bytes the serialized index may occupy - `maxSpecDocumentBytes`,
 *        the same number the document itself is held to rather than a second
 *        knob, because the two are stored together and grow together.
 */
[[nodiscard]] std::optional<std::string>
validate_response_schemas_index (const nlohmann::json& index, size_t cap);

/**
 * @brief A parsed `spec_documents.response_schemas`, ready to answer one
 *        response at a time.
 *
 * Built once per execution, not per response: parsing a document's whole schema
 * index is the expensive half, and matching against it afterwards is a map
 * lookup and a status comparison.
 */
class ResponseSchemaIndex {
    public:
    /// `std::nullopt` for an absent, unparseable or wrongly-shaped index -
    /// which the caller reports as `NoIndex`, never as an empty contract.
    [[nodiscard]] static std::optional<ResponseSchemaIndex> parse (const std::string& stored);

    /**
     * @brief Check one response against what the contract declares for it.
     *
     * @param spec_operation The stored `requests.spec_operation` text - the
     *        identity resolution is `operationId` first, `METHOD path` second,
     *        the rule `operation-match.ts` and `OperationIndex` both state.
     * @param status_code    `0` for a transport error, which is `NoResponse`
     *        rather than a status nothing declares.
     * @param content_type   The response's `Content-Type` header, parameters
     *        included; the media type is taken off it here.
     * @param body           The raw response body.
     */
    [[nodiscard]] ValidationVerdict
    check (const std::string& spec_operation, int status_code, const std::string& content_type, const std::string& body) const;

    /// Operations the index declares. Zero is possible and honest: a document
    /// whose operations all declare unschema'd responses.
    [[nodiscard]] size_t size () const {
        return operations_.size ();
    }

    private:
    struct DeclaredSchema {
        std::string status;       ///< `"200"`, `"2XX"`, `"default"` - as written.
        std::string content_type; ///< Media type, lower-cased, as written.
        nlohmann::json schema;
    };
    struct IndexedOperation {
        std::vector<DeclaredSchema> responses;
    };

    /// The document's `components` / `definitions` / `x-vayu-bundled` subtrees,
    /// merged into every schema at validation time so in-document `$ref`s
    /// resolve. Stored once; see the file comment.
    nlohmann::json ref_roots_ = nlohmann::json::object ();
    std::vector<IndexedOperation> operations_;
    std::unordered_map<std::string, size_t> by_operation_id_;
    std::unordered_map<std::string, size_t> by_method_path_;
};

/**
 * @brief Validate one JSON body against one schema.
 *
 * Split out of `ResponseSchemaIndex::check` so the validator integration is
 * testable without an index around it, and so the load and collection-run hooks
 * that follow this phase call the same code rather than a second copy.
 *
 * @param ref_roots Merged into @p schema to form the validation root; pass an
 *        empty object for a self-contained schema.
 */
[[nodiscard]] ValidationVerdict validate_body_against_schema (const nlohmann::json& schema,
const nlohmann::json& ref_roots,
const nlohmann::json& body);

/**
 * @brief Count the schema keywords a draft-07 validator cannot evaluate.
 *
 * Walks @p schema, following in-document `$ref`s through @p ref_roots with a
 * cycle guard, so what is reported is what *this* response was actually checked
 * against - not every unevaluatable keyword anywhere in the document, which
 * would name keywords no response here ever touched.
 */
[[nodiscard]] std::vector<std::pair<std::string, size_t>>
collect_unevaluated_keywords (const nlohmann::json& schema, const nlohmann::json& ref_roots);

} // namespace vayu::core
