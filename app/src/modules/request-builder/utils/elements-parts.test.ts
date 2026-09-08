/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `elementsParts` walks the collection chain's elements, root to leaf, then
 * the request's own (issue #1512), honouring an `inherit.disable` entry on
 * the request's own list that suppresses one ancestor element by id.
 * `scriptTextFor` (re-exported from `@/lib/elements`) is covered here too,
 * since this is the one place both are consumed together.
 */

import { describe, it, expect } from "vitest";
import { elementsParts, scriptTextFor } from "./elements-parts";
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
				origin: { kind: "collection", id: "root", name: "Root" },
			},
			{
				id: "l1",
				kind: "extract.json",
				enabled: true,
				config: {},
				origin: { kind: "collection", id: "leaf", name: "Leaf" },
			},
			{
				id: "req1",
				kind: "assert.status",
				enabled: true,
				config: {},
				origin: { kind: "request", id: "req_1" },
			},
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
