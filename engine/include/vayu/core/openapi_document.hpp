#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/openapi_document.hpp
 * @brief Reading a stored OpenAPI document engine-side (issue #853).
 *
 * **This is where the engine's "we do not parse OpenAPI" rule moved to, not
 * where it was broken.** `core/spec_coverage.hpp` recorded the rule and its
 * reason: two readers of one document are two opinions about what it declares,
 * and they disagree exactly where it matters - a `$ref`-ed path item, a
 * repeated `operationId`. The rule was never "the engine must stay ignorant";
 * it was "one reader". #761's phase B decided which side that reader lives on,
 * because everything an agent wants to do over MCP - bind a collection, ask
 * what a re-fetched document would change, export one back out - needs the
 * document read somewhere that is not the renderer. So the reader is here, and
 * what moves onto it stops being read there.
 *
 * Two layers, deliberately separate:
 *
 * 1. **`read_document`** turns the stored bytes into a JSON DOM. A document is
 *    YAML as often as JSON, so this is the one place in the engine that holds a
 *    YAML dependency (rapidyaml). Everything else reads the DOM.
 * 2. **`declared_operations_of`** and **`response_schemas_of`** answer what the
 *    document declares, which is an OpenAPI question and not a YAML one. They
 *    walk the same operations by the same rules, so the two indexes a write
 *    stores cannot disagree about which operation declares which status.
 *
 * ### What the reader promises
 *
 * - **Document order is preserved.** `paths` and a `responses` map come back in
 *   the order the document writes them, which is what `DeclaredOperation`
 *   already claims to store and what a coverage block prints. (The renderer
 *   could not keep that promise: a JavaScript object orders integer-like keys
 *   numerically ahead of the rest, so `responses: {404, 200}` reached the store
 *   as `200, 404`.)
 * - **Scalars are typed the way js-yaml's core schema types them**, because the
 *   importer reads the same bytes with js-yaml and the two must not disagree
 *   about whether `"2.0"` is a string. A quoted scalar is always a string; a
 *   plain one is null / bool / int / float / string by the core rules. One
 *   deliberate divergence: js-yaml's *default* schema also resolves a
 *   date-shaped plain scalar to a `Date`, and this reader leaves it a string -
 *   JSON has no date type and the document wrote text.
 * - **Anchors, aliases and merge keys (`<<`) are expanded** as js-yaml expands
 *   them: an explicit key always beats a merged one, an earlier entry of a
 *   merge sequence beats a later one, and an alias naming no anchor is an
 *   error rather than a hole.
 * - **A duplicate mapping key is an error**, again as js-yaml has it. A
 *   document that declares one key twice declares nothing definite, and picking
 *   a winner here would pick a different one than the importer did.
 * - **Expansion is bounded** - see `read_document` - and a malformed document
 *   comes back as a sentence, never as a crash. rapidyaml's default error
 *   handler calls `abort()`; this file installs one that throws, and
 *   `openapi_document_test.cpp` holds a malformed document against it, because
 *   the daemon dying on a bad upload would be the worst version of this bug.
 */

#include "vayu/core/spec_coverage.hpp"

#include <cstddef>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace vayu::core {

/**
 * A document read into a DOM, or the caller-facing sentence saying why these
 * bytes are not one.
 *
 * The sentence is what a `400` carries, so it names the failure and where it
 * is - "line 12: ..." - rather than "invalid document". A caller that cannot
 * act on the answer will send the same bytes again.
 */
struct DocumentRead {
    /// The document. `null` when `error` is set.
    nlohmann::ordered_json root;
    /// Empty on success.
    std::string error;

    [[nodiscard]] bool ok () const {
        return error.empty ();
    }
};

/**
 * @brief Read a stored document's text (JSON or YAML) into a DOM.
 *
 * JSON is tried first and YAML second, which is the order `parse-raw.ts` reads
 * the same bytes in - a JSON document must not depend on a YAML parser's
 * opinion of it, and JSON is what most stored documents are.
 *
 * **Bounded by the input's own size.** The DOM may hold at most
 * `spec_document::READ_NODES_FLOOR` nodes plus one per byte of @p text, capped
 * at `spec_document::MAX_READ_NODES`, and may nest at most
 * `spec_document::MAX_READ_DEPTH` deep. A budget proportional to the input is
 * the shape of the attack it refuses: YAML aliases are the only way a document
 * expands past its own size, so the "billion laughs" document - 300 bytes that
 * resolve to half a million nodes - is refused in milliseconds while every
 * honest document passes with room to spare. Measured rather than assumed:
 * rapidyaml's own `Tree::resolve()` dies of `std::bad_alloc` on that input,
 * which is why this reader expands aliases itself, and walking the same bytes
 * with the budget removed costs 7.9 seconds and gigabytes before answering.
 */
[[nodiscard]] DocumentRead read_document (const std::string& text);

/**
 * @brief Write a DOM back out as YAML, in block style.
 *
 * The other half of `read_document`, and it lives beside it because the two
 * share one rule: **a string is quoted exactly when writing it plainly would
 * read back as something else.** The reader's `plain_scalar` decides what an
 * unquoted scalar means, so the writer asks it - a value it would retype
 * (`2.0`, `007`, `true`, `null`, ``) is double-quoted, and so is a mapping key
 * with the same problem. Splitting these two across translation units is how a
 * document would export as `swagger: 2.0` and re-import as a number.
 *
 * Deliberately not rapidyaml's emitter: its tree holds no opinion about which
 * scalars need quoting, so it would write back whatever it was handed. What it
 * does share with js-yaml's `dump`, which this replaces on the export path, is
 * that comments and anchors do not survive - both expand aliases on the way in.
 */
[[nodiscard]] std::string emit_yaml (const nlohmann::ordered_json& document);

/**
 * @brief Every operation @p document declares, in document order.
 *
 * The rules are the import parsers' rules, because the identity this produces
 * has to be the identity a request carries - the two are compared by coverage
 * (`OperationIndex::resolve`) and by the sync diff:
 *
 * - **2.0 and 3.x**, told apart the way the parsers detect them (`openapi`
 *   starting `3.`, `swagger` being `2.0`). Anything else declares nothing:
 *   a Postman export stored here is not a contract, and saying it declares
 *   zero operations is the honest answer rather than an error.
 * - **`paths` in document order**, each path item resolved through a single
 *   `$ref` hop - the shape a bundler emits when it hoists a shared path item
 *   into `components.pathItems`, and one whose absence drops every operation
 *   under that path.
 * - **The seven methods Vayu executes** (`get post put patch delete head
 *   options`), in that order, which is the order the parsers walk them in and
 *   therefore the order the rows are written in. `trace` is skipped: Vayu has
 *   no verb for it, so no request can ever carry that identity.
 * - **A path that does not start with `/`** declares no operation. It is a
 *   malformed `paths` key, and the request an import builds for it carries no
 *   identity either.
 * - **A repeated `operationId` is kept on its first declaration only** (issue
 *   #715). The later operation keeps the identity it can still state
 *   unambiguously - its method and path - because an id that names two
 *   operations resolves to whichever row was written first, and a sync would
 *   then rewrite the second request toward an operation it never was.
 * - **`responses` keys verbatim**, in document order, empty keys dropped.
 *   Patterns, not codes: `2XX` and `default` are what the document declares.
 */
[[nodiscard]] std::vector<DeclaredOperation>
declared_operations_of (const nlohmann::ordered_json& document);

/**
 * @brief The response schemas @p document declares, as JSON Schema (issue
 *        #860), or `null` when it declares none.
 *
 * The index `spec_documents.response_schemas` stores: `refRoots` (absent when
 * the document has none) beside an `operations` array whose rows carry the same
 * identity `declared_operations_of` produces and a `responses` list of
 * `{status, contentType, schema}`. An operation declaring no schema has no row,
 * and a document where none does has no index at all - "no index" and "declares
 * nothing" are one state in storage, and the honest reading of a document
 * nothing was extracted from is the first: a response of it reports
 * `checked: false`, never a body that passed.
 *
 * Two jobs, and the second is the one that cannot be skipped:
 *
 * 1. **Find** each operation's schemas, in either dialect - 3.x's
 *    `responses[status].content[type].schema`, 2.0's `responses[status].schema`
 *    paired with the operation's `produces` (falling back to the document's,
 *    then to `application/json`). A response that is itself a `$ref` is read
 *    through, one hop (issue #714): GitHub's public spec declares nearly every
 *    response that way, and reading the `$ref` node unresolved finds no
 *    `content`, so the engine would report "no schema for this status" about a
 *    status the same document declares plainly two lines above.
 * 2. **Translate** them out of OpenAPI 3.0's dialect, which is *not* JSON
 *    Schema. `nullable: true` means "or null" and no validator has heard of it,
 *    so a null the document explicitly permits would be reported as a type
 *    failure - a **wrong** verdict, which is worse than no verdict.
 *    `exclusiveMinimum: true` is draft-04's spelling and means something else
 *    entirely in draft-07. `discriminator`, `xml`, `externalDocs` and `example`
 *    are documentation or serialization and constrain no body, so they are
 *    dropped rather than passed to a validator that would ignore them anyway.
 *
 * **`$ref`s are kept as written**, never followed: inlining duplicates a shared
 * `Error` schema into every operation naming it, and a recursive schema has no
 * finite expansion at all. What they point into is carried once per document as
 * `refRoots` - the `components.schemas`, `definitions` and `x-vayu-bundled`
 * subtrees, each translated by the same rules, since a `$ref`-ed 3.0 schema is
 * as full of `nullable` as an inline one. `core/schema_validation.hpp` merges
 * the two back into one validation root.
 */
[[nodiscard]] nlohmann::ordered_json
response_schemas_of (const nlohmann::ordered_json& document);

/**
 * One row of a draft request's key/value table: a query parameter, a header, or
 * a form-body field.
 *
 * The fields the sync diff compares a stored request's rows against, and no
 * others - `description` because a document that re-words what a parameter
 * means has changed the row Vayu shows, `file` because a multipart part the
 * document declares as an upload is a different row from a text one even when
 * both are empty (issue #425).
 */
struct DraftField {
    std::string key;
    std::string value;
    /**
     * A spec's parameter list declares what the endpoint *accepts*, not what
     * every request should *send* (issues #622, #658): an optional parameter
     * with no declared value imports **disabled**, one click from use and off
     * the wire. Only `required: true` or a declared value turns it on.
     */
    bool enabled = true;
    /// Query rows only. The Headers table has no column for one, so a header
    /// row carries none rather than a field nothing reads.
    std::string description;
    /// A multipart part the document declares as an upload (`format: binary`,
    /// or 2.0's `type: file`). The part imports with no path attached.
    bool file = false;
};

/**
 * One saved example response an import writes for a documented response (issue
 * #481), in the shape `request_examples` stores.
 *
 * Carried on a draft although the sync diff does not compare examples (#654):
 * applying a change *writes* them - the document's responses replace the rows a
 * previous import or sync left - so a draft without them would make an engine
 * answer that an apply cannot be built from, which is what put the parse back
 * in the renderer.
 */
struct DraftExample {
    /// `"200 - A user"` when the response is described, `"200"` when it is not.
    std::string name;
    /// The status the example documents. Only a numeric 100-599 key becomes one:
    /// `default` and `2XX` have no status line to be served under.
    int status = 200;
    /**
     * Whether the document states a payload for this response.
     *
     * Distinct from an empty @ref body or @ref content_type, both of which a
     * documented response may legitimately have: it is what decides whether the
     * stored row carries a `Content-Type` header at all. A `204 No Content`
     * documents nothing and still imports, because a mock server has to be able
     * to answer with it.
     */
    bool documented = false;
    /// The media type the payload is in, `""` when nothing is documented.
    std::string content_type;
    /// The payload as text - a documented string verbatim, anything else as
    /// `JSON.stringify(value, null, 2)` writes it.
    std::string body;
};

/// A draft request's body, in the shape `requests.body` stores.
struct DraftBody {
    /// `none`, `json`, `text`, `form-data` or `x-www-form-urlencoded`.
    std::string mode = "none";
    /// The `json` / `text` payload, and `""` for the form and `none` modes.
    std::string content;
    /// The form modes' fields, empty for every other mode.
    std::vector<DraftField> fields;
};

/**
 * The request an import of this document would build for one operation.
 *
 * Not an identity: `DeclaredOperation` says *which* operation this is, and this
 * says what a request for it looks like - which is what makes "the spec changed
 * this request" answerable without a second opinion about what the document
 * means. The first seven fields are exactly the ones the sync diff compares
 * (issue #654); a request's auth and scripts are deliberately absent, because an
 * import writes one value for every operation and a difference there is always
 * the user's.
 *
 * @ref examples is the one member the diff does not compare and an apply still
 * needs - see `DraftExample`.
 */
struct DraftRequest {
    std::string name;
    std::string description;
    /// Upper-case, as the request stores it.
    std::string method;
    /// `{{baseUrl}}` plus the templated path with its `{param}`s rewritten as
    /// `{{param}}`, plus whatever enabled query rows append to it.
    std::string url;
    std::vector<DraftField> params;
    std::vector<DraftField> headers;
    DraftBody body;
    /// The operation's documented responses, in document order.
    std::vector<DraftExample> examples;
};

/// One operation, the request an import would build for it, and where an import
/// would file that request.
struct SpecRequestDraft {
    DeclaredOperation operation;
    DraftRequest draft;
    /**
     * The sub-collection an import files this operation under - its first tag,
     * else the folder its path names (issue #710) - and `""` for an operation
     * that gets neither, which imports onto the root (issue #655).
     *
     * A name rather than a reference: the tag collection an *added* operation
     * needs may already exist under the bound collection, and matching it by
     * the name the parser gave it is what tells those two cases apart.
     */
    std::string folder;
};

/**
 * @brief The requests an import of @p document would build, in document order
 *        (issue #865).
 *
 * The third thing derived from the walk `declared_operations_of` and
 * `response_schemas_of` share, and derived from it for the same reason: a draft
 * whose identity disagreed with the index would describe a change to an
 * operation the document does not declare.
 *
 * **This is the import parsers' answer, not a second one.** Every rule the
 * renderer's `openapi-v3.ts` / `openapi-v2.ts` learned the hard way is here
 * because the sync diff compares a stored request against a draft, so a draft
 * this side builds differently is a field reported as changed when only the two
 * readers differ:
 *
 * - **2.0 and 3.x told apart the way the parsers detect them**, and read the
 *   way each dialect writes: 2.0 states a parameter's value as `default` and
 *   puts the body in a `body` / `formData` parameter, 3.x has `example` /
 *   `examples` and a `requestBody` under a media type.
 * - **A path item's `parameters` are merged with the operation's**, keyed by
 *   `in` and `name`, the operation's winning in the path item's position.
 * - **`in: "path"` is not a row** - it is already carried, as the `{{var}}` the
 *   URL was rewritten with - and `in: "cookie"` is dropped, since a request's
 *   cookies come from the jar (issue #719). `Authorization` and `Content-Type`
 *   headers are dropped too: both are produced by the request's own auth and
 *   body rather than typed into a row.
 * - **The body is sampled from its schema** when the document documents no
 *   example, by `$ref`-following, depth-capped, first-branch-of-`allOf` rules
 *   that have to match the renderer's sampler exactly - the sample *is* the
 *   compared value, so a different sampler is a different draft for an
 *   unchanged document.
 * - **The folder is where an import would have put it**: first tag, else the
 *   first path segment that names a resource, else the root.
 * - **Each documented response becomes a saved example** (issue #481), by the
 *   same precedence the request body follows - the media type's `example`, else
 *   the first entry of its `examples` map, else a sample of its schema - and a
 *   response documenting no payload still becomes one, because `204 No Content`
 *   is an answer a mock server has to be able to give.
 *
 * `$ref`s are followed **in-document only**, which is a guarantee rather than a
 * gap: external ones are inlined into `x-vayu-bundled` before a document is
 * ever stored, so a ref still external by now is one the user has already been
 * told about, and it resolves to nothing on both sides alike.
 *
 * Pinned to the renderer's parsers by
 * `tests/fixtures/spec-request-drafts-conformance.json`, read by
 * `openapi_drafts_test.cpp` and by the app's
 * `spec-request-drafts.conformance.test.ts`.
 */
[[nodiscard]] std::vector<SpecRequestDraft>
spec_request_drafts_of (const nlohmann::ordered_json& document);

/**
 * Both indexes a stored document carries, or why it has neither.
 *
 * Each is the JSON text its column takes and `""` for a document that declares
 * nothing of that kind - which stores as "no index" rather than as an empty
 * contract, the distinction a coverage block and a validation verdict both rest
 * on.
 */
struct SpecIndexes {
    /// `spec_documents.operations` (issue #629).
    std::string operations;
    /// `spec_documents.response_schemas` (issue #628).
    std::string response_schemas;
    /// Empty on success; otherwise the caller-facing `400` sentence.
    std::string error;

    [[nodiscard]] bool ok () const {
        return error.empty ();
    }
};

/**
 * @brief Derive both stored indexes from a document's text.
 *
 * The whole of what a write path does with a document, in one call: read it
 * **once**, ask what it declares, refuse a document declaring more operations
 * than a run may carry in memory (`spec_document::MAX_OPERATIONS`) or a schema
 * index over @p index_cap bytes, and serialize both. Every route that stores a
 * document goes through this rather than through three arrangements of the same
 * steps - `POST /specs`, `POST /specs/sync` and `POST /import/apply` differ in
 * what else they write, never in what a document declares.
 *
 * One read for both is not an optimisation: the two indexes describe the same
 * operations, and a response the schema index carries for a status the
 * operation index does not list would be a contract disagreeing with itself.
 *
 * @param index_cap Bytes the serialized schema index may occupy -
 *        `maxSpecDocumentBytes`, the same number the document itself is held
 *        to rather than a second knob, because the two are stored together and
 *        grow together.
 */
[[nodiscard]] SpecIndexes derive_spec_indexes (const std::string& text, size_t index_cap);

} // namespace vayu::core
