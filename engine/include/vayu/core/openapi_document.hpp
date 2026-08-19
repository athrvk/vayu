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
 * 2. **`declared_operations_of`** answers what the document declares, which is
 *    an OpenAPI question and not a YAML one.
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
 * The `spec_documents.operations` index for a document, or why it has none.
 *
 * `stored` is the JSON text the column takes, `""` for a document that declares
 * no operation - which stores as "no index" rather than as an empty contract,
 * the distinction a coverage block rests on.
 */
struct OperationsIndex {
    std::string stored;
    /// Empty on success; otherwise the caller-facing `400` sentence.
    std::string error;

    [[nodiscard]] bool ok () const {
        return error.empty ();
    }
};

/**
 * @brief Derive the stored `operations` index from a document's text.
 *
 * The whole of what a write path does with a document, in one call: read it,
 * ask what it declares, refuse a document declaring more operations than a run
 * may carry in memory (`spec_document::MAX_OPERATIONS`), and serialize the
 * index. Every route that stores a document goes through this rather than
 * through three arrangements of the same steps - `POST /specs`,
 * `POST /specs/sync` and `POST /import/apply` differ in what else they write,
 * never in what a document declares.
 */
[[nodiscard]] OperationsIndex derive_operations_index (const std::string& text);

} // namespace vayu::core
