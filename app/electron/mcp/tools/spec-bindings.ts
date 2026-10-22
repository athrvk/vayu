/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file spec-bindings.ts
 * @brief OpenAPI spec bindings: reading a binding, bounding a document, and the
 *        import, diff, bind and sync answers in words.
 */

import { z } from "zod";
import type { EngineClient } from "../engine-client.js";
import { PROXY_SETTINGS_TOKEN, SPEC_SYNC_TOKEN, resolveRemedyTokens } from "../remedy.js";
import { specDiffRequestsToRead, type StoredAuthByRequest } from "../withhold.js";
import type { McpHost, ToolContext } from "./contract.js";
import { bool, isRecord, requireStr, str } from "./kit.js";
import { boundText } from "./inline-body-bounds.js";
import { collectionSubtree, readCollectionRows } from "./cascade.js";

/**
 * A collection's binding to a stored OpenAPI document, as the collection row
 * carries it (`openapi`, issue #637).
 *
 * The engine stores `{}` for the unbound state and refuses a non-empty binding
 * that names no `specId`, so a row with a string `specId` is the only shape that
 * means "bound" - and the only one this reads. `specHash` is stamped engine-side
 * from the stored document at bind time; `syncedAt` is set by a spec sync.
 */
export interface SpecBinding {
	specId: string;
	specHash?: string;
	syncedAt?: number;
}

export function readSpecBinding(collection: unknown): SpecBinding | null {
	if (!isRecord(collection)) return null;
	const binding = collection.openapi;
	if (!isRecord(binding) || typeof binding.specId !== "string" || binding.specId === "") {
		return null;
	}
	return {
		specId: binding.specId,
		...(typeof binding.specHash === "string" ? { specHash: binding.specHash } : {}),
		...(typeof binding.syncedAt === "number" ? { syncedAt: binding.syncedAt } : {}),
	};
}

/**
 * The document's text as `get_spec` hands it back, bounded (issue #767's rule
 * applied to a surface whose ceiling is far higher than a response body's).
 *
 * A stored spec may be up to `maxSpecDocumentBytes` - megabytes for a real one:
 * Stripe's is 12 MB, GitHub's 9.7 MB - so the whole of it in a tool result
 * exceeds the result token limit outright. The cut is `MAX_INLINE_BODY_BYTES`,
 * this codebase's existing answer to "how much text does an automated reader
 * get", and `contentBytes` beside it is the engine's own count of the whole
 * document, so a truncated read always says what it is a prefix of.
 *
 * A document with no text answers `content: null` rather than dropping the
 * field: a caller that asked for the content and got a result without it cannot
 * tell "empty" from "this tool decided not to send it".
 */
export function boundSpecContent(document: unknown): Record<string, unknown> {
	if (!isRecord(document) || typeof document.content !== "string") {
		return { content: null, contentTruncated: false };
	}
	const { text, truncated } = boundText(document.content);
	return { content: text, contentTruncated: truncated };
}

/**
 * What a bind did, in a sentence (issue #862).
 *
 * The counts are already in the structured body; this says the two that change
 * what an agent should do next. **The cleared count is named on its own** - it
 * is the one thing a bind takes away rather than adds, and an agent that
 * re-bound a collection to the wrong document should learn that from the reply
 * rather than from a later run reporting no coverage. Unmatched requests are
 * named the same way, because they are what a `sync` would create operations
 * for and are the honest answer to "did this document fit this collection".
 *
 * Defensive about the shape for `readSpecBinding`'s reason: an engine answering
 * something unexpected must cost the caveat, never the result.
 */
export function describeBind(outcome: unknown): string {
	const count = (value: unknown): number => (typeof value === "number" ? value : 0);
	if (!isRecord(outcome)) return "Bound.";
	const stamped = count(outcome.stamped);
	const cleared = count(outcome.cleared);
	const unmatchedRequests = Array.isArray(outcome.unmatchedRequests)
		? outcome.unmatchedRequests.length
		: 0;
	const unmatchedOperations = Array.isArray(outcome.unmatchedOperations)
		? outcome.unmatchedOperations.length
		: 0;
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

	const parts = [
		`Bound to spec ${typeof outcome.specId === "string" ? outcome.specId : "(unknown)"}.`,
		`Recorded identity on ${plural(stamped, "request")}.`,
	];
	if (cleared > 0) {
		parts.push(
			`Cleared identity from ${plural(cleared, "request")} - each named an operation only the previously bound document declared.`
		);
	}
	if (unmatchedRequests > 0 || unmatchedOperations > 0) {
		parts.push(
			`${plural(unmatchedRequests, "request")} matched no operation, and ${plural(unmatchedOperations, "operation")} matched no request; nothing was created or deleted for either.`
		);
	}
	return parts.join(" ");
}

