/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The reference line: how the app names an entity to an agent (#2046).
 *
 * Every line is `Vayu <kind> "<name>" (<id>)` plus, for most kinds, a tail that
 * places the entity (` in <collection path>`) or describes it (` - <detail>`).
 * The name is for a person to recognise; the id is the key every MCP tool
 * takes. A kind that belongs to another entity (a variable, a spec operation, a
 * graphql operation, a run sample, an element, a threshold) names that owner in
 * its tail instead.
 * The grammar, every kind's example and the fixture the examples are
 * formatted from are in `docs/engine/mcp.md` ("Naming what the user means"),
 * which `agent-reference.docs.test.ts` holds to this file.
 *
 * **No value ever rides in a reference.** Each formatter takes a `Pick<>` of
 * exactly the fields it prints, so a URL's query or userinfo, a header, a body,
 * a variable's value or a token is not reachable from inside it, and a caller
 * handing over a whole entity cannot widen what is printed. A run's URL is
 * reduced to its path, the way a tab title is.
 *
 * Pure on purpose: no React, store or query import. The surfaces that put a
 * line on the clipboard resolve what the line names (a collection chain, a
 * collection's name) and pass it in.
 */

import { DEFAULT_REQUEST_NAME } from "@/constants/request";
import { formatInstant } from "@/lib/time-value";
import { pathLabel } from "@/lib/path-label";
import type {
	Collection,
	ElementDef,
	Environment,
	Inbox,
	InboxCapture,
	MockIssuer,
	MockServer,
	Request,
	RequestExample,
	Run,
	RunSample,
	RunSummary,
	SpecOperation,
	TrashEntry,
} from "@/types";

/** The words that follow `Vayu `, spelled once. */
export type ReferenceKind =
	| "request"
	| "example"
	| "collection"
	| "environment"
	| "run"
	| "run comparison"
	| "inbox"
	| "capture"
	| "mock server"
	| "mock issuer"
	| "trash entry"
	| "variable"
	| "spec operation"
	| "graphql operation"
	| "run sample"
	| "element"
	| "threshold";

/** Where a collection chain ends up in a line: `A / B`, the same as the breadcrumb. */
const PATH_SEPARATOR = " / ";

/**
 * A name as it sits between the line's double quotes: `"` and `\` escaped, a
 * line break collapsed to a space. A name is free text, and one that carried a
 * newline would start a second line the agent reads as a second reference.
 */
export function quoteName(name: string): string {
	return name
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/[\r\n\u2028\u2029]+/g, " ");
}

/** `variable "Name"`: the kinds with no id of their own are named by their label alone. */
function named(kind: string, name: string): string {
	return `${kind} "${quoteName(name)}"`;
}

/** `request "Name" (id)`: also how a line's tail names the owner it sits under. */
function entity(kind: string, name: string, id: string | number): string {
	return `${named(kind, name)} (${id})`;
}

function head(kind: ReferenceKind, name: string, id: string | number): string {
	return `Vayu ${entity(kind, name, id)}`;
}

/** ` in A / B`, or nothing at the root and when the chain is not loaded. */
function inPath(collectionPath: readonly string[]): string {
	return collectionPath.length > 0 ? ` in ${collectionPath.join(PATH_SEPARATOR)}` : "";
}

export function requestReference(
	request: Pick<Request, "id" | "name">,
	collectionPath: readonly string[]
): string {
	return `${head("request", request.name, request.id)}${inPath(collectionPath)}`;
}

export function exampleReference(
	example: Pick<RequestExample, "id" | "name">,
	request: Pick<Request, "id" | "name">,
	collectionPath: readonly string[]
): string {
	const owner = entity("request", request.name, request.id);
	return `${head("example", example.name, example.id)} of ${owner}${inPath(collectionPath)}`;
}

/** `parentPath` is the chain above the collection, not including it. */
export function collectionReference(
	collection: Pick<Collection, "id" | "name">,
	parentPath: readonly string[]
): string {
	return `${head("collection", collection.name, collection.id)}${inPath(parentPath)}`;
}

export function environmentReference(environment: Pick<Environment, "id" | "name">): string {
	return head("environment", environment.name, environment.id);
}

/** What a run line reads: the list row's fields, or the same fields off a loaded run. */
export type RunReferenceInput = Pick<Run, "id" | "type" | "status" | "startTime"> & {
	summary?: Pick<RunSummary, "requestName" | "method" | "url" | "scenario">;
};

const RUN_KIND_WORDS = {
	load: "load test",
	design: "design run",
	scenario: "collection run",
} as const satisfies Record<Run["type"], string>;

/**
 * The URL's path with nothing after it. `pathLabel` drops userinfo and query for
 * a URL that parses, but a templated host (`https://{{host}}/x?k=v`) does not
 * parse and its fallback keeps the query; a token in a query string must not
 * ride into a reference on that account.
 */
function pathOnly(url: string): string {
	return pathLabel(url)
		.replace(/[?#].*$/s, "")
		.replace(/[\r\n\u2028\u2029]+/g, " ");
}

/** `GET /orders`, or `""` for a run whose summary names neither. */
function methodAndPath(summary: RunReferenceInput["summary"]): string {
	const path = summary?.url ? pathOnly(summary.url) : "";
	return [summary?.method, path].filter(Boolean).join(" ");
}

/**
 * `collectionName` is the name of the collection a collection run ran, resolved
 * by the caller from the tree; the id stands in when it is not given (the
 * history row's own fallback), never a blank.
 */
export function runReference(run: RunReferenceInput, collectionName?: string): string {
	const scenario = run.summary?.scenario;
	const isCollectionRun = run.type === "scenario" || scenario !== undefined;
	const collection = collectionName ?? scenario?.collectionId;

	const target = isCollectionRun
		? collection
			? `collection "${quoteName(collection)}"`
			: ""
		: methodAndPath(run.summary);
	// The history row's rule: a still-default name says nothing, so the target does.
	const ownName = run.summary?.requestName?.trim();
	const title =
		ownName && ownName !== DEFAULT_REQUEST_NAME
			? ownName
			: isCollectionRun
				? collection
				: target;
	const details = [
		RUN_KIND_WORDS[run.type],
		target,
		formatInstant(run.startTime, "datetime"),
		run.status,
	];

	return `${head("run", title || RUN_KIND_WORDS[run.type], run.id)} - ${details.filter(Boolean).join(", ")}`;
}

/** Two runs by id, then each run's own line, so the agent needs no lookup to know what they are. */
export function runComparisonReference(base: RunReferenceInput, target: RunReferenceInput): string {
	return [
		`Vayu run comparison base (${base.id}) target (${target.id})`,
		runReference(base),
		runReference(target),
	].join("\n");
}

export function inboxReference(inbox: Pick<Inbox, "inboxId" | "port">): string {
	return head("inbox", `port ${inbox.port}`, inbox.inboxId);
}

export function captureReference(
	capture: Pick<InboxCapture, "id" | "inboxId" | "method" | "path">
): string {
	return `${head("capture", `${capture.method} ${capture.path}`, capture.id)} in inbox (${capture.inboxId})`;
}

export function mockServerReference(
	mock: Pick<MockServer, "mockId" | "collectionName" | "port">
): string {
	return head("mock server", `${mock.collectionName} on port ${mock.port}`, mock.mockId);
}

export function mockIssuerReference(issuer: Pick<MockIssuer, "issuerId" | "port">): string {
	return head("mock issuer", `port ${issuer.port}`, issuer.issuerId);
}

export function trashReference(entry: Pick<TrashEntry, "id" | "kind" | "name">): string {
	return `${head("trash entry", entry.name, entry.id)} - ${entry.kind}`;
}

/** Where a variable lives. Each scope carries the id the tools address it by; globals have none. */
export type VariableScope =
	| { type: "environment"; environment: Pick<Environment, "id" | "name"> }
	| { type: "collection"; collection: Pick<Collection, "id" | "name"> }
	| { type: "globals" };

/**
 * A variable is addressed by its name within a scope, so the line has no id of
 * its own. It takes `{ name }` and never a `VariableValue`: the value and the
 * `secret` flag are not reachable from here.
 */
export function variableReference(variable: { name: string }, scope: VariableScope): string {
	const name = `Vayu ${named("variable", variable.name)}`;
	switch (scope.type) {
		case "environment":
			return `${name} in ${entity("environment", scope.environment.name, scope.environment.id)}`;
		case "collection":
			return `${name} in ${entity("collection", scope.collection.name, scope.collection.id)}`;
		case "globals":
			return `${name} in globals`;
	}
}

/**
 * `GET /pets/{petId}`: the templated path as the document writes it, the
 * identity `diff_spec` and `sync_spec` match on. `operationId` follows when the
 * document declares one.
 */
export function specOperationReference(
	operation: Pick<SpecOperation, "method" | "path" | "operationId">,
	collection: Pick<Collection, "id" | "name">
): string {
	const label = `${operation.method.toUpperCase()} ${pathOnly(operation.path)}`;
	const operationId = operation.operationId ? ` ("${quoteName(operation.operationId)}")` : "";
	return `Vayu ${named("spec operation", label)} in ${entity("collection", collection.name, collection.id)}${operationId}`;
}

/**
 * An operation is addressed by its name within the request's document, so the
 * line has no id of its own. It takes `{ name }`: the query text, the variables
 * and the headers are not reachable from here.
 */
export function graphqlOperationReference(
	operation: { name: string },
	request: Pick<Request, "id" | "name">
): string {
	return `Vayu ${named("graphql operation", operation.name)} in ${entity("request", request.name, request.id)}`;
}

/** `Vayu run sample (<resultId>) of run (<run_id>)`: no name, the result row id is the key. */
export function runSampleReference(
	sample: Pick<RunSample, "resultId">,
	run: Pick<Run, "id">
): string {
	return `Vayu run sample (${sample.resultId}) of run (${run.id})`;
}

/** Who an element belongs to: a request or a collection, named so the id can be looked up. */
export type ElementOwner =
	| { type: "request"; request: Pick<Request, "id" | "name"> }
	| { type: "collection"; collection: Pick<Collection, "id" | "name"> };

/**
 * An element is named by its own name, else by its kind (`script.pre`). Its
 * `config`, where a script or an assertion's expected value sits, is not
 * reachable from here.
 */
export function elementReference(
	element: Pick<ElementDef, "id" | "kind" | "name">,
	owner: ElementOwner
): string {
	const title = element.name?.trim() || element.kind;
	const ownerTail =
		owner.type === "request"
			? entity("request", owner.request.name, owner.request.id)
			: entity("collection", owner.collection.name, owner.collection.id);
	return `${head("element", title, element.id)} of ${ownerTail}`;
}

/** What a threshold budget belongs to: the run that was judged, or the request that declares it. */
export type ThresholdOwner =
	| { type: "run"; run: Pick<Run, "id"> }
	| { type: "request"; request: Pick<Request, "id" | "name"> };

/**
 * `key` is the engine's budget name (`latencyP95Ms`, `custom.<name>.<stat>`).
 * The budget's limit and the measured value are not reachable from here.
 */
export function thresholdReference(threshold: { key: string }, owner: ThresholdOwner): string {
	const ownerTail =
		owner.type === "run"
			? `run (${owner.run.id})`
			: entity("request", owner.request.name, owner.request.id);
	return `Vayu ${named("threshold", threshold.key)} of ${ownerTail}`;
}
