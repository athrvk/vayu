/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Narrowing helpers for the foreign documents the importers walk.
 *
 * An imported file is untrusted JSON: any node can be missing, `null`, a scalar
 * where an object was promised, or an object where an array was. The parsers
 * already check before they read - these give that checking a type, so a walk
 * states what it expects at each hop instead of `any` making every access look
 * safe. One copy, because all four parsers walk the same kind of document.
 */

/** A JSON object node. Every property is `unknown` until it is narrowed. */
export type JsonRecord = Record<string, unknown>;

/** A node that is a JSON object (not an array, not `null`), else `undefined`. */
export function asRecord(v: unknown): JsonRecord | undefined {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonRecord) : undefined;
}

/** A node's array form, or `[]` - callers step over a non-array rather than throwing. */
export function asArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

/** A node that is a string, else `undefined`. Never coerces - see `asString` for that. */
export function asStr(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** Read property `key` off a node that may not be an object at all. */
export function prop(v: unknown, key: string): unknown {
	return asRecord(v)?.[key];
}