/**
 * How many entries of one spec-diff bucket a tool result carries (issue #871).
 *
 * Nothing caps the buckets upstream: a document that renamed every operation
 * puts one `changed` entry per request in the collection, and each carries its
 * changed fields. Fifty is the number that keeps the common answer whole while
 * bounding the pathological one, and - the rule the run-report rows follow -
 * the *counts* stay true, so a cut list is visible as one rather than reading
 * as the whole drift.
 */
export const MAX_SPEC_DIFF_ENTRIES = 50;

/**
 * One bucket of `POST /specs/diff`, capped, with what it was cut from.
 *
 * The engine's own count is the second element rather than the length of the
 * first: an agent deciding whether a contract drifted reads the total, and a
 * total read off a cut list would say it did not.
 */
export function boundedBucket(value: unknown, shape: (entry: Record<string, unknown>) => unknown) {
	const entries = Array.isArray(value) ? value : [];
	return {
		entries: entries.slice(0, MAX_SPEC_DIFF_ENTRIES).map((entry) => shape(asRecord(entry))),
		total: entries.length,
	};
}

export function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

/**
 * A changed request, as an agent reads one.
 *
 * `draft` is dropped rather than passed through. It is what an apply *would*
 * write, and `POST /specs/sync` re-reads it off the document being stored
 * rather than being handed it (the same split `POST /specs/match` and
 * `POST /specs/bind` follow), so nothing on either side of this tool consumes
 * it - it would be the heaviest field in the answer and the "written but never
 * read" defect at once. The rendered `current` / `next` pair survives, which is
 * what says *what* moved; the engine already truncates both for display.
 */
export function changedEntry(item: Record<string, unknown>): Record<string, unknown> {
	const fields = Array.isArray(item.fields) ? item.fields : [];
	return {
		requestId: item.requestId ?? null,
		name: item.name ?? null,
		boundOperation: item.boundOperation ?? null,
		operation: item.operation ?? null,
		matchedBy: item.matchedBy ?? null,
		renamed: item.renamed === true,
		previousUnknown: item.previousUnknown === true,
		fields: fields.map((field) => {
			const row = asRecord(field);
			return {
				field: row.field ?? null,
				current: row.current ?? null,
				next: row.next ?? null,
				userTouched: row.userTouched === true,
			};
		}),
	};
}

/**
 * The stored `auth` of the requests a spec diff's `headers`, `url` and `params`
 * changes belong to, for the API-key name their display lines do not carry.
 * Empty when the user reveals secrets: nothing is withheld, so nothing is read.
 * A request that cannot be read is left out, and the projection withholds its
 * display rather than guess (#1840, #1842).
 */
export async function readSpecDiffAuth(
	ctx: ToolContext,
	changed: unknown,
	signal: AbortSignal | undefined
): Promise<StoredAuthByRequest> {
	const auth = new Map<string, unknown>();
	if (ctx.config.revealSecretsToAgents) return auth;
	await Promise.all(
		specDiffRequestsToRead(changed).map(async (requestId) => {
			try {
				const stored = await ctx.client.getRequest(requestId, signal);
				if (isRecord(stored)) auth.set(requestId, stored.auth);
			} catch {
				// Left out on purpose: see above.
			}
		})
	);
	return auth;
}

/** Whether any field of @p item is one a person edited by hand. */
function hasUserEdit(item: Record<string, unknown>): boolean {
	const fields = Array.isArray(item.fields) ? item.fields : [];
	return fields.some((field) => asRecord(field).userTouched === true);
}

/**
 * What a document would change, in a sentence (issue #871).
 *
 * The counts are in the structured body; this says the three things that change
 * what an agent should do next. **Hand-edited fields are named on their own**:
 * they are the one part of a drift that an apply may not take silently, and an
 * agent reading only "6 changed" would propose overwriting somebody's edit.
 * `unmapped` is named for the reason the diff reports it at all - a collection
 * half of which carries no operation is one this answer describes half of.
 *
 * Defensive about the shape for `describeBind`'s reason: an engine answering
 * something unexpected must cost the caveat, never the result.
 */
