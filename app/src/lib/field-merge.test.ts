/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { mergeExternalWrite } from "./field-merge";

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
});
