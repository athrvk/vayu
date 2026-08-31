/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The rules the palette ranks by, against the function that holds them.
 *
 * `CommandPalette.test.tsx` pins the reported symptom through the DOM, which is
 * where a wiring bug shows up. These cover the rules themselves - the floor's
 * two edges, what a deep source's word is worth, where an escape row may and may
 * not go - which a rendered list can only assert one example of at a time.
 */

import { describe, it, expect } from "vitest";

import { rankPalette, scoreItem, MATCH_FLOOR } from "./ranking";
import type { PaletteItem, PaletteKind } from "./types";

function item(overrides: Partial<PaletteItem> & { id: string; kind: PaletteKind }): PaletteItem {
	return { title: overrides.id, perform: () => {}, ...overrides };
}

/** Every row that renders, in visible order, top result first. */
function rendered(items: PaletteItem[], query: string): string[] {
	const ranked = rankPalette(items, query);
	return [
		...ranked.top.map((i) => i.id),
		...ranked.groups.flatMap((g) => [...g.items, ...g.escapes].map((i) => i.id)),
	];
}

describe("the relevance floor", () => {
	it("keeps a match that begins mid-word", () => {
		// "oken" finds "Issue token" by one SCORE_CHARACTER_JUMP. This is the
		// edge the floor is set just under; raise it past 0.17 and this reds.
		const request = item({ id: "r1", kind: "request", title: "Issue token" });
		expect(scoreItem(request, "oken")).toBeGreaterThanOrEqual(MATCH_FLOOR);
		expect(rendered([request], "oken")).toEqual(["r1"]);
	});

	it("drops a row the query only reaches by scattered jumps", () => {
		// The reported noise: a t, an h, an e, an m and an e, in five places.
		const request = item({
			id: "r1",
			kind: "request",
			title: "Load test the current request",
		});
		expect(scoreItem(request, "theme")).toBeLessThan(MATCH_FLOOR);
		expect(rendered([request], "theme")).toEqual([]);
	});

	it("does not apply to the empty query, which is not a search", () => {
		const request = item({ id: "r1", kind: "request", title: "Charge card" });
		expect(rendered([request], "")).toEqual(["r1"]);
	});
});

describe("substring keywords", () => {
	const request = item({
		id: "r1",
		kind: "request",
		title: "Issue token",
		// The measured worst case: fuzzily this path scores 0.51 for "theme",
		// which is well clear of any floor that would not also drop real matches.
		substringKeywords: ["/the/most/expensive/endpoint"],
	});

	it("finds a request by a piece of its URL", () => {
		expect(rendered([request], "/most/expensive")).toEqual(["r1"]);
	});

	it("is not a subsequence matcher, which is the whole point", () => {
		// Every letter of "theme" is in that path, in order. Put the URL back in
		// the fuzzy corpus and this row outranks the setting the user wanted.
		expect(scoreItem(request, "theme")).toBe(0);
		expect(rendered([request], "theme")).toEqual([]);
	});

	it("wants the separators too - the cost of not being a subsequence matcher", () => {
		// A URL is all separators, so a scorer reads a query scattered across
		// its segments as a series of *word* jumps and scores it highly - which
		// is the soup. There is no threshold that keeps "mostexpensive" and
		// drops "theme", so a skipped separator is a miss. Recorded, not fixed.
		expect(rendered([request], "most/expensive")).toEqual(["r1"]);
		expect(rendered([request], "mostexpensive")).toEqual([]);
	});

	it("loses to a row whose name actually says what was typed", () => {
		const setting = item({ id: "s1", kind: "settings", title: "Refunds", preMatched: true });
		expect(rankPalette([request, setting], "refunds").top.map((i) => i.id)).toEqual(["s1"]);
	});
});