export function describeSpecDiff(answer: Record<string, unknown>): string {
	const bucket = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
	const count = (value: unknown): number => (typeof value === "number" ? value : 0);
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

	if (answer.identical === true) {
		return "This document is byte-identical to the one the collection is bound to, so there is nothing to apply.";
	}

	const changed = Array.isArray(answer.changed) ? answer.changed : [];
	const edited = changed.filter((item) => hasUserEdit(asRecord(item))).length;
	const parts = [
		`${plural(bucket(answer.added), "operation")} added, ${plural(bucket(answer.removed), "request")} no longer declared, ${plural(changed.length, "request")} changed, ${count(answer.unchanged)} unchanged.`,
	];
	if (edited > 0) {
		parts.push(
			`${plural(edited, "changed request")} hold a field somebody edited by hand (userTouched) - applying the document there overwrites a person's work, not an import's.`
		);
	}
	if (count(answer.unmapped) > 0) {
		parts.push(
			`${plural(count(answer.unmapped), "request")} in this collection carry no operation at all and are not part of the comparison.`
		);
	}
	parts.push(
		"Nothing was written: this is the read half of a sync. `sync_spec` applies the safe half of it - everything the document adds, every field it moved that nobody had edited by hand, and no deletions."
	);
	return parts.join(" ");
}

/**
 * What a sync wrote, and what its policy declined, in a sentence (issue #871).
 *
 * **The declined half is not optional.** An agent reading "3 created, 5
 * updated" has been told what a safe apply did and nothing about what it
 * refused, and refusing is the point of the policy: a hand-edited field left
 * alone and a request not deleted are the two outcomes a caller would otherwise
 * assume did not exist. The counts are the engine's `skipped`, so this states
 * them rather than working them out.
 *
 * Defensive about the shape for `describeBind`'s reason: an engine answering
 * something unexpected must cost the caveat, never the result.
 */
/**
 * What an import did, in a sentence - the caveat beside the JSON.
 *
 * `meta.skipped` is the half worth reading aloud: an import that silently
 * dropped a WebSocket request, a file body or an operation's `default` response
 * looks exactly like one that had none, and every parser tallies those precisely
 * so a caller does not have to discover the loss later.
 */
export function describeImport(answer: unknown): string {
	if (!isRecord(answer)) return "";
	const meta = isRecord(answer.meta) ? answer.meta : {};
	const format = typeof meta.format === "string" ? meta.format : "the document";
	const parts = [
		`${num(answer.collections)} collection(s)`,
		`${num(answer.requests)} request(s)`,
	];
	if (num(answer.environments) > 0) parts.push(`${num(answer.environments)} environment(s)`);
	if (num(answer.globals) > 0) parts.push(`${num(answer.globals)} global(s)`);
	let text = `Imported ${format}: ${parts.join(", ")}.`;
	const skipped = Array.isArray(meta.skipped) ? meta.skipped : [];
	if (skipped.length > 0) {
		const named = skipped
			.filter(isRecord)
			.map((entry) => `${num(entry.count)} ${String(entry.kind)}`)
			.join(", ");
		text += ` Not everything imported: ${named}.`;
	}
	// The engine's own count, not a guess from the tree: an importer decides
	// whether it filed anything under folders, and by what (`meta.folderStrategy`).
	const folders = num(meta.folderCount);
	if (folders > 0) {
		text +=
			` Requests are filed under ${folders} sub-collection(s); to run them all pass ` +
			`recursive: true to run_collection or run_collection_smoke.`;
	}
	return text;
}

/**
 * What import_document and preview_import take: one schema, so a preview is
 * always asked the question the import will be.
 */
export const importDocumentInput = {
	content: z
		.string()
		.describe(
			"The document text, verbatim - JSON or YAML. Capped by the maxSpecDocumentBytes setting, which is what an over-large document is refused against."
		),
	importEnvironments: z
		.boolean()
		.optional()
		.describe(
			"Whether to create the environments and global variables the document carries. Defaults to true. Off, they are not created and the counts report 0 - the same toggle the import dialog offers."
		),
	importScripts: z
		.boolean()
		.optional()
		.describe(
			"Whether to import pre-request and post-request scripts. Defaults to true. Off, every script imports empty - a Postman collection's `event` blocks are code from a document you were handed."
		),
	sourceUrl: z
		.string()
		.optional()
		.describe(
			"Where the document was fetched from, if it came from a URL. Recorded on a stored OpenAPI document so a later sync knows what to re-fetch, and used to resolve a relative `servers[0].url`; omit it for a document you were handed as text."
		),
	fileName: z
		.string()
		.optional()
		.describe("What the file is called, for the result's `meta` only. Never stored."),
};

