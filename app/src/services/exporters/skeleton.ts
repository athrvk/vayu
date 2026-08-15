/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The free-form direction of export (issue #630): a collection that was never a
 * spec, described as one.
 *
 * **A starting point, not a contract**, and the UI says exactly that. Everything
 * written here is something the collection actually holds - a request's method
 * and URL, the rows in its Params and Headers tables, the body it sends, the
 * examples stored against it. Nothing is inferred about the endpoint: no
 * `required` on a parameter the user merely enabled, no `securitySchemes` read
 * off an auth block whose secrets are not the contract's business, no response
 * for a status nobody saved an example of, and above all no request or response
 * schema that was not read off an example body (see `payload.ts`).
 *
 * `{{variable}}` tokens survive as they are. A URL beginning `{{baseUrl}}`
 * exports a `servers` entry of `{{baseUrl}}` - the portable form, and the same
 * one an import writes back into a URL. Resolving it here would bake one
 * machine's environment into a document meant to be shared.
 *
 * Path parameters are recovered from the URL: a segment that is a single
 * `{{petId}}` token is the OpenAPI `{petId}` it came from, and it is declared as
 * a required path parameter, because a path template says the segment is there
 * whether or not anybody typed a value.
 */

import type { Collection, KeyValueEntry, Request, RequestExample } from "@/types";
import type { JsonRecord } from "@/lib/json-node";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { splitRequestUrl } from "@/services/openapi/operation-match";
import { writeResponseExamples } from "./examples";
import { emptyNotes, type ExportNotes, type ExportRequest } from "./openapi";
import { exampleValue, schemaFromExample } from "./payload";

/**
 * The dialect a skeleton is written in. 3.1 rather than 3.0 because it is the
 * current one and this document is new - there is no stored dialect to preserve,
 * which is the only reason the bound direction pins one.
 */
const SKELETON_VERSION = "3.1.0";

/**
 * `info.version` is required and a collection records none. `0.0.0` rather than
 * `1.0.0`: a version nobody chose should not read like a release.
 */
const PLACEHOLDER_VERSION = "0.0.0";

/**
 * Headers an operation does not declare as parameters. `Authorization` is
 * described by `security`, `Content-Type` by the request body's media type -
 * the same two the OpenAPI import drops on the way in, so a round trip does not
 * grow a parameter each time.
 */
const NON_PARAMETER_HEADERS = new Set(["authorization", "content-type"]);

export interface SkeletonDocument {
	document: JsonRecord;
	notes: ExportNotes;
}

export function skeletonDocument(
	collection: Collection,
	requests: readonly ExportRequest[]
): SkeletonDocument {
	const notes = emptyNotes("skeleton", `OpenAPI ${SKELETON_VERSION}`);
	const paths: JsonRecord = {};
	const servers: string[] = [];
	const claimed = new Set<string>();

	for (const entry of requests) {
		const { origin, path } = splitRequestUrl(entry.request.url);
		if (path === undefined) {
			notes.requestsWithoutPath += 1;
			continue;
		}
		const template = pathTemplate(path);
		const method = entry.request.method.toLowerCase();
		const key = `${method} ${template}`;
		if (claimed.has(key)) {
			// Two requests on the same method and path are one operation in a
			// document, and the second would silently replace the first.
			notes.duplicateOperations += 1;
			continue;
		}
		claimed.add(key);
		if (origin && !servers.includes(origin)) servers.push(origin);

		const item = (paths[template] as JsonRecord) ?? {};
		paths[template] = item;
		item[method] = operationObject(entry, template, notes);
		notes.requestsExported += 1;
	}

	const document: JsonRecord = {
		openapi: SKELETON_VERSION,
		info: {
			title: collection.name || "Untitled API",
			version: PLACEHOLDER_VERSION,
			...(collection.description ? { description: collection.description } : {}),
		},
		...(servers.length > 0 ? { servers: servers.map((url) => ({ url })) } : {}),
		paths,
	};
	return { document, notes };
}

function operationObject(entry: ExportRequest, template: string, notes: ExportNotes): JsonRecord {
	const { request } = entry;
	const parameters = [
		...pathParameters(template),
		...queryParameters(request.params),
		...headerParameters(request.headers),
	];
	const body = requestBodyObject(request);
	const responses = responsesObject(entry.examples, notes);

	return {
		...(request.name ? { summary: request.name } : {}),
		...(request.description ? { description: request.description } : {}),
		...(parameters.length > 0 ? { parameters } : {}),
		...(body ? { requestBody: body } : {}),
		...(responses ? { responses } : {}),
	};
}

/**
 * A request path with Vayu's tokens written the way OpenAPI writes them:
 * `/pets/{{petId}}` becomes `/pets/{petId}`.
 *
 * Only a segment that is *entirely* one token converts. A token inside a longer
 * segment (`/files/{{name}}.json`) is not a path parameter - OpenAPI has no
 * syntax for part of a segment - so it is left as it stands rather than turned
 * into a template the document cannot mean.
 */
function pathTemplate(path: string): string {
	return path
		.split("/")
		.map((segment) => {
			const name = wholeTokenName(segment);
			return name === undefined ? segment : `{${name}}`;
		})
		.join("/");
}

function wholeTokenName(segment: string): string | undefined {
	const match = new RegExp(`^${VARIABLE_PATTERN.source}$`).exec(segment);
	return match ? match[1].trim() : undefined;
}

/**
 * The `{name}` placeholders of the templated path, as required path parameters.
 *
 * `required: true` is not an inference: OpenAPI states that a path parameter is
 * always required, so this is the format's own rule rather than a claim about
 * this endpoint. The `string` schema is the same kind of minimum - a parameter
 * object must carry a schema, and a URL segment is text until something says
 * otherwise.
 */
function pathParameters(template: string): JsonRecord[] {
	const out: JsonRecord[] = [];
	for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
		out.push({
			name: match[1],
			in: "path",
			required: true,
			schema: { type: "string" },
		});
	}
	return out;
}

