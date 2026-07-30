/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { SkippedItem } from "./types";

export type RefResolver = (ref: string) => unknown;

/**
 * Helpers shared by the two OpenAPI/Swagger parsers. They are structural clones of
 * each other, which is how both ended up with the same unguarded `parameters` spread
 * and the same hardcoded `skipped: []`; a second copy of these three would drift the
 * same way.
 */

/**
 * Resolve a Path Item Object that is itself `{"$ref": "..."}` - legal in 3.0 and 3.1,
 * and what bundlers emit when they hoist a shared path item into `components.pathItems`.
 * Such an item carries no method keys, so an unresolved one drops every operation under
 * that path.
 *
 * Single-hop, like the parameter and `requestBody` refs the parsers already resolve: a
 * ref-to-a-ref is not a shape generators emit, and chasing one needs a cycle guard.
 * Returns `undefined` when there is nothing iterable to read methods off, so the caller
 * records the drop instead of silently looping over a non-object.
 */
export function resolvePathItem(
	pathItem: unknown,
	resolveRef: RefResolver
): Record<string, unknown> | undefined {
	if (!pathItem || typeof pathItem !== "object") return undefined;
	const ref = (pathItem as { $ref?: unknown }).$ref;
	if (typeof ref !== "string") return pathItem as Record<string, unknown>;
	let resolved: unknown;
	try {
		resolved = resolveRef(ref);
	} catch {
		return undefined;
	}
	return resolved && typeof resolved === "object"
		? (resolved as Record<string, unknown>)
		: undefined;
}

/**
 * Running count of what a parse had to drop, emitted as `meta.skipped` so the import
 * preview (`ImportModal`) can name it. Insertion-ordered, and only non-zero kinds are
 * emitted - an empty tally yields `[]`, exactly what both parsers used to hardcode.
 */
export class SkipTally {
	private readonly counts = new Map<SkippedItem["kind"], number>();

	add(kind: SkippedItem["kind"], count = 1): void {
		if (count <= 0) return;
		this.counts.set(kind, (this.counts.get(kind) ?? 0) + count);
	}

	/**
	 * The `parameters` of a path item or operation, guarded. The spec says array; a
	 * missing `-` in hand-written YAML makes it a mapping, and spreading that threw
	 * `not iterable` and aborted the whole file. Absent is normal and not counted;
	 * present-but-not-an-array is stepped over and tallied.
	 */
	params(parameters: unknown): unknown[] {
		if (Array.isArray(parameters)) return parameters;
		if (parameters != null) this.add("malformed_spec");
		return [];
	}

	items(): SkippedItem[] {
		return [...this.counts].map(([kind, count]) => ({ kind, count }));
	}
}
