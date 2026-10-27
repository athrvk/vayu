/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file examples.ts
 * @brief Saved example responses: the body bound, the write payload and the
 *        delete prompt's wording.
 */

import { isRecord, str, ToolArgError } from "./kit.js";
import { boundText, MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { toKeyValueEntries } from "./scenario-runs.js";

/**
 * How much of a stored example body one result carries, and how much a whole
 * list may spend (issue #759, on the #767 / #769 precedent).
 *
 * An example body is capped engine-side at 1 MB and a request may hold 100 of
 * them, so an unbounded list is a 100 MB tool result - the same shape that made
 * `get_run_report` blow the token limit before #769 bounded its traces. The two
 * numbers are that fix's, not new ones: `MAX_INLINE_BODY_BYTES` per body, and
 * three times it across the list, which is the largest single row the per-body
 * bound can produce.
 */
export const MAX_EXAMPLES_BODY_BYTES = MAX_INLINE_BODY_BYTES * 3;

/** A list of examples with its bodies bounded, and what that cost. */
interface BoundedExamples {
	examples: unknown[];
	/** Rows whose body did not fit the list budget at all. */
	bodiesOmitted: number;
	bodyBudgetBytes: number;
}

/**
 * Bound the bodies of one request's examples, disclosing every cut.
 *
 * The flags are deliberately **not** the engine's `bodyTruncated`: that field
 * already means something else on this row - the client that captured the
 * response stored only a prefix of it - and reusing the name would leave an
 * agent unable to tell a short capture from a short *read*. So a body cut to fit
 * this result is `bodyClipped` with the stored size in `bodyBytes`, and one that
 * did not fit at all is `bodyOmitted` with the same size, keeping every scalar
 * (id, name, status, headers, order, origin) that says what the row is.
 */
export function boundExampleBodies(value: unknown): BoundedExamples {
	const rows = Array.isArray(value) ? value : [];
	let spent = 0;
	let bodiesOmitted = 0;
	const examples = rows.map((row) => {
		if (!isRecord(row) || typeof row.body !== "string" || row.body === "") return row;
		const stored = Buffer.byteLength(row.body, "utf8");
		const remaining = MAX_EXAMPLES_BODY_BYTES - spent;
		if (remaining <= 0) {
			bodiesOmitted++;
			return { ...row, body: "", bodyOmitted: true, bodyBytes: stored };
		}
		const bounded = boundText(row.body, Math.min(MAX_INLINE_BODY_BYTES, remaining));
		spent += Buffer.byteLength(bounded.text, "utf8");
		if (!bounded.truncated) return row;
		return { ...row, body: bounded.text, bodyClipped: true, bodyBytes: bounded.bytes };
	});
	return { examples, bodiesOmitted, bodyBudgetBytes: MAX_EXAMPLES_BODY_BYTES };
}

/**
 * The fields an example write may state, in the engine's spelling
 * (`apply_request_example_fields`).
 *
 * **`origin` is not among them, and that is the point.** The column says who
 * wrote the row - `import` for an importer or a spec sync, `user` for what the
 * app saved from a live response - and the OpenAPI sync replaces the first kind
 * without touching the second (#588, #722). An agent that could claim `import`
 * could hand its own example to the next sync to overwrite; one that could claim
 * `user` could pin a stale imported row against the document it came from.
 * Neither is the agent's call, so the field is refused by omission: the SDK
 * strips what the schema does not declare, and the payload builder copies only
 * the keys below.
 */
const EXAMPLE_WRITE_KEYS = ["name", "status", "contentType"] as const;

/**
 * The body of an example write - the named fields only, so an update leaves
 * what it did not mention alone (the engine merge-patches on `PUT`).
 *
 * `headers` follows the request tools' rule: a string map in, the engine's
 * `{key, value, enabled}` rows out, replacing the stored list wholesale.
 */
export function exampleWritePayload(args: Record<string, unknown>): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const key of EXAMPLE_WRITE_KEYS) {
		if (args[key] !== undefined) payload[key] = args[key];
	}
	if (args.headers !== undefined) {
		if (!isRecord(args.headers)) {
			throw new ToolArgError('"headers" must be an object mapping header names to values.');
		}
		payload.headers = toKeyValueEntries(args.headers);
	}
	const body = str(args, "body");
	if (body !== undefined) payload.body = body;
	return payload;
}

/**
 * What deleting this example leads to, as the delete prompt and preview say it.
 *
 * Differs by origin because the engine's delete does (#2971): a `user` example
 * goes to the Trash, an imported one becomes a spec-sync tombstone. Anything
 * but a known `user` origin gets the tombstone wording, the engine's own default
 * for a row that states none, so the prompt never promises a restore that
 * `restore_trash_entry` could not keep.
 */
export function describeExampleDeleteOutcome(example: Record<string, unknown>): string {
	const mockServer =
		"A mock server for this collection stops answering with it once it is restarted.";
	if (example.origin === "user") {
		return `${mockServer} It goes to Vayu's Trash - list_trash shows it there, and restore_trash_entry puts it back.`;
	}
	return `${mockServer} It is imported, so it is not trashed: syncing the collection with its spec will not bring it back, and re-importing the document will. There is no restore for it.`;
}

/** One stored example named in words, for the prompt that asks to delete it. */
export function describeExample(exampleId: string, example: Record<string, unknown>): string {
	const name = typeof example.name === "string" && example.name !== "" ? example.name : exampleId;
	const status = typeof example.status === "number" ? ` (status ${example.status})` : "";
	return `"${name}"${status}`;
}