/**
 * The engine payload for an import or its preview.
 *
 * External `$ref`s are not followed: resolving one means fetching a URL or
 * reading a file beside the document, which is the import dialog's business (a
 * URL proxy and a gated IPC) and not an agent's. A document that names another
 * file imports whole and says so - `meta.skipped` carries no `external_ref`
 * count here, because nothing tried. An option the caller did not state is left
 * absent rather than defaulted here: the engine's default is the one the import
 * dialog offers, and restating it would be a second place for it to drift.
 */
export function importPayload(args: Record<string, unknown>): Record<string, unknown> {
	const sourceUrl = str(args, "sourceUrl");
	const fileName = str(args, "fileName");
	const importEnvironments = bool(args, "importEnvironments");
	const importScripts = bool(args, "importScripts");
	return {
		content: requireStr(args, "content"),
		...(importEnvironments === undefined ? {} : { importEnvironments }),
		...(importScripts === undefined ? {} : { importScripts }),
		...(sourceUrl ? { sourceUrl } : {}),
		...(fileName ? { fileName } : {}),
	};
}

/**
 * What an import would create, read off the parsed tree without handing the
 * tree back: an OpenAPI spec parses into thousands of requests with bodies,
 * and a preview is asked "what, and what not", which the counts and names
 * answer. `meta` rides whole - it is what the import dialog shows.
 */
export function summarizeImportTree(tree: unknown): Record<string, unknown> {
	const answer = asRecord(tree);
	const countRequests = (node: Record<string, unknown>): number =>
		(Array.isArray(node.requests) ? node.requests.length : 0) +
		(Array.isArray(node.children)
			? node.children
					.filter(isRecord)
					.reduce((total, child) => total + countRequests(child), 0)
			: 0);
	const collections = (Array.isArray(answer.collections) ? answer.collections : [])
		.filter(isRecord)
		.map((c) => ({
			name: typeof c.name === "string" ? c.name : "",
			folders: Array.isArray(c.children) ? c.children.length : 0,
			requests: countRequests(c),
		}));
	const environments = (Array.isArray(answer.environments) ? answer.environments : [])
		.filter(isRecord)
		.map((e) => (typeof e.name === "string" ? e.name : ""));
	return {
		collections,
		environments,
		globals: isRecord(answer.globals) ? Object.keys(answer.globals).length : 0,
		clientCertificates: Array.isArray(answer.clientCertificates)
			? answer.clientCertificates.length
			: 0,
		meta: isRecord(answer.meta) ? answer.meta : {},
	};
}

/** One sentence for a preview, in the words describeImport uses for the import. */
export function describeImportPreview(summary: Record<string, unknown>): string {
	const meta = asRecord(summary.meta);
	const format = typeof meta.format === "string" ? meta.format : "the document";
	const skipped = Array.isArray(meta.skipped) ? meta.skipped.filter(isRecord) : [];
	let text = `Nothing was stored. Importing this ${format} would create ${num(meta.requestCount)} request(s) in ${num(meta.folderCount)} folder(s)`;
	if (num(meta.environmentCount) > 0) text += ` and ${num(meta.environmentCount)} environment(s)`;
	text += ".";
	if (num(meta.folderCount) > 0) {
		text +=
			" To run them all after importing, pass recursive: true to run_collection or run_collection_smoke.";
	}
	if (skipped.length > 0) {
		text += ` It would not carry: ${skipped.map((e) => `${num(e.count)} ${String(e.kind)}`).join(", ")}.`;
	}
	return text;
}

/** A request row as a bind preview names it. */
interface PreviewedRequest {
	id: string;
	name: string;
}

/**
 * What binding @p content to @p collectionId would do, storing nothing
 * (the app's Spec tab preview, issue #718 / #869).
 *
 * Describe, then match: the same two reads the Spec tab makes, so the preview
 * and the bind share the engine's reader and its matching rule. `wouldClear` is
 * the tab's "stale stamps": a request that carries an operation today and
 * matches nothing in this document loses it on bind. The engine answers the
 * match in ids, so which of them carry a stamp is read off the subtree's rows.
 */
