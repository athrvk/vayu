/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file spec.tools.ts
 * @brief OpenAPI and import/export tools: reading, diffing, syncing, binding and
 *        exporting a collection's spec, plus document import and Postman export.
 */

import { z } from "zod";
import { secretsShape, withholdSpecDiffChanges, withheldPointer } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	collectionEchoShape,
	engineErrorResult,
	errorResult,
	isRecord,
	jsonResult,
	requireStr,
	str,
	withCaveat,
	writesDisabled,
} from "./kit.js";
import { boundText } from "./inline-body-bounds.js";
import {
	asRecord,
	boundedBucket,
	boundSpecContent,
	changedEntry,
	describeBind,
	describeBindPreview,
	describeImport,
	describeImportPreview,
	describeSpecDiff,
	describeSync,
	importDocumentInput,
	importPayload,
	MAX_SPEC_DIFF_ENTRIES,
	previewSpecBind,
	readSpecBinding,
	readSpecDiffAuth,
	type SpecBinding,
	summarizeImportTree,
} from "./spec-bindings.js";
import { GUARDED_WRITE_SENTENCE, SPEC_SYNC_TOKEN } from "../remedy.js";

export const SPEC_TOOLS: McpTool[] = [
	{
		name: "get_spec",
		category: "read",
		invalidates: [],
		description:
			"Read the OpenAPI document a collection is bound to - where it came from, when it was fetched, its content hash and its size - by `collectionId` (resolving the collection's binding) or by `specId` directly. The document text is NOT included by default: a real spec runs to megabytes, so pass includeContent: true to get it, capped at 32 KB with `contentBytes` reporting the true size. A collection that binds nothing answers `bound: false` rather than failing.",
		annotations: {
			title: "Get bound OpenAPI spec",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.optional()
				.describe("Collection whose binding to resolve. Pass this or specId, not both."),
			specId: z
				.string()
				.optional()
				.describe(
					"Stored document to read directly. Spec IDs come from a collection's binding - there is no list route for them."
				),
			includeContent: z
				.boolean()
				.optional()
				.describe(
					"Include the document text (capped at 32 KB). Off by default - the metadata is what describes a binding, and the text can be megabytes."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = str(args, "collectionId");
			const specIdArg = str(args, "specId");
			if (collectionId && specIdArg) {
				return errorResult(
					'Pass either "collectionId" or "specId", not both - they would have to agree, and this tool cannot say which one you meant if they do not.'
				);
			}
			const includeContent = args.includeContent === true;

			// Assigned on the first two arms below - by the binding the collection
			// resolves to, or by the argument - so it is a string by the time it is
			// read. The "neither was passed" case is the third arm rather than a
			// guard above it: as a guard, proving the `else` still holds an id is a
			// step across two conditions that `strict` control flow does not make in
			// either compiler, and the assertion it would take is the kind that stops
			// being true when someone edits the guard.
			let specId: string;
			let binding: SpecBinding | null = null;
			if (collectionId) {
				let collection: unknown;
				try {
					collection = await ctx.client.getCollection(collectionId, signal);
				} catch (err) {
					return engineErrorResult(err, ctx);
				}
				if (collection === null) {
					return errorResult(`No collection with id "${collectionId}".`);
				}
				binding = readSpecBinding(collection);
				// Unbound is an answer, not a failure: "which spec does this
				// collection use" has "none" as a legitimate reply, and an error
				// here would read as an engine or id problem.
				if (!binding) {
					return withCaveat(
						jsonResult({ collectionId, bound: false }),
						"\n\nThis collection is not bound to an OpenAPI document. Bind one with `bind_spec` (call `preview_spec_bind` first to see what it would change)."
					);
				}
				specId = binding.specId;
			} else if (specIdArg) {
				specId = specIdArg;
			} else {
				return errorResult('Pass either "collectionId" or "specId".');
			}

			try {
				// The metadata route unless the text was asked for: it is the whole
				// point of `GET /specs/:id/meta` that describing a document does not
				// transfer it, and the full read carries the two extracted indexes
				// as well, which are as heavy as the document itself.
				const document = includeContent
					? await ctx.client.getSpec(specId, signal)
					: await ctx.client.getSpecMeta(specId, signal);
				const meta = isRecord(document) ? document : {};
				const value: Record<string, unknown> = {
					specId,
					sourceUrl: meta.sourceUrl ?? null,
					fetchedAt: meta.fetchedAt ?? null,
					hash: meta.hash ?? null,
					// `contentBytes` is only on the meta read; the full read carries
					// the bytes themselves, so measure them the same way the engine
					// does (`content.size()`) rather than reporting nothing.
					contentBytes:
						typeof meta.contentBytes === "number"
							? meta.contentBytes
							: typeof meta.content === "string"
								? Buffer.byteLength(meta.content, "utf8")
								: null,
					...(binding ? { collectionId, bound: true, binding } : {}),
					...(includeContent ? boundSpecContent(meta) : {}),
				};
				return jsonResult(value);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
		},
	},
	{
		name: "diff_spec",
		category: "read",
		invalidates: [],
		description: (config) =>
			"Check whether an OpenAPI contract has drifted from the collection bound to it, and where. Pass the collection and the re-fetched document text; the engine compares it against the document the collection is currently bound to AND against every request in its subtree, and answers which operations the document adds, which requests it no longer declares, and which requests changed field by field with the current and next value of each. Reads only: nothing is stored, no binding moves, no request is stamped, so it is safe to ask about a document you have not decided to apply. `identical` is decided on the stored bytes and is the 'already up to date' answer. A field flagged `userTouched` is one somebody edited by hand rather than one the last import wrote - applying the document there would overwrite a person's work. `unmapped` counts requests carrying no operation identity at all, which no comparison covers. This tool is the read half: `sync_spec` applies the safe half of a drift." +
			withheldPointer(config),
		annotations: {
			title: "Diff OpenAPI spec against collection",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to compare. It must already be bound to a document - the comparison is three-way and the bound document is the middle term. Its whole subtree is read, since an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The re-fetched OpenAPI document text, JSON or YAML. Not stored - this is the candidate, compared against the bytes the collection is bound to. Capped by the maxSpecDocumentBytes setting, the same cap a bind applies."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			// The requests and the bound document are deliberately not sent: the
			// engine walks the subtree and reads the binding itself, so a caller
			// cannot make its own stale copy the "previous" side of a three-way
			// comparison. Nothing is worked out here for the same reason
			// `bind_spec` works nothing out - the comparison is the engine's
			// (`core::diff_spec`), off the bytes handed to it.
			let answer: unknown;
			try {
				answer = await ctx.client.diffSpec({ collectionId, spec: { content } }, signal);
			} catch (err) {
				// The engine's own sentence is the useful one: a 400 names the
				// collection that binds nothing and says to bind it first, a 404
				// names the collection, and a 409 names the binding whose document
				// the store no longer holds.
				return engineErrorResult(err, ctx);
			}
			const diff = asRecord(answer);
			const added = boundedBucket(diff.added, (entry) => ({
				operation: entry.operation ?? null,
				folder: entry.folder ?? null,
			}));
			const removed = boundedBucket(diff.removed, (entry) => ({
				requestId: entry.requestId ?? null,
				name: entry.name ?? null,
				operation: entry.operation ?? null,
			}));
			const changed = boundedBucket(diff.changed, changedEntry);
			const storedAuth = await readSpecDiffAuth(ctx, changed.entries, signal);
			const truncated = [added, removed, changed].some(
				(bucket) => bucket.entries.length < bucket.total
			);
			return withCaveat(
				jsonResult({
					collectionId,
					identical: diff.identical === true,
					// The engine's totals, not these lists' lengths - see
					// `MAX_SPEC_DIFF_ENTRIES` for why the two can differ.
					summary: {
						added: added.total,
						removed: removed.total,
						changed: changed.total,
						unchanged: typeof diff.unchanged === "number" ? diff.unchanged : 0,
						unmapped: typeof diff.unmapped === "number" ? diff.unmapped : 0,
					},
					added: added.entries,
					removed: removed.entries,
					changed: secretsShape(ctx, (entries) =>
						withholdSpecDiffChanges(entries, storedAuth)
					)(changed.entries),
					entriesTruncated: truncated,
				}),
				`\n\n${describeSpecDiff(diff)}${
					truncated
						? ` Each list here is capped at ${MAX_SPEC_DIFF_ENTRIES} entries; the counts in \`summary\` are the true totals.`
						: ""
				}`
			);
		},
	},
	{
		name: "sync_spec",
		category: "write",
		// The same set a bind uses, and for the same reason: the document and the
		// binding live on the collection row, and the requests this creates,
		// updates and deletes live beneath it. A sync moves both at once, so
		// declaring one would leave an open request list showing rows this call
		// has already rewritten.
		invalidates: ["collection", "request"],
		description:
			"Apply a drifted OpenAPI contract to the collection bound to it - the safe half of it. " +
			GUARDED_WRITE_SENTENCE +
			". Pass the collection and the re-fetched document text; the engine stores the document, moves the binding to it, and creates, updates and deletes requests in ONE transaction - nothing lands unless all of it does. WHAT IT WRITES IS NOT YOURS TO CHOOSE, deliberately: this sends `policy: \"safe\"` and the engine decides, which means every operation the document adds becomes a request, every field the document moved that nobody had edited by hand is written, and NOTHING IS DELETED and NO HAND-EDITED FIELD IS OVERWRITTEN. A request whose bound document could not be read is left alone whole, since there nobody's edit can be told from the document's change. `skipped` reports what that left: requests untouched, fields not written, deletions not made. Use `diff_spec` first to see the drift and which of it is marked safe - it is the same answer this applies. Applying anything the policy declines - a deletion, or a field somebody edited - " +
			SPEC_SYNC_TOKEN +
			".",
		annotations: {
			title: "Apply OpenAPI spec drift",
			readOnlyHint: false,
			// Nothing a person authored is written: the policy skips every
			// hand-edited field, deletes nothing, and leaves a request it cannot
			// reason about alone. What it does write is what the last import
			// wrote and the document has since moved - which is the document's,
			// not the user's. That is precisely what makes the safe half of a
			// sync the half an agent may have.
			destructiveHint: false,
			// The engine mints a new `spec_documents` row per call, as a bind
			// does, so syncing the same bytes twice is not the same call twice.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to sync. It must already be bound to a document - a sync moves a binding forward and binding is `bind_spec`. Its whole subtree is written, since an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The re-fetched OpenAPI document text, JSON or YAML. Stored verbatim and the binding moves to it, even when no request row changes - catching a collection up to a document that only reworded its description is a real sync. Capped by the maxSpecDocumentBytes setting."
				),
			sourceUrl: z
				.string()
				.optional()
				.describe(
					"Where the document was re-fetched from, if it came from a URL. Recorded on the document so the next sync knows what to re-fetch; omit it for one you were handed as text."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			const sourceUrl = str(args, "sourceUrl");
			// `policy` rather than rows, and no argument offering an alternative:
			// which of a drift is safe to write is `core::safe_spec_apply`, the
			// same function whose answer `diff_spec` reports per entry. A tool
			// that let an agent name rows would be a second opinion about which
			// of a person's fields a sync may overwrite - the one judgement this
			// side must never make (issue #871).
			let outcome: unknown;
			try {
				outcome = await ctx.client.syncSpec(
					{
						collectionId,
						spec: { content, ...(sourceUrl ? { sourceUrl } : {}) },
						policy: "safe",
					},
					signal
				);
			} catch (err) {
				// The engine's own sentence: a 400 names the collection that binds
				// nothing and says to bind it first, a 404 names the collection,
				// and a 409 says a row the comparison was made against has since
				// gone - which is a re-check, not a bad request.
				return engineErrorResult(err, ctx);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeSync(outcome, ctx.host)}`);
		},
	},
	{
		name: "preview_import",
		category: "read",
		invalidates: [],
		description:
			"Read a collection, environment or API spec document the way import_document would, and store nothing: the collections it would create (names, folder and request counts), the environments, the number of globals, and `meta` - the format, the counts, and `meta.skipped`, what the document declares that Vayu cannot carry, each with the requests it applies to. Takes exactly import_document's arguments, so preview first, show the user what would be left out, then import. Available with writes off.",
		annotations: {
			title: "Preview an import",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: importDocumentInput,
		handler: async (args, ctx, signal) => {
			const payload = importPayload(args);
			let summary: Record<string, unknown>;
			try {
				summary = summarizeImportTree(await ctx.client.parseImport(payload, signal));
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			return withCaveat(jsonResult(summary), `\n\n${describeImportPreview(summary)}`);
		},
	},
	{
		name: "import_document",
		category: "write",
		// All three families: a Postman collection creates collections and
		// requests, an environment export creates an environment, and a globals
		// export rewrites the global scope. Which of them a given document
		// touches is not knowable until it has been read, and an entity left out
		// would leave an open list showing a tree the import has already changed.
		invalidates: ["collection", "request", "environment"],
		description:
			"Import a collection, environment or API spec from its document text. " +
			GUARDED_WRITE_SENTENCE +
			". Every format Vayu accepts is read by the engine: OpenAPI 3.x and 2.0 (JSON or YAML), Postman Collection v2.1 and v2.0, a Postman environment or globals export, and an Insomnia v4 or v5 export - detection is by content, so you do not say which one it is. The whole tree lands in one transaction: a document that is refused creates nothing. An OpenAPI document is stored and the collection is bound to it, so its runs report contract coverage and its responses are schema-checked straight away, and its operations are filed under one sub-collection per tag. The result reports what was created plus `meta`, which names the format, the counts, and - in `meta.skipped` - everything the document declared that Vayu cannot represent, so a lossy import says so rather than looking complete. A Postman globals export MERGES into the existing global scope, imported values winning on a collision; nothing else here overwrites anything. Call preview_import first with the same arguments to see what would be created and what would be left out, without storing anything.",
		annotations: {
			title: "Import a document",
			readOnlyHint: false,
			// Nothing existing is removed: an import only creates. The one write
			// that touches prior state is the globals merge, which adds and
			// overwrites by key and deletes nothing.
			destructiveHint: false,
			// Two imports of one document are two collections, not one.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: importDocumentInput,
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const payload = importPayload(args);
			let outcome: unknown;
			try {
				outcome = await ctx.client.importDocument(payload, signal);
			} catch (err) {
				// The engine's own sentence: "Unrecognised format" for a file no
				// format claims, a read failure naming the line for one that is
				// broken, and the cap by name for one that is too large.
				return engineErrorResult(err, ctx);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeImport(outcome)}`);
		},
	},
	{
		name: "preview_spec_bind",
		category: "read",
		invalidates: [],
		description:
			"Say what bind_spec would do with a document, and store nothing: how many of the collection's requests it would record an operation on, which requests would LOSE the operation they carry today because this document does not declare it (`wouldClear`), which requests match no operation, and which operations match no request. Uses the engine's own reader and matching rule, the ones bind_spec uses, over the collection's whole subtree. Lists are capped at " +
			MAX_SPEC_DIFF_ENTRIES +
			" entries; each `count` is the true total. Available with writes off.",
		annotations: {
			title: "Preview an OpenAPI bind",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to preview binding. Its whole subtree is matched, as bind_spec does."
				),
			content: z
				.string()
				.describe(
					"The OpenAPI document text, JSON or YAML. Capped by the maxSpecDocumentBytes setting, as bind_spec is."
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			let preview: Record<string, unknown>;
			try {
				preview = await previewSpecBind(ctx.client, collectionId, content, signal);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			return withCaveat(jsonResult(preview), `\n\n${describeBindPreview(preview)}`);
		},
	},
	{
		name: "bind_spec",
		category: "write",
		// Both families: the binding lives on the collection row, and the stamps
		// this writes and clears live on the requests beneath it. Declaring only
		// the collection would leave an open request list showing identity a bind
		// has already removed. No `spec` family - the stored document is
		// immutable under its id, and this creates a new one rather than
		// changing any cached row.
		invalidates: ["collection", "request"],
		description:
			"Bind a collection to an OpenAPI document, so its runs report contract coverage and its responses are schema-checked. " +
			GUARDED_WRITE_SENTENCE +
			". Pass the document text (JSON or YAML) - the engine stores it, works out which of the collection's requests is which operation by method and path shape, and records that identity, all in one transaction: nothing is created or deleted, and a bind that fails writes nothing at all. RE-BINDING REPLACES THE CONTRACT: any request whose identity the new document does not account for has it cleared, because a stamp naming an operation of a document this collection is no longer bound to would be read as identity rather than as a gap. The result reports how many requests were stamped and how many cleared, plus the requests and operations nothing paired with. Call preview_spec_bind first to see which requests would gain an operation and which would lose the one they carry, without storing anything.",
		annotations: {
			title: "Bind OpenAPI spec",
			readOnlyHint: false,
			// Nothing a user authored is lost: no request is created or deleted,
			// the only field written is the identity a bind exists to record, and
			// the document a collection was bound to before is still stored while
			// anything else binds it. A re-bind is undone by binding the previous
			// document again.
			destructiveHint: false,
			// The engine mints a new `spec_documents` row per call, so binding the
			// same bytes twice is not the same call twice.
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to bind. Its whole subtree is matched - an imported spec files its requests under one sub-collection per tag."
				),
			content: z
				.string()
				.describe(
					"The OpenAPI document text, JSON or YAML, stored verbatim. Capped by the maxSpecDocumentBytes setting."
				),
			sourceUrl: z
				.string()
				.optional()
				.describe(
					"Where the document came from, if it came from a URL. Recorded on the document so a later sync knows what to re-fetch; omit it for a document you were handed as text."
				),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			const content = requireStr(args, "content");
			const sourceUrl = str(args, "sourceUrl");
			// The document and the collection, and nothing worked out here: the
			// pairing is the engine's (`core::match_operations`), read off the
			// bytes it is about to store. An agent has no OpenAPI reader, and one
			// written here would be the second opinion about what a document
			// declares that #761's phase B moved the reader engine-side to end.
			let outcome: unknown;
			try {
				outcome = await ctx.client.bindSpec(
					{ collectionId, spec: { content, ...(sourceUrl ? { sourceUrl } : {}) } },
					signal
				);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			return withCaveat(jsonResult(outcome), `\n\n${describeBind(outcome)}`);
		},
	},
	{
		name: "export_spec",
		category: "read",
		invalidates: [],
		description:
			"Export a collection as an OpenAPI document - its own bound document updated, or a skeleton describing its requests when it binds none. Reads only: nothing is stored, and the collection is left exactly as it is. A bound export patches the stored document, so everything Vayu does not model (vendor extensions, security schemes, unreferenced components) survives and operations no request claims are removed; a skeleton is a starting point rather than a contract, with no schema Vayu did not read off a stored example body. A bound export keeps the contract by default (examples and parameter values only); `mode` set to `full` writes every edit the collection holds into the document instead - names, new rows, bodies, auth, and new operations for requests the document never declared. Everything OpenAPI has no member for (folders, scripts, settings, variables) travels as `x-vayu-*` extensions Vayu reads back, and credentials are always written empty - auth secrets, variables marked secret, and by name the header, parameter and URL values and a saved example's response headers; bodies, examples and scripts are not judged and are written as stored. `notes` says what the export could not carry - a request with no operation identity, an example whose media type nobody recorded, how many credentials it left out (`secretsOmitted`) - and the document text is capped at 32 KB with `contentBytes` reporting the true size, so a large spec comes back described rather than whole.",
		annotations: {
			title: "Export collection as OpenAPI",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe(
					"Collection to export. Its whole subtree is read - an OpenAPI import files requests under one sub-collection per tag - stopping at any collection bound to a different document."
				),
			format: z
				.enum(["json", "yaml"])
				.optional()
				.describe('Serialization to write. Defaults to "json".'),
			mode: z
				.enum(["contract", "full"])
				.optional()
				.describe(
					'What a bound export may write. "contract" (default) keeps the stored document as the contract and writes only examples and parameter values; "full" writes every edit the collection holds. Ignored for a collection bound to no document.'
				),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			const format = str(args, "format") || "json";
			const mode = str(args, "mode") || "contract";
			let exported: unknown;
			try {
				exported = await ctx.client.exportSpec(collectionId, format, mode, signal);
			} catch (err) {
				// The engine's own sentence, which is the useful one here: a 404
				// names the collection, and a 409 names the binding whose document
				// it could not read and says unbinding would export a skeleton.
				return engineErrorResult(err, ctx);
			}
			const answer = isRecord(exported) ? exported : {};
			const text = typeof answer.text === "string" ? answer.text : "";
			const { text: bounded, truncated } = boundText(text);
			return jsonResult({
				collectionId,
				format,
				mode,
				fileName: answer.fileName ?? null,
				notes: answer.notes ?? null,
				document: bounded,
				documentTruncated: truncated,
				contentBytes: Buffer.byteLength(text, "utf8"),
			});
		},
	},
	{
		name: "export_postman",
		category: "read",
		invalidates: [],
		description:
			"Export a collection as a Postman Collection v2.1 document - its folders, requests, variables, auth and scripts, in the JSON Postman imports. Reads only: nothing is stored, and the collection is left exactly as it is. Credentials are always written empty here - auth secrets, variables marked secret, and by name the header, parameter and URL values, a saved example's recorded request and response headers, and cookie values - and `notes.secretsOmitted` counts them; bodies and scripts are not judged and are written as stored; the app's export dialog is where a person can choose to include them. `notes` also lists what Postman has no place for (`notCarried`, one entry per kind with a count and the engine's sentence), so nothing is dropped without saying so. The document text is capped at 32 KB, with `contentBytes` reporting the true size.",
		annotations: {
			title: "Export collection as Postman",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z
				.string()
				.describe("Collection to export. Its whole subtree is read, folders included."),
		},
		handler: async (args, ctx, signal) => {
			const collectionId = requireStr(args, "collectionId");
			let exported: unknown;
			try {
				// No `includeSecrets` argument: a tool result is text an agent may
				// quote or paste anywhere, and a person choosing to hand over
				// credentials is a choice the dialog asks for, not one an agent
				// makes for them.
				exported = await ctx.client.exportPostman(collectionId, signal);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			const answer = isRecord(exported) ? exported : {};
			const text = typeof answer.text === "string" ? answer.text : "";
			const { text: bounded, truncated } = boundText(text);
			return jsonResult({
				collectionId,
				fileName: answer.fileName ?? null,
				notes: answer.notes ?? null,
				document: bounded,
				documentTruncated: truncated,
				contentBytes: Buffer.byteLength(text, "utf8"),
			});
		},
	},
	{
		name: "unbind_spec",
		category: "write",
		invalidates: ["collection"],
		description: (config) =>
			"Detach a collection from the OpenAPI document it is bound to. " +
			GUARDED_WRITE_SENTENCE +
			". The document itself is kept - other collections may bind it - and the requests keep the operation identities they were stamped with, exactly as the app's Unbind button leaves them, so re-binding the same document later costs nothing. After this the collection's runs report no contract coverage and its responses are no longer schema-checked. Re-binding is `bind_spec`, which restores this state exactly if you hand it the same document." +
			withheldPointer(config),
		annotations: {
			title: "Unbind OpenAPI spec",
			readOnlyHint: false,
			// The binding goes, nothing it named does: the document stays stored and
			// the stamps stay on the requests, and a re-bind in the app restores the
			// state this leaves. That is not the irreversible loss the hint marks.
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			collectionId: z.string().describe("Collection to unbind from its OpenAPI document."),
		},
		handler: async (args, ctx, signal) => {
			const refused = writesDisabled(ctx);
			if (refused) return refused;
			const collectionId = requireStr(args, "collectionId");
			let collection: unknown;
			try {
				collection = await ctx.client.getCollection(collectionId, signal);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			if (collection === null) {
				return errorResult(`No collection with id "${collectionId}".`);
			}
			const binding = readSpecBinding(collection);
			// Read first so an unbound collection is reported as already unbound
			// rather than written to. The PUT would succeed either way - the engine
			// reads `null` as "reset to the default", and the default is unbound -
			// and an agent told "unbound" about a collection that was never bound
			// would believe it had changed something.
			if (!binding) {
				return withCaveat(
					jsonResult({ collectionId, bound: false }),
					"\n\nNothing to do: this collection was not bound to an OpenAPI document."
				);
			}
			// `null`, not `{}`: the engine reads an absent field as "keep" and null
			// as "reset to the default", which is unbound. The same value the Spec
			// tab's Unbind sends, so the two paths cannot come to mean different
			// things.
			const result = await callEngine(
				ctx,
				() => ctx.client.updateCollection(collectionId, { openapi: null }, signal),
				collectionEchoShape(ctx)
			);
			return result.isError
				? result
				: withCaveat(
						result,
						`\n\nUnbound from spec ${binding.specId}. The document is still stored (another collection may bind it), and the requests keep their recorded operation identities.`
					);
		},
	},
];
