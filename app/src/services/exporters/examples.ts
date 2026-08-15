/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Stored examples as an operation's `responses`, for both export directions
 * (issue #630).
 *
 * One implementation, because it is one decision made twice: a bound document
 * writes examples into responses it may already declare, and a skeleton writes
 * them into responses that do not exist yet, but *which* status, *which* media
 * type, and what to do about a second example of the same pair are the same
 * questions with the same answers. The two directions differ in one flag - a
 * skeleton derives a schema from the example it just wrote, a bound document
 * never does, because the document's own schema is the contract and a shape read
 * off one sample must not overwrite it.
 */

import { asRecord, type JsonRecord } from "@/lib/json-node";
import type { RequestExample } from "@/types";
import type { ExportNotes } from "./openapi";
import { exampleValue, schemaFromExample } from "./payload";

export interface WriteExamplesOptions {
	/** Write a shape derived from the example beside it when the node declares none. */
	deriveSchema: boolean;
}

export function writeResponseExamples(
	responses: JsonRecord,
	examples: readonly RequestExample[],
	notes: ExportNotes,
	options: WriteExamplesOptions
): void {
	for (const [status, group] of groupBy(examples, (example) => String(example.status))) {
		const existing = asRecord(responses[status]);
		// A Response Object's `description` is required, so one has to be written
		// for a status the document does not already document. The example's own
		// name is what the user (or the import) called it, which beats a generated
		// line - and an existing description is never replaced.
		const response = existing ?? { description: group[0].name || `${status} response` };
		if (!existing) responses[status] = response;

		const withMediaType = group.filter((example) => {
			if (example.contentType) return true;
			// No honest `content` key exists for a body whose media type nobody
			// stated. The response still lands - a 204 documents itself - and the
			// count says a body was left out.
			notes.examplesWithoutMediaType += 1;
			return false;
		});
		if (withMediaType.length === 0) continue;

		const content = childRecord(response, "content");
		for (const [contentType, mediaGroup] of groupBy(withMediaType, (e) => e.contentType)) {
			const media = childRecord(content, contentType);
			const values = mediaGroup.map((example) => exampleValue(example.body));
			if (options.deriveSchema && media.schema === undefined) {
				media.schema = schemaFromExample(values[0]);
			}
			// One of `example` / `examples`, never both: OpenAPI states they are
			// mutually exclusive, and a stale one left beside the one just written
			// is a second answer to the same question.
			if (mediaGroup.length === 1) {
				media.example = values[0];
				delete media.examples;
			} else {
				media.examples = namedExamples(mediaGroup, values);
				delete media.example;
			}
			notes.examplesWritten += mediaGroup.length;
		}
	}
}

/**
 * Several examples of one status and media type, as an `examples` map.
 *
 * Keyed by the example's name, which is what a reader of the document sees. A
 * name two examples share is suffixed rather than allowed to overwrite - losing
 * an example to a key collision is exactly the silent drop this export may not
 * make.
 */
function namedExamples(
	examples: readonly RequestExample[],
	values: readonly unknown[]
): JsonRecord {
	const out: JsonRecord = {};
	examples.forEach((example, index) => {
		const wanted = example.name || `example-${index + 1}`;
		let key = wanted;
		let suffix = 2;
		while (key in out) key = `${wanted}-${suffix++}`;
		out[key] = { value: values[index] };
	});
	return out;
}

/** The object at `node[key]`, created empty when it is missing or not an object. */
export function childRecord(node: JsonRecord, key: string): JsonRecord {
	const existing = asRecord(node[key]);
	if (existing) return existing;
	const created: JsonRecord = {};
	node[key] = created;
	return created;
}

export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const existing = map.get(key);
		if (existing) existing.push(item);
		else map.set(key, [item]);
	}
	return map;
}