function queryParameters(rows: readonly KeyValueEntry[]): JsonRecord[] {
	return rows.filter((row) => row.key).map((row) => parameterObject(row, "query"));
}

function headerParameters(rows: readonly KeyValueEntry[]): JsonRecord[] {
	return rows
		.filter((row) => row.key && !NON_PARAMETER_HEADERS.has(row.key.toLowerCase()))
		.map((row) => parameterObject(row, "header"));
}

/**
 * One Params or Headers row as a parameter.
 *
 * A disabled row is still declared: the endpoint accepts it either way, and the
 * toggle says what this request sends, not what the API takes. For the same
 * reason `required` is never written from `enabled` - a user enabling a row is
 * not the API demanding it.
 */
function parameterObject(row: KeyValueEntry, location: "query" | "header"): JsonRecord {
	return {
		name: row.key,
		in: location,
		...(row.description ? { description: row.description } : {}),
		schema: { type: "string" },
		...(row.value ? { example: row.value } : {}),
	};
}

function requestBodyObject(request: Request): JsonRecord | undefined {
	const body = request.body;
	switch (body.mode) {
		case "json":
		case "jsonrpc": {
			if (!body.content.trim()) return undefined;
			return mediaTypeBody("application/json", exampleValue(body.content));
		}
		case "xml":
			// The text as it stands, never parsed: an XML body is not JSON, so the
			// value under `example` is the document itself.
			return body.content.trim() ? mediaTypeBody("application/xml", body.content) : undefined;
		case "graphql":
			// GraphQL over HTTP posts a JSON envelope, but the stored body is the
			// query text alone - Vayu composes the envelope at send time. Writing
			// the query as though it were the body would describe a request the
			// endpoint never receives, so this is left out and the operation keeps
			// its path, parameters and responses.
			return undefined;
		case "text":
			return body.content.trim() ? mediaTypeBody("text/plain", body.content) : undefined;
		case "form-data":
		case "x-www-form-urlencoded": {
			const fields = body.fields.filter((field) => field.key);
			if (fields.length === 0) return undefined;
			const properties: JsonRecord = {};
			for (const field of fields) properties[field.key] = { type: "string" };
			const contentType =
				body.mode === "form-data"
					? "multipart/form-data"
					: "application/x-www-form-urlencoded";
			return {
				content: {
					[contentType]: {
						// The field names are declared by the request itself, so this
						// schema states what the collection holds rather than a shape
						// read off one sample - it carries no derivation note.
						schema: { type: "object", properties },
					},
				},
			};
		}
		case "none":
			return undefined;
	}
}

function mediaTypeBody(contentType: string, value: unknown): JsonRecord {
	return {
		content: {
			[contentType]: {
				schema: schemaFromExample(value),
				example: value,
			},
		},
	};
}

/**
 * Stored examples as the operation's `responses`.
 *
 * `undefined` when there are none: an operation that documents no response is
 * legal in 3.1, and an invented `200 OK` would be the one claim this export is
 * most likely to be believed about.
 */
function responsesObject(
	examples: readonly RequestExample[],
	notes: ExportNotes
): JsonRecord | undefined {
	if (examples.length === 0) return undefined;
	const responses: JsonRecord = {};
	// `deriveSchema: true`, unlike the bound direction: there is no declared
	// schema here to defer to, and a shape read off the example - saying so in
	// its own description - is the most a skeleton may claim.
	writeResponseExamples(responses, examples, notes, { deriveSchema: true });
	return responses;
}
