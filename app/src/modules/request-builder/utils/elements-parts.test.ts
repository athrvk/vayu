/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `elementsParts` walks the collection chain's elements, root to leaf, then
 * the request's own (issue #1512), honouring an `inherit.disable` entry at any
 * level (#3070) that suppresses one element by id.
 * `scriptTextFor` (re-exported from `@/lib/elements`) is covered here too,
 * since this is the one place both are consumed together.
 */

import { describe, it, expect } from "vitest";
import {
	elementsParts,
	hasReplayedPostScript,
	scriptTextFor,
	withoutDisabled,
	withoutInheritedCollectionOnly,
} from "./elements-parts";
import type { Collection, ElementDef } from "@/types";

/** Minimal `Collection` fixture - only `id`, `name` and `elements` matter here. */
function collection(id: string, name: string, elements: ElementDef[] = []): Collection {
	return {
		id,
		name,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements,
		createdAt: "",
		updatedAt: "",
	};
}

function element(overrides: Partial<ElementDef> & { id: string; kind: string }): ElementDef {
	return { enabled: true, config: {}, ...overrides };
}

describe("elementsParts", () => {
	it("walks the chain root to leaf, then the request's own, stamping each origin", () => {
		const chain: Collection[] = [
			collection("root", "Root", [element({ id: "r1", kind: "script.pre" })]),
			collection("leaf", "Leaf", [element({ id: "l1", kind: "extract.json" })]),
		];
		const requestElements: ElementDef[] = [element({ id: "req1", kind: "assert.status" })];

		const parts = elementsParts(chain, "req_1", requestElements);

		expect(parts).toEqual([
			{
				id: "r1",
				kind: "script.pre",
				enabled: true,
				config: {},
				origin: { kind: "collection", scope: "collection", id: "root", name: "Root" },
			},
			{
				id: "l1",
				kind: "extract.json",
				enabled: true,
				config: {},
				origin: { kind: "collection", scope: "folder", id: "leaf", name: "Leaf" },
			},
			{
				id: "req1",
				kind: "assert.status",
				enabled: true,
				config: {},
				origin: { kind: "request", scope: "request", id: "req_1" },
			},
		]);
	});

	it("stamps the root as collection, every collection below it as folder, and the request as request", () => {
		// What the engine stamps for a stored request's chain (issue #2522): an
		// inline Send reports the same level for the same script, so a folder's
		// failing test is not blamed on the collection.
		const chain: Collection[] = [
			collection("root", "Root", [element({ id: "r1", kind: "script.pre" })]),
			collection("mid", "Mid", [element({ id: "m1", kind: "script.pre" })]),
			collection("leaf", "Leaf", [element({ id: "l1", kind: "script.post" })]),
		];
		const parts = elementsParts(chain, "req_1", [element({ id: "q1", kind: "script.post" })]);

		expect(parts?.map((p) => [p.id, p.origin?.kind, p.origin?.scope])).toEqual([
			["r1", "collection", "collection"],
			["m1", "collection", "folder"],
			["l1", "collection", "folder"],
			["q1", "request", "request"],
		]);
	});

	it("suppresses the matching ancestor element by id when the request disables it", () => {
		const chain: Collection[] = [
			collection("root", "Root", [
				element({ id: "r1", kind: "script.pre" }),
				element({ id: "r2", kind: "extract.json" }),
			]),
		];
		const requestElements: ElementDef[] = [
			element({ id: "disable-r1", kind: "inherit.disable", config: { elementId: "r1" } }),
		];

		const parts = elementsParts(chain, "req_1", requestElements);

		// r1 is suppressed; r2 still runs, and the disable entry itself is never
		// forwarded as an element of the request's own.
		expect(parts?.map((p) => p.id)).toEqual(["r2"]);
	});

	describe("an inherit.disable entry on a chain level (#3070)", () => {
		const disable = (id: string, elementId: string) =>
			element({ id, kind: "inherit.disable", config: { elementId } });

		it("lets a folder suppress an element of the root, and is itself never a part", () => {
			const chain: Collection[] = [
				collection("root", "Root", [
					element({ id: "loop", kind: "control.loop" }),
					element({ id: "r2", kind: "extract.json" }),
				]),
				collection("folder", "Folder", [disable("d1", "loop")]),
			];

			const parts = elementsParts(chain, "req_1", []);

			expect(parts?.map((p) => p.id)).toEqual(["r2"]);
		});

		it("lets the root suppress an element of a folder", () => {
			const chain: Collection[] = [
				collection("root", "Root", [disable("d1", "f1")]),
				collection("folder", "Folder", [
					element({ id: "f1", kind: "timer.pacing" }),
					element({ id: "f2", kind: "assert.status" }),
				]),
			];

			expect(elementsParts(chain, "req_1", [])?.map((p) => p.id)).toEqual(["f2"]);
		});

		it("lets a collection suppress the request's own element, as /compose does", () => {
			const chain: Collection[] = [collection("root", "Root", [disable("d1", "q1")])];
			const requestElements = [
				element({ id: "q1", kind: "control.loop" }),
				element({ id: "q2", kind: "assert.status" }),
			];

			expect(elementsParts(chain, "req_1", requestElements)?.map((p) => p.id)).toEqual([
				"q2",
			]);
		});

		it("answers undefined when a chain level holds only a disable entry", () => {
			const chain: Collection[] = [collection("root", "Root", [disable("d1", "nothing")])];

			expect(elementsParts(chain, "req_1", [])).toBeUndefined();
		});

		it("keeps the replayed-post-script verdict in step with the disable", () => {
			const post = element({
				id: "post",
				kind: "script.post",
				config: { script: "pm.test('ok', () => {});" },
			});
			const chain: Collection[] = [
				collection("root", "Root", [post]),
				collection("folder", "Folder", [disable("d1", "post")]),
			];

			expect(hasReplayedPostScript(elementsParts(chain, "req_1", []))).toBe(false);
		});
	});

	it("returns undefined, not an empty list, when the resolved list is empty", () => {
		expect(elementsParts([], "req_1", [])).toBeUndefined();

		// Also when the only thing on the request's own list is a disable entry -
		// it names no element of its own to run, and it consumes nothing that
		// would otherwise render.
		const chain: Collection[] = [collection("root", "Root", [])];
		const requestElements: ElementDef[] = [
			element({ id: "disable-nothing", kind: "inherit.disable", config: { elementId: "x" } }),
		];
		expect(elementsParts(chain, "req_1", requestElements)).toBeUndefined();
	});

	it("suppresses every collection's element that shares the disabled id, not only the first", () => {
		// `disabledAncestorIds` is a set applied across the whole chain - a
		// disable entry is keyed on element id, and ids are unique in practice,
		// but the suppression itself is chain-wide, not scoped to one collection.
		const chain: Collection[] = [
			collection("root", "Root", [element({ id: "shared", kind: "script.pre" })]),
			collection("leaf", "Leaf", [element({ id: "shared", kind: "script.pre" })]),
		];
		const requestElements: ElementDef[] = [
			element({
				id: "disable-shared",
				kind: "inherit.disable",
				config: { elementId: "shared" },
			}),
		];

		expect(elementsParts(chain, "req_1", requestElements)).toBeUndefined();
	});
});

describe("scriptTextFor", () => {
	it("joins multiple enabled elements of one kind with a blank line", () => {
		const elements: ElementDef[] = [
			element({ id: "p1", kind: "script.pre", config: { script: "first();" } }),
			element({ id: "p2", kind: "script.pre", config: { script: "second();" } }),
		];

		expect(scriptTextFor(elements, "script.pre")).toBe("first();\n\nsecond();");
	});

	it("ignores a disabled element of the matching kind", () => {
		const elements: ElementDef[] = [
			element({ id: "p1", kind: "script.pre", enabled: false, config: { script: "off();" } }),
			element({ id: "p2", kind: "script.pre", config: { script: "on();" } }),
		];

		expect(scriptTextFor(elements, "script.pre")).toBe("on();");
	});

	it("ignores an element of the other script kind", () => {
		const elements: ElementDef[] = [
			element({ id: "p1", kind: "script.post", config: { script: "post();" } }),
		];

		expect(scriptTextFor(elements, "script.pre")).toBeUndefined();
	});

	it("returns undefined when nothing matches, rather than an empty string", () => {
		expect(scriptTextFor([], "script.pre")).toBeUndefined();

		// A blank/whitespace-only script is treated the same as none.
		const blank: ElementDef[] = [
			element({ id: "p1", kind: "script.pre", config: { script: "   \n\t" } }),
		];
		expect(scriptTextFor(blank, "script.pre")).toBeUndefined();
	});
});

describe("hasReplayedPostScript", () => {
	const post = (overrides: Partial<ElementDef> = {}, config: Record<string, unknown> = {}) =>
		element({
			id: "p1",
			kind: "script.post",
			config: { script: "pm.test('ok', () => {});", ...config },
			...overrides,
		});

	it("is true for an enabled, non-blank script.post that is not marked inline", () => {
		expect(hasReplayedPostScript([post()])).toBe(true);
		expect(hasReplayedPostScript([post({}, { inline: false })])).toBe(true);
	});

	it("is false when the script is marked inline", () => {
		expect(hasReplayedPostScript([post({}, { inline: true })])).toBe(false);
	});

	it("is false for a disabled, blank or absent script, and for a pre-request one", () => {
		expect(hasReplayedPostScript([post({ enabled: false })])).toBe(false);
		expect(hasReplayedPostScript([post({}, { script: "  \n" })])).toBe(false);
		expect(hasReplayedPostScript([post({}, { script: undefined })])).toBe(false);
		expect(hasReplayedPostScript([element({ id: "x", kind: "script.pre" })])).toBe(false);
		expect(hasReplayedPostScript([element({ id: "a", kind: "assert.status" })])).toBe(false);
		expect(hasReplayedPostScript([])).toBe(false);
		expect(hasReplayedPostScript(undefined)).toBe(false);
	});

	it("counts a collection's script.post that elementsParts resolves into the list", () => {
		const chain = [collection("c", "C", [post({ id: "inherited" })])];
		expect(hasReplayedPostScript(elementsParts(chain, "req", []))).toBe(true);
	});

	it("does not count an inherited script.post the request disables", () => {
		const chain = [collection("c", "C", [post({ id: "inherited" })])];
		const disable = element({
			id: "d",
			kind: "inherit.disable",
			config: { elementId: "inherited" },
		});
		expect(hasReplayedPostScript(elementsParts(chain, "req", [disable]))).toBe(false);
	});
});

describe("withoutDisabled (#3050)", () => {
	it("drops a switched-off element, wherever it came from, and keeps the rest in order", () => {
		const chain = [
			collection("root", "Root", [
				element({ id: "r1", kind: "timer.pacing", enabled: false }),
				element({ id: "r2", kind: "extract.json" }),
			]),
		];
		const parts = elementsParts(chain, "req_1", [
			element({ id: "q1", kind: "control.loop", enabled: false }),
			element({ id: "q2", kind: "assert.status" }),
		]);

		expect(withoutDisabled(parts)?.map((el) => el.id)).toEqual(["r2", "q2"]);
	});

	it("answers undefined when nothing is left, as elementsParts does for an empty chain", () => {
		const parts = elementsParts([], "req_1", [
			element({ id: "q1", kind: "timer.pacing", enabled: false }),
		]);

		expect(parts).toHaveLength(1);
		expect(withoutDisabled(parts)).toBeUndefined();
		expect(withoutDisabled(undefined)).toBeUndefined();
	});
});

describe("withoutInheritedCollectionOnly (#3070)", () => {
	const chain = [
		collection("root", "Root", [
			element({ id: "setup", kind: "script.setup" }),
			element({ id: "teardown", kind: "script.teardown" }),
			element({ id: "assert", kind: "assert.status" }),
		]),
	];

	it("drops a collection's setup and teardown scripts and keeps its other elements", () => {
		const parts = elementsParts(chain, "req_1", [element({ id: "q1", kind: "script.pre" })]);

		expect(withoutInheritedCollectionOnly(parts)?.map((el) => el.id)).toEqual(["assert", "q1"]);
	});

	it("drops them from a folder too, which is a collection level", () => {
		const parts = elementsParts(
			[collection("root", "Root", []), collection("folder", "Folder", chain[0].elements)],
			"req_1",
			[]
		);

		expect(withoutInheritedCollectionOnly(parts)?.map((el) => el.id)).toEqual(["assert"]);
	});

	it("leaves one the request itself carries, for the engine to refuse by name", () => {
		const parts = elementsParts([], "req_1", [element({ id: "own", kind: "script.setup" })]);

		expect(withoutInheritedCollectionOnly(parts)?.map((el) => el.id)).toEqual(["own"]);
	});

	it("answers undefined when nothing is left, and for undefined", () => {
		const parts = elementsParts(
			[collection("root", "Root", [chain[0].elements[0]])],
			"req_1",
			[]
		);

		expect(parts).toHaveLength(1);
		expect(withoutInheritedCollectionOnly(parts)).toBeUndefined();
		expect(withoutInheritedCollectionOnly(undefined)).toBeUndefined();
	});
});
