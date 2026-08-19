/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A collection back out as an OpenAPI document (issue #630, phase 5 of #625).
 *
 * App-side assembly from what the engine already serves, the way `codegen`
 * builds a snippet: the engine owns the canonical collection, request and
 * example rows and gains no export route, and the document is put together here
 * from the same drafts vocabulary the importers speak in reverse.
 *
 * **Two directions, and which one runs is not a setting.** A collection bound to
 * a spec (#637/#638) exports *its own document*, updated - the stored bytes
 * parsed, the operations Vayu still has kept, the ones it no longer has removed,
 * examples written back, and every member Vayu does not model left exactly where
 * it was. A free-form collection has no document to update, so it exports a
 * skeleton: an honest description of the requests that are there, with no
 * schema Vayu did not read off an example body and no `securityScheme`,
 * `tag` or `server` variable it never saw.
 *
 * The one thing both directions refuse is invention. A skeleton is "a starting
 * point, not a contract" and says so in the UI; a bound export never adds an
 * operation the document did not declare, because a request with no operation
 * identity is a request the contract never described - it is counted and named
 * instead (see {@link ExportNotes}).
 *
 * `{{variable}}` tokens are written as they stand, in `servers` and in paths
 * alike. They are the portable form: resolving `{{baseUrl}}` here would export
 * one machine's environment as though the contract named it.
 */

import yaml from "js-yaml";

import type { Collection, Request, RequestExample } from "@/types";
import { patchBoundDocument } from "./document";
import { skeletonDocument } from "./skeleton";

export type ExportFormat = "json" | "yaml";

/** One request and the examples stored against it, as the exporter reads them. */
export interface ExportRequest {
	request: Request;
	/**
	 * Every stored example, both origins. Import-derived and user-saved examples
	 * both flow back into the document: export is where a response somebody kept
	 * from a real send becomes part of the contract, which is the whole reason
	 * `origin` (#588) does not gate this side.
	 */
	examples: readonly RequestExample[];
}

export interface OpenApiExportInput {
	/** The collection being exported - the root of the subtree. */
	collection: Collection;
	/** Every request beneath it, in tree order, with its examples. */
	requests: readonly ExportRequest[];
	/**
	 * The bound document exactly as the engine stored it, or absent for a
	 * collection bound to none. Its presence is what picks the direction.
	 */
	specContent?: string;
	format: ExportFormat;
}

/**
 * What the export could not carry, and what it changed.
 *
 * Every field is shown to the user before they download. A count of zero is a
 * statement too - "0 requests with no operation" is how a bound export says it
 * carried everything - so these are always present rather than optional.
 */
export interface ExportNotes {
	/** `document` updated the bound spec; `skeleton` described a free-form collection. */
	direction: "document" | "skeleton";
	/** What the exported document declares itself to be - `OpenAPI 3.0.3`, `Swagger 2.0`. */
	dialect: string;
	/** Requests that became, or stayed, an operation in the output. */
	requestsExported: number;
	/**
	 * Requests with no operation identity, in a bound export. Not written: a
	 * document must not gain an operation from a request the contract never
	 * described. Bind or sync the collection to give them one.
	 */
	requestsWithoutOperation: number;
	/**
	 * Requests whose identity names an operation the stored document no longer
	 * declares - a spec that changed under the collection. Not written, for the
	 * same reason.
	 */
	operationsNotInDocument: number;
	/** Operations the document declared that no request claims - removed from the output. */
	operationsRemoved: number;
	/** Requests whose URL states no path at all, in a skeleton export - left out. */
	requestsWithoutPath: number;
	/** Requests that reduced to a method and path another request already claimed - left out. */
	duplicateOperations: number;
	/** Examples written into the document as `example` / `examples`. */
	examplesWritten: number;
	/**
	 * Examples whose stored media type is empty. There is no honest `content`
	 * key for a body whose type nobody stated, so the body is left out rather
	 * than filed under a guessed one.
	 */
	examplesWithoutMediaType: number;
	/**
	 * Examples whose stored body is only the first slice of the response it was
	 * saved from (`bodyTruncated`, issue #659). The response is written, the body
	 * is not: a partial body written as an `example` is indistinguishable from a
	 * complete one, and a contract that documents half a payload as the payload
	 * is worse than one that documents none.
	 */
	examplesTruncated: number;
	/**
	 * `$ref` parameters left exactly as they were. A shared parameter belongs to
	 * every operation that names it, so writing one request's value into it
	 * would edit the contract for operations this collection may not even have.
	 */
	sharedParametersLeft: number;
	/**
	 * True for a Swagger 2.0 document: operations Vayu no longer has are removed,
	 * but nothing is written *into* an operation. 2.0 states parameters and
	 * examples in a different vocabulary, and writing 3.x shapes into a 2.0
	 * document would produce a file that is neither.
	 */
	vocabularyNotWritten: boolean;
}

export interface OpenApiExportResult {
	/** The document, serialized in the requested format. */
	text: string;
	/** What a download should be called. */
	fileName: string;
	notes: ExportNotes;
}

/** A stored document that cannot be parsed, or is not an object. */
export class SpecDocumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SpecDocumentError";
	}
}

export function emptyNotes(direction: ExportNotes["direction"], dialect: string): ExportNotes {
	return {
		direction,
		dialect,
		requestsExported: 0,
		requestsWithoutOperation: 0,
		operationsNotInDocument: 0,
		operationsRemoved: 0,
		requestsWithoutPath: 0,
		duplicateOperations: 0,
		examplesWritten: 0,
		examplesWithoutMediaType: 0,
		examplesTruncated: 0,
		sharedParametersLeft: 0,
		vocabularyNotWritten: false,
	};
}

/**
 * Assemble the document.
 *
 * @throws {SpecDocumentError} when a bound collection's stored document cannot
 * be read. Loudly, and not by falling back to a skeleton: a skeleton silently
 * substituted for a document the user believes they are updating would drop
 * every member of their spec Vayu does not model.
 */
export function exportOpenApi(input: OpenApiExportInput): OpenApiExportResult {
	const { document, notes } =
		input.specContent === undefined
			? skeletonDocument(input.collection, input.requests)
			: patchBoundDocument(input.specContent, input.requests);

	return {
		text: serialize(document, input.format),
		fileName: `${fileSlug(input.collection.name)}.openapi.${input.format}`,
		notes,
	};
}

function serialize(document: unknown, format: ExportFormat): string {
	if (format === "yaml") {
		// `noRefs`: js-yaml emits an anchor for any value it sees twice, and a
		// document full of `*ref_0` is valid YAML that reads as a mistake.
		return yaml.dump(document, { noRefs: true, lineWidth: 120 });
	}
	return `${JSON.stringify(document, null, 2)}\n`;
}

/** A collection name as a file name: lower case, one dash per run of anything else. */
function fileSlug(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "collection";
}
