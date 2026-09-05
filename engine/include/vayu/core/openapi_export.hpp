#pragma once

/*
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the AGPL v3 license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * @file core/openapi_export.hpp
 * @brief A collection back out as an OpenAPI document (issue #630, moved
 *        engine-side by #855 - #761's phase B, move 3).
 *
 * The assembly was the renderer's until the engine could read a document at all
 * (#853). It moved for the reason every other half of phase B moved: an agent
 * cannot reach a function in the renderer, so `export_spec` could not be an MCP
 * tool while the ~900 lines that build the document lived there. Now the
 * document is put together beside the bytes it is built from - `spec_documents`
 * holds the stored text and `requests.spec_operation` says which operation each
 * request is - and `POST /specs/export` is the one way to ask for it.
 *
 * **Two directions, and which one runs is not a setting.** A collection bound to
 * a spec exports *its own document*, updated: the stored bytes read, the
 * operations Vayu still has kept, the ones it no longer has removed, examples
 * written back, and every member Vayu does not model left exactly where it was.
 * A free-form collection has no document to update, so it exports a skeleton -
 * an honest description of the requests that are there, with no schema Vayu did
 * not read off an example body and no `securityScheme`, `tag` or server
 * variable it never saw.
 *
 * The one thing both directions refuse is invention. A skeleton is "a starting
 * point, not a contract" and the dialog says so; a bound export never adds an
 * operation the document did not declare, because a request with no operation
 * identity is a request the contract never described - it is counted and named
 * instead (see `ExportNotes`).
 *
 * `{{variable}}` tokens are written as they stand, in `servers` and in paths
 * alike. They are the portable form: resolving `{{baseUrl}}` here would export
 * one machine's environment as though the contract named it.
 */

#include "vayu/core/openapi_document.hpp"

#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

