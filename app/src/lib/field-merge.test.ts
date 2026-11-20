/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { mergeExternalWrite } from "./field-merge";
import { sameRows } from "@/components/shared/KeyValueEditor/key-value";
import type { KeyValueItem } from "@/types";

interface Draft {
	name: string;
	tags: string[];
	count: number;
}

const FIELDS: readonly (keyof Draft)[] = ["name", "tags", "count"];

describe("mergeExternalWrite", () => {
	it("leaves a field alone when the fetch reports the same value as the baseline", () => {
		const baseline: Draft = { name: "a", tags: ["x"], count: 1 };
		const current: Draft = { name: "a typed edit", tags: ["x"], count: 1 };
		const incoming: Draft = { name: "a", tags: ["x"], count: 1 };

		const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, new Set());

		expect(outcome.changed).toBe(false);
		expect(outcome.patch).toEqual({});
		expect(outcome.conflicts).toEqual({});
	});

	it("adopts an untouched field's external change into the patch", () => {
		const baseline: Draft = { name: "a", tags: ["x"], count: 1 };
		const current: Draft = { name: "a", tags: ["x"], count: 1 };
		const incoming: Draft = { name: "b", tags: ["x"], count: 1 };

		const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, new Set());

		expect(outcome.changed).toBe(true);
		expect(outcome.patch).toEqual({ name: "b" });
		expect(outcome.nextBaseline).toEqual({ name: "b", tags: ["x"], count: 1 });
		expect(outcome.conflicts).toEqual({});
	});

	it("compares array and object fields by content, not by reference", () => {
		// `tags` is a fresh array on both sides but the same content - a naive
		// `===` compare (InfoTab's `mergeField`, correct there since its fields
		// are plain strings) would call this an external change on every fetch.
		const baseline: Draft = { name: "a", tags: ["x", "y"], count: 1 };
		const current: Draft = { name: "a", tags: ["x", "y"], count: 1 };
		const incoming: Draft = { name: "a", tags: [...baseline.tags], count: 1 };

		const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, new Set());

		expect(outcome.changed).toBe(false);
	});

	it("keeps a touched field's draft value and reports the conflict, without moving its baseline", () => {
		const baseline: Draft = { name: "a", tags: ["x"], count: 1 };
		const current: Draft = { name: "typed", tags: ["x"], count: 1 };
		const incoming: Draft = { name: "agent-written", tags: ["x"], count: 1 };

		const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, new Set(["name"]));

		expect(outcome.changed).toBe(true);
		expect(outcome.patch).toEqual({});
		expect(outcome.conflicts).toEqual({ name: "agent-written" });
		// The conflicted field's baseline stays put, so a still-unresolved
		// conflict keeps being detected on the next call rather than silently
		// resolving itself.
		expect(outcome.nextBaseline.name).toBe("a");
	});

	it("resolves a touched field with no conflict when the draft already matches the fetch", () => {
		// The save's own echo: the user's edit and the fetch now agree.
		const baseline: Draft = { name: "a", tags: ["x"], count: 1 };
		const current: Draft = { name: "typed", tags: ["x"], count: 1 };
		const incoming: Draft = { name: "typed", tags: ["x"], count: 1 };

		const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, new Set(["name"]));

		expect(outcome.changed).toBe(true);
		expect(outcome.patch).toEqual({});
		expect(outcome.conflicts).toEqual({});
		expect(outcome.nextBaseline.name).toBe("typed");
	});

	it("treats independent fields independently in one call", () => {
		const baseline: Draft = { name: "a", tags: ["x"], count: 1 };
		const current: Draft = { name: "a", tags: ["typed"], count: 1 };
		const incoming: Draft = { name: "b", tags: ["y"], count: 2 };

		const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, new Set(["tags"]));

		// `name` and `count` are untouched: adopted. `tags` is touched and
		// conflicts, since the draft's `["typed"]` disagrees with the fetch's `["y"]`.
		expect(outcome.patch).toEqual({ name: "b", count: 2 });
		expect(outcome.conflicts).toEqual({ tags: ["y"] });
		expect(outcome.nextBaseline).toEqual({ name: "b", tags: ["x"], count: 2 });
	});

	describe("a field with its own equality (#3663)", () => {
		interface Table {
			rows: KeyValueItem[];
		}
		const ROWS: readonly (keyof Table)[] = ["rows"];
		const OPTIONS = { equals: { rows: sameRows } };
		const header = (id: string, value: string): KeyValueItem => ({
			id,
			key: "X-One",
			value,
			enabled: true,
		});

		it("reads rows equal but for their ids as no change", () => {
			// A refetch rebuilds every row with a fresh id; a JSON compare reads
			// that as an external write on every fetch.
			const baseline: Table = { rows: [header("a", "1")] };
			const incoming: Table = { rows: [header("fresh", "1")] };

			const outcome = mergeExternalWrite(
				ROWS,
				baseline,
				baseline,
				incoming,
				new Set(),
				OPTIONS
			);

			expect(outcome.changed).toBe(false);
			expect(outcome.patch).toEqual({});
		});

		it("resolves a touched table the fetch agrees with but for ids, with no conflict", () => {
			const baseline: Table = { rows: [header("a", "1")] };
			const current: Table = { rows: [header("a", "2")] };
			const incoming: Table = { rows: [header("fresh", "2")] };

			const outcome = mergeExternalWrite(
				ROWS,
				current,
				baseline,
				incoming,
				new Set(["rows"]),
				OPTIONS
			);

			expect(outcome.conflicts).toEqual({});
			expect(outcome.nextBaseline.rows).toBe(incoming.rows);
		});

		it("still reports a touched table whose content the fetch changed", () => {
			const baseline: Table = { rows: [header("a", "1")] };
			const current: Table = { rows: [header("a", "2")] };
			const incoming: Table = { rows: [header("fresh", "3")] };

			const outcome = mergeExternalWrite(
				ROWS,
				current,
				baseline,
				incoming,
				new Set(["rows"]),
				OPTIONS
			);

			expect(outcome.conflicts).toEqual({ rows: incoming.rows });
		});

		it("reads a table equal to what the save sent but for ids as its echo", () => {
			const baseline: Table = { rows: [header("a", "1")] };
			const current: Table = { rows: [header("a", "3")] };
			const incoming: Table = { rows: [header("fresh", "2")] };

			const outcome = mergeExternalWrite(
				ROWS,
				current,
				baseline,
				incoming,
				new Set(["rows"]),
				{
					...OPTIONS,
					sent: [{ rows: [header("a", "2")] }],
				}
			);

			expect(outcome.conflicts).toEqual({});
			expect(outcome.nextBaseline.rows).toBe(incoming.rows);
		});
	});

	describe("the echo of the caller's own save (#3664)", () => {
		// Saved "ab", typed on to "abc" before the save's answer came back.
		const baseline: Draft = { name: "a", tags: ["x"], count: 1 };
		const current: Draft = { name: "abc", tags: ["x"], count: 1 };
		const touched = new Set<keyof Draft>(["name"]);

		it("moves the baseline to the echo and raises no conflict, leaving the draft ahead", () => {
			const incoming: Draft = { name: "ab", tags: ["x"], count: 1 };

			const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, touched, {
				sent: [{ name: "ab" }],
			});

			expect(outcome.changed).toBe(true);
			expect(outcome.conflicts).toEqual({});
			expect(outcome.patch).toEqual({});
			expect(outcome.nextBaseline.name).toBe("ab");
		});

		it("still conflicts on a value the save did not send", () => {
			const incoming: Draft = { name: "other", tags: ["x"], count: 1 };

			const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, touched, {
				sent: [{ name: "ab" }],
			});

			expect(outcome.conflicts).toEqual({ name: "other" });
			expect(outcome.nextBaseline.name).toBe("a");
		});

		it("still conflicts on a field the save did not send", () => {
			const incoming: Draft = { name: "a", tags: ["y"], count: 1 };

			const outcome = mergeExternalWrite(
				FIELDS,
				{ ...current, tags: ["typed"] },
				baseline,
				incoming,
				new Set(["name", "tags"]),
				{ sent: [{ name: "ab" }] }
			);

			expect(outcome.conflicts).toEqual({ tags: ["y"] });
		});

		it("compares against the sent value with the field's own equality", () => {
			const caseless = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
			const incoming: Draft = { name: "AB", tags: ["x"], count: 1 };

			const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, touched, {
				equals: { name: caseless },
				sent: [{ name: "ab" }],
			});

			expect(outcome.conflicts).toEqual({});
			expect(outcome.nextBaseline.name).toBe("AB");
		});

		it("recognises the echo of an earlier save in the list, not only the newest", () => {
			// Save one sent "ab", save two (queued behind it) sent "abc" for a
			// different field set; save one's echo lands after save two started.
			const incoming: Draft = { name: "ab", tags: ["x"], count: 1 };

			const outcome = mergeExternalWrite(FIELDS, current, baseline, incoming, touched, {
				sent: [{ name: "ab" }, { count: 2 }],
			});

			expect(outcome.conflicts).toEqual({});
			expect(outcome.nextBaseline.name).toBe("ab");
		});
	});
});