export async function previewSpecBind(
	client: EngineClient,
	collectionId: string,
	content: string,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	const described = asRecord(await client.describeSpec(content, signal));
	const operations = Array.isArray(described.operations) ? described.operations : [];
	const match = asRecord(await client.matchSpec({ collectionId, operations }, signal));
	const rows = readCollectionRows(await client.listCollections(signal));
	const subtree = collectionSubtree(rows, collectionId) ?? [collectionId];
	const lists = await Promise.all(subtree.map((id) => client.listRequests(id, signal)));
	const byId = new Map<string, Record<string, unknown>>();
	for (const list of lists) {
		for (const row of Array.isArray(list) ? list.filter(isRecord) : []) {
			if (typeof row.id === "string") byId.set(row.id, row);
		}
	}
	const named = (id: string): PreviewedRequest => {
		const row = byId.get(id);
		return { id, name: typeof row?.name === "string" ? row.name : "" };
	};
	const unmatchedIds = (
		Array.isArray(match.unmatchedRequests) ? match.unmatchedRequests : []
	).filter((id): id is string => typeof id === "string");
	const wouldClear = unmatchedIds.filter((id) => {
		const stamp = byId.get(id)?.specOperation;
		return isRecord(stamp) && Object.keys(stamp).length > 0;
	});
	const unmatchedOperations = Array.isArray(match.unmatchedOperations)
		? match.unmatchedOperations
		: [];
	const cut = <T>(list: T[]) => list.slice(0, MAX_SPEC_DIFF_ENTRIES);
	return {
		format: described.format ?? null,
		title: typeof described.title === "string" ? described.title : "",
		operations: operations.length,
		matched: Array.isArray(match.matched) ? match.matched.length : 0,
		wouldClear: { count: wouldClear.length, requests: cut(wouldClear).map(named) },
		unmatchedRequests: { count: unmatchedIds.length, requests: cut(unmatchedIds).map(named) },
		unmatchedOperations: {
			count: unmatchedOperations.length,
			operations: cut(unmatchedOperations),
		},
	};
}

/** One sentence for a bind preview, in the words describeBind uses for the bind. */
export function describeBindPreview(preview: Record<string, unknown>): string {
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
	const countOf = (key: string) => num(asRecord(preview[key]).count);
	const parts = [
		`Nothing was stored. Binding would record identity on ${plural(num(preview.matched), "request")}.`,
	];
	if (countOf("wouldClear") > 0) {
		parts.push(
			`It would clear identity from ${plural(countOf("wouldClear"), "request")} - each names an operation this document does not declare.`
		);
	}
	if (countOf("unmatchedRequests") > 0 || countOf("unmatchedOperations") > 0) {
		parts.push(
			`${plural(countOf("unmatchedRequests"), "request")} would match no operation, and ${plural(countOf("unmatchedOperations"), "operation")} no request.`
		);
	}
	return parts.join(" ");
}

/**
 * The setting a connection test's outcome points at. The engine's `outcome` is
 * deliberately coarse - one value per setting to go and look at - so this is a
 * lookup, not a diagnosis of its own.
 */
export const CONNECTION_OUTCOME_HINTS: Record<string, string> = {
	ok: "The connection works under the proxy, CA and client-certificate settings in force.",
	proxy_failed: `The proxy refused or could not be reached: ${PROXY_SETTINGS_TOKEN}.`,
	tls_failed:
		"The TLS handshake failed: check the custom CA certificates and the client certificate registered for this host (list_client_certificates).",
	timed_out: "Nothing answered within 10 seconds: check the host, the port and the network path.",
	failed: "The connection failed before any hop answered: `detail` carries libcurl's own message.",
};

/** A count the engine reported, or 0 - never `NaN` in a sentence. */
function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function describeSync(answer: unknown, host: McpHost): string {
	const outcome = asRecord(answer);
	const count = (value: unknown): number => (typeof value === "number" ? value : 0);
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

	const parts = [
		`Applied in one transaction: ${plural(count(outcome.created), "request")} created, ${plural(count(outcome.updated), "request")} updated, ${plural(count(outcome.deleted), "request")} deleted. The document is stored and the collection is now bound to it.`,
	];

	const skipped = asRecord(outcome.skipped);
	const held = count(skipped.requests);
	const fields = count(skipped.fields);
	const deletions = count(skipped.deletions);
	if (held > 0 || fields > 0 || deletions > 0) {
		const left: string[] = [];
		if (held > 0)
			left.push(
				`${plural(held, "changed request")} left untouched (a field somebody edited by hand, or a request whose bound document could not be read)`
			);
		if (fields > 0) left.push(`${plural(fields, "field")} not written`);
		if (deletions > 0)
			left.push(
				`${plural(deletions, "request")} the document no longer declares but which was NOT deleted`
			);
		parts.push(
			`The safe policy declined the rest: ${left.join(", ")}. Applying any of that ${SPEC_SYNC_TOKEN}; \`diff_spec\` shows exactly which entries they are.`
		);
	}
	return resolveRemedyTokens(parts.join(" "), host);
}