namespace vayu::core {

/** The serialization the caller asked for. */
enum class ExportFormat : std::uint8_t { Json, Yaml };

/** One Params or Headers row, as the exporter reads it. */
struct ExportKeyValue {
    std::string key;
    std::string value;
    std::string description;
};

/**
 * A request's body, in the stored vocabulary (`mode` plus one of `content` /
 * `fields`) rather than a translated one - which media type it becomes and
 * whether it becomes anything at all is this file's decision to make.
 */
struct ExportBody {
    std::string mode;
    std::string content;
    /// Form field names, in order. Only the names: a skeleton declares that the
    /// endpoint takes a field, never that one machine's value for it is the
    /// contract's example.
    std::vector<std::string> field_keys;
};

/** One stored example response of a request. */
struct ExportExample {
    std::string name;
    int status = 200;
    std::string body;
    /// Denormalized from the stored headers by whoever wrote the row; `""` when
    /// nobody recorded one, which is a state this export has an answer for.
    std::string content_type;
    /// The stored body is only the first slice of the response it was saved
    /// from (issue #659).
    bool body_truncated = false;
    /**
     * Whether the spec import wrote this row rather than a person
     * (`request_examples.origin`, #588).
     *
     * The bound direction reads it to tell an example the document *declares*
     * from one the import *sampled off a schema*: an imported example exists
     * because the import read this media object, so a media object that
     * declares no example at all is one the import sampled. Writing that sample
     * back would document a value the API never stated. `false` is the safe
     * default - an example nobody attributed to the import is new information,
     * which is what this export has always written.
     */
    bool from_import = false;
    /**
     * The map key the import took this example from, if any
     * (`request_examples.spec_example_key`, issue #1457).
     *
     * A value comparison alone cannot tell an edited example from a new one:
     * once the body has changed it no longer equals the entry it came from,
     * so it read as news to the document and was added beside that entry
     * rather than replacing it. This key, when the document still names it,
     * says which entry to write into instead of adding a new one.
     */
    std::optional<std::string> spec_example_key = std::nullopt;
};

/** The identity a request carries, when it carries one (`spec_operation`). */
struct ExportOperationIdentity {
    std::string operation_id;
    std::string method;
    /// The path *template* (`/pets/{petId}`), never a concrete URL.
    std::string path;
};

/** One request and the examples stored against it, as the exporter reads them. */
struct ExportRequest {
    std::string name;
    std::string description;
    std::string method;
    /// The URL as written, `{{baseUrl}}` and all - never a resolved one.
    std::string url;
    std::vector<ExportKeyValue> params;
    std::vector<ExportKeyValue> headers;
    ExportBody body;
    std::optional<ExportOperationIdentity> spec_operation;
    /**
     * Every stored example, both origins. Import-derived and user-saved
     * examples both flow back into the document: export is where a response
     * somebody kept from a real send becomes part of the contract, which is the
     * whole reason `origin` (#588) does not gate this side.
     */
    std::vector<ExportExample> examples;
};

/** What a skeleton names the API after. */
struct ExportCollection {
    std::string name;
    std::string description;
};

/**
 * What the export could not carry, and what it changed.
 *
 * Every field is shown to the user before they download. A count of zero is a
 * statement too - "0 requests with no operation" is how a bound export says it
 * carried everything - so these are always present rather than optional.
 */
struct ExportNotes {
    /// `document` updated the bound spec; `skeleton` described a free-form
    /// collection.
    std::string direction;
    /// What the exported document declares itself to be - `OpenAPI 3.0.3`,
    /// `Swagger 2.0`.
    std::string dialect;
    /// Requests that became, or stayed, an operation in the output.
    int requests_exported = 0;
    /**
     * Requests with no operation identity, in a bound export. Not written: a
     * document must not gain an operation from a request the contract never
     * described. Bind or sync the collection to give them one.
     */
    int requests_without_operation = 0;
    /**
     * Requests whose identity names an operation the stored document no longer
     * declares - a spec that changed under the collection. Not written, for the
     * same reason.
     */
    int operations_not_in_document = 0;
    /// Operations the document declared that no request claims - removed from
    /// the output.
    int operations_removed = 0;
    /// Requests whose URL states no path at all, in a skeleton export - left out.
    int requests_without_path = 0;
    /// Requests that reduced to a method and path another request already
    /// claimed - left out.
    int duplicate_operations = 0;
    /// Examples written into the document as `example` / `examples`.
    int examples_written = 0;
    /**
     * Examples whose stored media type is empty. There is no honest `content`
     * key for a body whose type nobody stated, so the body is left out rather
     * than filed under a guessed one.
     */
    int examples_without_media_type = 0;
    /**
     * Examples whose stored body is only the first slice of the response it was
     * saved from. The response is written, the body is not: a partial body
     * written as an `example` is indistinguishable from a complete one, and a
     * contract that documents half a payload as the payload is worse than one
     * that documents none.
     */
    int examples_truncated = 0;
    /**
     * Stored examples the document already declares the same value for -
     * nothing to write. An import took its examples out of this document, so
     * an unedited spec-origin collection exports with every one of them here
     * and none in `examples_written`, which is how this export says it changed
     * nothing.
     */
    int examples_already_declared = 0;
    /**
     * Imported examples the document declares no example for. The import
     * sampled them off the response's schema, and an export that wrote one back
     * would put a value in the contract that the API never stated - as though
     * the document had always documented it.
     */
    int examples_sampled_at_import = 0;
    /**
     * `$ref` parameters left exactly as they were. A shared parameter belongs
     * to every operation that names it, so writing one request's value into it
     * would edit the contract for operations this collection may not even have.
     */
    int shared_parameters_left = 0;
    /**
     * `$ref` responses left exactly as they were, for both of a Reference
     * Object's reasons: it admits no siblings in 3.0, so a `content` written
     * beside one is ignored by conformant readers and rejected by validators,
     * and the component it names is shared with every operation that references
     * it. The sibling of `shared_parameters_left`.
     */
    int referenced_responses_left = 0;
    /**
     * Requests carrying a body, in a bound export - not written. The bound
     * direction patches parameters and examples: a document's `requestBody` is
     * its schema, and a body somebody typed into Vayu is one machine's payload,
     * not a new contract.
     */
    int bodies_not_written = 0;
    /**
     * Params or Headers rows carrying a value that the operation declares no
     * parameter for - not written. A value goes into the parameter the document
     * declares; a row added in Vayu would have the export declare a parameter
     * the contract does not have.
     */
    int rows_not_declared = 0;
    /**
     * Requests whose method or path no longer matches the operation they are
     * stamped as. Their values still land, in the operation the document
     * declares - moving or renaming an operation is an edit to the contract,
     * which this export does not make.
     */
    int operations_edited = 0;
    /**
     * True for a Swagger 2.0 document: operations Vayu no longer has are
     * removed, but nothing is written *into* an operation. 2.0 states
     * parameters and examples in a different vocabulary, and writing 3.x shapes
     * into a 2.0 document would produce a file that is neither.
     */
    bool vocabulary_not_written = false;
};

/**
 * The exported document, or the sentence saying why the stored one could not be
 * updated. Never both.
 */
struct ExportOutcome {
    /// The document, serialized in the requested format.
    std::string text;
    /// What a download should be called.
    std::string file_name;
    ExportNotes notes;
    /**
     * Empty on success. Set when a bound collection's stored document cannot be
     * read or is not one Vayu can claim to be updating - and the export fails
     * rather than falling back to a skeleton, because a skeleton silently
     * substituted for the document the user believes they are updating would
     * drop every member of their spec Vayu does not model.
     */
    std::string error;

    [[nodiscard]] bool ok () const {
        return error.empty ();
    }
};

/**
 * @brief Assemble @p collection's requests into an OpenAPI document.
 *
 * @param spec_content The bound document exactly as the engine stored it, or
 *        `std::nullopt` for a collection bound to none. Its presence is what
 *        picks the direction.
 */
[[nodiscard]] ExportOutcome export_openapi (const ExportCollection& collection,
const std::vector<ExportRequest>& requests,
const std::optional<std::string>& spec_content,
ExportFormat format);

/** `ExportNotes` as the route answers with it - every count, zeros included. */
[[nodiscard]] nlohmann::json export_notes_json (const ExportNotes& notes);

} // namespace vayu::core