describe("a deep source's word", () => {
	// The engine matched this run on snapshot text no row prints, so nothing
	// on the row itself matches the query.
	const run = item({ id: "run1", kind: "run", title: "Nothing alike", preMatched: true });

	it("keeps a row whose own text does not match", () => {
		expect(rendered([run], "checkout")).toEqual(["run1"]);
	});

	it("does not make it the top result - there is nothing on screen to justify one", () => {
		expect(rankPalette([run], "checkout").top).toEqual([]);
	});

	it("orders its rows by what they print, keeping the source's order among equals", () => {
		// Four runs the engine matched. Two print the query, two matched on
		// snapshot text no row prints. Inside the section the visible ones lead,
		// and the pair that prints nothing keeps the order the engine sent -
		// newest first - because the sort is stable. All four still render: a
		// deep source's word is what got them in, and only their order is ours.
		const run = (id: string, title: string) =>
			item({ id, kind: "run", title, preMatched: true });
		const items = [
			run("hidden-newer", "Nothing alike"),
			run("hidden-older", "Nothing alike"),
			run("weak", "Old checkout attempt"),
			run("best", "checkout"),
		];

		const ranked = rankPalette(items, "checkout");
		// The strongest is promoted out of the section entirely.
		expect(ranked.top.map((i) => i.id)).toEqual(["best"]);
		expect(ranked.groups.find((g) => g.kind === "run")?.items.map((i) => i.id)).toEqual([
			"weak",
			"hidden-newer",
			"hidden-older",
		]);
	});

	it("is a property of the row, not of its kind", () => {
		// The command registry contributes `settings` rows too, one per panel,
		// and those are ordinary shallow rows that must clear the floor.
		const panel = item({ id: "panel", kind: "settings", title: "Load testing" });
		expect(rendered([panel], "checkout")).toEqual([]);
	});
});

describe("the top result", () => {
	const setting = item({ id: "theme", kind: "settings", title: "Theme Mode", preMatched: true });
	// Matches "theme" too (0.891 against the setting's 0.990), so it renders -
	// it just is not the best match.
	const request = item({ id: "r1", kind: "request", title: "Refresh theme endpoint" });

	it("is lifted out of its own section rather than copied into a new one", () => {
		const ranked = rankPalette([request, setting], "theme");
		expect(ranked.top.map((i) => i.id)).toEqual(["theme"]);
		// Two rows carrying the same `value` would both read as selected.
		expect(ranked.groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(["r1"]);
	});

	it("breaks a tie by the order the sections appear in", () => {
		const tab = item({ id: "t1", kind: "tab", title: "Inbox" });
		const view = item({ id: "v1", kind: "view", title: "Inbox" });
		expect(rankPalette([view, tab], "inbox").top.map((i) => i.id)).toEqual(["t1"]);
	});

	it("is absent from the empty query, which has asked for nothing", () => {
		expect(rankPalette([request], "").top).toEqual([]);
	});
});

describe("escape rows", () => {
	const escape = item({
		id: "more",
		kind: "settings",
		title: "Search settings for…",
		escape: true,
	});
	const setting = item({ id: "s1", kind: "settings", title: "Theme Mode", preMatched: true });

	it("render below the results of the section they escape", () => {
		expect(rendered([escape, setting], "theme")).toEqual(["s1", "more"]);
	});

	it("are never promoted, however well they match", () => {
		// The case that makes the guard load-bearing: the deep source matched
		// this row on text the row does not print, so it scores nothing, while
		// the escape row echoes the query by construction and scores near 1.
		// Without the guard the way *out* of the results becomes the top result.
		const hidden = item({ id: "s1", kind: "settings", title: "Cache Size", preMatched: true });
		const echo = item({
			id: "more",
			kind: "settings",
			title: "Search settings for “theme”…",
			escape: true,
		});
		expect(rankPalette([echo, hidden], "theme").top).toEqual([]);
		expect(rendered([echo, hidden], "theme")).toEqual(["s1", "more"]);
	});

	it("are not counted - the announcement answers whether the query narrowed anything", () => {
		expect(rankPalette([escape, setting], "theme").total).toBe(1);
	});
});

describe("the announced total", () => {
	it("counts every row that renders and nothing that does not", () => {
		const items = [
			item({ id: "hit", kind: "settings", title: "Theme Mode", preMatched: true }),
			item({ id: "noise", kind: "request", title: "Load test the current request" }),
		];
		const ranked = rankPalette(items, "theme");
		expect(ranked.total).toBe(rendered(items, "theme").length);
		expect(ranked.total).toBe(1);
	});
});
