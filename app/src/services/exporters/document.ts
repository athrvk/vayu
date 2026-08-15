/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The bound direction of export (issue #630): a collection's own document,
 * updated in place.
 *
 * The stored bytes are parsed and *patched*, never rebuilt. Everything Vayu does
 * not model - `info`, `tags`, vendor extensions, `security`, components no
 * operation here references - is carried through untouched, because it is
 * carried through by simply not being visited. That is the whole reason this
 * direction exists: a rebuilt document would be Vayu's opinion of the user's
 * contract, and the parts it has no opinion about would quietly disappear.
 *
 * What it does write:
 *
 * - **Presence.** An operation the collection no longer has is removed; a path
 *   left with no operations goes with it. This is what makes a re-import of the
 *   exported document produce the collection it came from.
 * - **Parameter values.** A declared parameter whose request row carries a value
 *   gets that value as its `example`. A blank row writes nothing - an import
 *   creates blank header rows, and a blank one deleting the document's example
 *   would lose the contract's own documentation to a row nobody typed in.
 * - **Examples.** Stored examples become the operation's response examples, both
 *   origins (see `ExportRequest.examples`).
 *
 * The dialect is never changed: a 3.0 document exports as 3.0, a 2.0 document as
 * 2.0. For 2.0 the presence pass still runs, but nothing is written into an
 * operation - parameters and examples are a different vocabulary there, and half
 * a translation is a file that is neither dialect.
 */

import { asArray, asRecord, asStr, prop, type JsonRecord } from "@/lib/json-node";
import { parseRaw } from "@/services/importers/parse-raw";
import { childRecord, writeResponseExamples } from "./examples";
import { emptyNotes, SpecDocumentError, type ExportNotes, type ExportRequest } from "./openapi";

/** The method keys a Path Item Object may carry - OpenAPI defines exactly these. */
const PATH_ITEM_METHODS = [
	"get",
	"put",
	"post",
	"delete",
	"options",
	"head",
	"patch",
	"trace",
] as const;

export interface PatchedDocument {
	document: unknown;
	notes: ExportNotes;
}

export function patchBoundDocument(
	content: string,
	requests: readonly ExportRequest[]
): PatchedDocument {
	const document = parseStoredDocument(content);
	const dialect = readDialect(document);
	const notes = emptyNotes("document", dialect.label);
	notes.vocabularyNotWritten = !dialect.writable;

	const byOperationId = new Map<string, ExportRequest>();
	const byMethodPath = new Map<string, ExportRequest>();
	for (const entry of requests) {
		const identity = entry.request.specOperation;
		if (!identity) continue;
		if (identity.operationId && !byOperationId.has(identity.operationId)) {
			byOperationId.set(identity.operationId, entry);
		}
		const key = methodPathKey(identity.method, identity.path);
		if (!byMethodPath.has(key)) byMethodPath.set(key, entry);
	}

	const claimed = new Set<ExportRequest>();
	/*
	 * Paths whose Path Item is itself a `$ref` (legal in 3.0/3.1, and what a
	 * bundler emits when it hoists a shared item into `components.pathItems`).
	 * Its methods are not readable from here without following the ref and
	 * mutating a node other paths may share, so such an item is left exactly as
	 * it is - and a request that names one of those paths is reported as carried
	 * rather than as missing, which is what it is.
	 */
	const referencedPaths = new Set<string>();
	const paths = asRecord(prop(document, "paths")) ?? {};

	for (const [pathKey, rawItem] of Object.entries(paths)) {
		const pathItem = asRecord(rawItem);
		if (!pathItem) continue;
		if (asStr(pathItem.$ref)) {
			referencedPaths.add(pathKey);
			continue;
		}
		for (const method of PATH_ITEM_METHODS) {
			const operation = asRecord(pathItem[method]);
			if (!operation) continue;
			const entry = findRequest(operation, method, pathKey, byOperationId, byMethodPath);
			if (!entry) {
				delete pathItem[method];
				notes.operationsRemoved += 1;
				continue;
			}
			claimed.add(entry);
			notes.requestsExported += 1;
			if (dialect.writable) patchOperation(operation, entry, notes);
		}
		if (!PATH_ITEM_METHODS.some((method) => pathItem[method] !== undefined)) {
			delete paths[pathKey];
		}
	}

	for (const entry of requests) {
		if (claimed.has(entry)) continue;
		const identity = entry.request.specOperation;
		if (!identity) notes.requestsWithoutOperation += 1;
		else if (referencedPaths.has(identity.path)) notes.requestsExported += 1;
		else notes.operationsNotInDocument += 1;
	}

	return { document, notes };
}

function parseStoredDocument(content: string): JsonRecord {
	let parsed: unknown;
	try {
		parsed = parseRaw(content);
	} catch (error) {
		throw new SpecDocumentError(
			`The stored document could not be parsed: ${(error as Error).message}`
		);
	}
	const record = asRecord(parsed);
	if (!record) throw new SpecDocumentError("The stored document is not an OpenAPI object.");
	return record;
}

interface Dialect {
	label: string;
	/** Whether Vayu writes this vocabulary, or only removes from it. */
	writable: boolean;
}

function readDialect(document: JsonRecord): Dialect {
	const openapi = asStr(document.openapi);
	if (openapi) return { label: `OpenAPI ${openapi}`, writable: true };
	const swagger = asStr(document.swagger);
	if (swagger) return { label: `Swagger ${swagger}`, writable: false };
	throw new SpecDocumentError(
		"The stored document declares neither `openapi` nor `swagger`, so it is not one Vayu can update."
	);
}

/**
 * The request this operation is, by the identity phase 1 stamped.
 *
 * `operationId` first and method+path second, the same precedence sync (#627)
 * will diff by: an id is the document's own stable name for an operation and
 * survives a path change, while a path survives a rename of the id.
 */
function findRequest(
	operation: JsonRecord,
	method: string,
	pathKey: string,
	byOperationId: Map<string, ExportRequest>,
	byMethodPath: Map<string, ExportRequest>
): ExportRequest | undefined {
	const operationId = asStr(operation.operationId);
	const byId = operationId ? byOperationId.get(operationId) : undefined;
	return byId ?? byMethodPath.get(methodPathKey(method, pathKey));
}

function methodPathKey(method: string, path: string): string {
	return `${method.toUpperCase()} ${path}`;
}

function patchOperation(operation: JsonRecord, entry: ExportRequest, notes: ExportNotes): void {
	patchParameters(operation, entry, notes);
	writeExamples(operation, entry, notes);
}

function patchParameters(operation: JsonRecord, entry: ExportRequest, notes: ExportNotes): void {
	for (const raw of asArray(operation.parameters)) {
		const parameter = asRecord(raw);
		if (!parameter) continue;
		if (asStr(parameter.$ref)) {
			notes.sharedParametersLeft += 1;
			continue;
		}
		const name = asStr(parameter.name);
		if (!name) continue;
		const rows =
			parameter.in === "query"
				? entry.request.params
				: parameter.in === "header"
					? entry.request.headers
					: undefined;
		if (!rows) continue;
		const row = rows.find((r) => r.key.toLowerCase() === name.toLowerCase());
		if (!row || !row.value) continue;
		parameter.example = row.value;
	}
}

function writeExamples(operation: JsonRecord, entry: ExportRequest, notes: ExportNotes): void {
	if (entry.examples.length === 0) return;
	// `deriveSchema: false` - a bound document already states what its responses
	// look like, and a shape read off one stored body is not an improvement on
	// the contract's own schema.
	writeResponseExamples(childRecord(operation, "responses"), entry.examples, notes, {
		deriveSchema: false,
	});
}
