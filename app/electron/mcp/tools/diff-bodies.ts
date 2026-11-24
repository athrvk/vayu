/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @brief `diff_bodies` (#3705): the bounded difference between two stored
 *        bodies - RFC 6901 pointers for two JSON bodies, a line diff for other
 *        text, and equal / not equal for a binary one.
 *
 * Both nodes are read *as masked*: the caller masks the two records in one
 * pass first, so a secret that differs between them is `<redacted>` on both
 * sides and is no difference, and every size counts the masked bytes.
 */

import { boundText, MAX_INLINE_BODY_BYTES } from "./inline-body-bounds.js";
import { isRecord } from "./kit.js";
import {
	contentOf,
	escapeToken,
	NumberText,
	parseJsonBody,
	serializeSorted,
	type BodyContent,
} from "./read-body.js";

/** The longest `old` / `new` one difference carries; `read_body` reads a whole one. */
export const MAX_DIFF_VALUE_BYTES = 512;

/**
 * The largest changed region a line diff aligns, in lines of one side times
 * lines of the other: the table it fills costs 4 bytes a cell, so 4 MB. Past
 * it the region is listed whole, removed then added (`coarse`).
 */
export const MAX_LINE_DIFF_CELLS = 1_000_000;

type DiffOp = "changed" | "added" | "removed";

/** One difference as the answer lists it: at a JSON `pointer`, or a text `line`. */
export interface BodyDifference {
	op: DiffOp;
	pointer?: string;
	/** 1-based, in `a` for a removed line and in `b` for an added one. */
	line?: number;
	/** From `a`: compact JSON for a JSON body, the line for text. */
	old?: string;
	/** From `b`, as `old` is from `a`. */
	new?: string;
	/** `old` or `new` was cut to {@link MAX_DIFF_VALUE_BYTES}. */
	truncated?: true;
}

interface SideFacts {
	totalBytes: number;
	encoding: BodyContent["encoding"];
	storedTruncated?: true;
}

export interface BodyDiff {
	kind: "json" | "text" | "binary";
	/** No difference found; for a binary pair, the same bytes. */
	equal: boolean;
	a: SideFacts;
	b: SideFacts;
	/** The changed region was too large to align, so it is listed whole. */
	coarse?: true;
	/** Every difference found; absent on a binary pair, which is not diffed. */
	differenceCount?: number;
	differences?: BodyDifference[];
	/** `differenceCount` less those listed: 0 is a complete diff. */
	omitted?: number;
}

/** A difference before its values are cut into text, which only a listed one pays for. */
type RawDifference =
	| { op: "changed"; pointer: string; old: unknown; new: unknown }
	| { op: "removed"; pointer: string; old: unknown }
	| { op: "added"; pointer: string; new: unknown }
	| { op: "removed"; line: number; old: string }
	| { op: "added"; line: number; new: string };

function factsOf(content: BodyContent): SideFacts {
	return {
		totalBytes: content.bytes.length,
		encoding: content.encoding,
		...(content.storedTruncated ? { storedTruncated: true } : {}),
	};
}

/**
 * The difference between the bodies on two (masked) nodes, its listed entries
 * cut so the whole answer serializes to at most {@link MAX_INLINE_BODY_BYTES}.
 */
export function diffBodies(
	nodeA: Record<string, unknown>,
	nodeB: Record<string, unknown>
): BodyDiff {
	const a = contentOf(nodeA);
	const b = contentOf(nodeB);
	const sides = { a: factsOf(a), b: factsOf(b) };
	if (a.encoding === "base64" || b.encoding === "base64") {
		return { kind: "binary", equal: a.bytes.equals(b.bytes), ...sides };
	}
	const jsonA = parseJsonBody(a);
	const jsonB = jsonA === undefined ? undefined : parseJsonBody(b);
	if (jsonA !== undefined && jsonB !== undefined) {
		return listWithin(
			{ kind: "json", ...sides },
			jsonDifferences(jsonA.value, jsonB.value, "")
		);
	}
	const lines = lineDiff(a.bytes.toString("utf8"), b.bytes.toString("utf8"));
	return listWithin(
		{ kind: "text", ...sides, ...(lines.coarse ? { coarse: true } : {}) },
		lines.differences
	);
}

// --- Bounding ----------------------------------------------------------------

/** A value as the answer carries it, and whether it was cut. */
function valueText(value: unknown, isLine: boolean): { text: string; truncated: boolean } {
	return boundText(isLine ? (value as string) : serializeSorted(value), MAX_DIFF_VALUE_BYTES);
}

function listed(raw: RawDifference): BodyDifference {
	const isLine = "line" in raw;
	const entry: BodyDifference = isLine
		? { op: raw.op, line: raw.line }
		: { op: raw.op, pointer: raw.pointer };
	let truncated = false;
	if ("old" in raw) {
		const old = valueText(raw.old, isLine);
		entry.old = old.text;
		truncated ||= old.truncated;
	}
	if ("new" in raw) {
		const next = valueText(raw.new, isLine);
		entry.new = next.text;
		truncated ||= next.truncated;
	}
	return truncated ? { ...entry, truncated: true } : entry;
}

/**
 * @p envelope with the differences of @p found that fit: a prefix of them in
 * their order, so the omitted ones are exactly the tail, and every one counted.
 */
function listWithin(
	envelope: Omit<BodyDiff, "equal" | "differenceCount" | "differences" | "omitted">,
	found: Iterable<RawDifference>
): BodyDiff {
	// The counts are not known until the walk ends, so the envelope is measured
	// with the widest they can be.
	const widest = Number.MAX_SAFE_INTEGER;
	let room =
		MAX_INLINE_BODY_BYTES -
		Buffer.byteLength(
			JSON.stringify({
				...envelope,
				equal: false,
				differenceCount: widest,
				differences: [],
				omitted: widest,
			})
		);
	const differences: BodyDifference[] = [];
	let count = 0;
	let full = false;
	for (const raw of found) {
		count++;
		if (full) continue;
		const entry = listed(raw);
		// One more for the comma that joins it to the one before.
		const cost = Buffer.byteLength(JSON.stringify(entry)) + 1;
		if (cost > room) {
			full = true;
			continue;
		}
		room -= cost;
		differences.push(entry);
	}
	const { kind, ...sides } = envelope;
	return {
		kind,
		equal: count === 0,
		...sides,
		differenceCount: count,
		differences,
		omitted: count - differences.length,
	};
}

// --- JSON ----------------------------------------------------------------------

/** Two parsed leaves (or a leaf and a container) are the same value, numbers by their source text. */
function sameLeaf(a: unknown, b: unknown): boolean {
	if (a instanceof NumberText && b instanceof NumberText) return a.source === b.source;
	return a === b;
}

/**
 * The differences between two parses, in document order of sorted keys: an
 * object's keys in sorted order, an array by index, a subtree only one side
 * holds reported once at its root rather than walked.
 */
function* jsonDifferences(a: unknown, b: unknown, pointer: string): Generator<RawDifference> {
	if (Array.isArray(a) && Array.isArray(b)) {
		yield* arrayDifferences(a, b, pointer);
	} else if (
		isRecord(a) &&
		isRecord(b) &&
		!(a instanceof NumberText) &&
		!(b instanceof NumberText)
	) {
		yield* objectDifferences(a, b, pointer);
	} else if (!sameLeaf(a, b)) {
		yield { op: "changed", pointer, old: a, new: b };
	}
}

function* arrayDifferences(a: unknown[], b: unknown[], pointer: string): Generator<RawDifference> {
	const longest = Math.max(a.length, b.length);
	for (let at = 0; at < longest; at++) {
		const here = `${pointer}/${at}`;
		if (at >= b.length) yield { op: "removed", pointer: here, old: a[at] };
		else if (at >= a.length) yield { op: "added", pointer: here, new: b[at] };
		else yield* jsonDifferences(a[at], b[at], here);
	}
}

function* objectDifferences(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	pointer: string
): Generator<RawDifference> {
	const has = (object: Record<string, unknown>, key: string) =>
		Object.prototype.hasOwnProperty.call(object, key);
	const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
	for (const key of keys) {
		const here = `${pointer}/${escapeToken(key)}`;
		if (!has(b, key)) yield { op: "removed", pointer: here, old: a[key] };
		else if (!has(a, key)) yield { op: "added", pointer: here, new: b[key] };
		else yield* jsonDifferences(a[key], b[key], here);
	}
}

// --- Text ----------------------------------------------------------------------

/**
 * The lines of @p a removed and of @p b added, in order. The lines both start
 * and end with are trimmed first; the region between is aligned by its longest
 * common subsequence, or listed whole when it is past {@link MAX_LINE_DIFF_CELLS}.
 */
function lineDiff(a: string, b: string): { coarse: boolean; differences: RawDifference[] } {
	const linesA = a.split("\n");
	const linesB = b.split("\n");
	let head = 0;
	while (head < linesA.length && head < linesB.length && linesA[head] === linesB[head]) head++;
	let tail = 0;
	while (
		tail < linesA.length - head &&
		tail < linesB.length - head &&
		linesA[linesA.length - 1 - tail] === linesB[linesB.length - 1 - tail]
	) {
		tail++;
	}
	const middleA = linesA.slice(head, linesA.length - tail);
	const middleB = linesB.slice(head, linesB.length - tail);
	const coarse = middleA.length * middleB.length > MAX_LINE_DIFF_CELLS;
	const differences = coarse
		? [
				...middleA.map((old, at) => ({ op: "removed" as const, line: head + at + 1, old })),
				...middleB.map((next, at) => ({
					op: "added" as const,
					line: head + at + 1,
					new: next,
				})),
			]
		: alignedLines(middleA, middleB, head);
	return { coarse, differences };
}

/**
 * The removed and added lines between @p a and @p b, aligned on their longest
 * common subsequence. @p base is the line count trimmed before them.
 */
function alignedLines(a: string[], b: string[], base: number): RawDifference[] {
	const width = b.length + 1;
	// common[i * width + j]: the longest common subsequence of a[i..] and b[j..].
	const common = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			common[i * width + j] =
				a[i] === b[j]
					? common[(i + 1) * width + j + 1] + 1
					: Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
		}
	}
	const out: RawDifference[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			i++;
			j++;
		} else if (
			j >= b.length ||
			(i < a.length && common[(i + 1) * width + j] >= common[i * width + j + 1])
		) {
			out.push({ op: "removed", line: base + i + 1, old: a[i] });
			i++;
		} else {
			out.push({ op: "added", line: base + j + 1, new: b[j] });
			j++;
		}
	}
	return out;
}
