/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { scriptParts } from "./script-parts";
import { scriptTextFor } from "@/lib/elements";
import type { Collection, ElementDef } from "@/types";

/** One `script.pre` or `script.post` element, for a collection fixture below. */
function scriptElement(kind: "script.pre" | "script.post", script: string): ElementDef {
	return { id: `el_${kind}`, kind, enabled: true, config: { script } };
}

/** Minimal `Collection` fixture - only the fields `scriptParts` reads matter. */
function collection(
	overrides: Partial<Collection> & { id: string; name: string; elements?: ElementDef[] }
): Collection {
	return {
		description: "",
		parentId: undefined,
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

// `scriptParts` still takes a bare `pick: (c) => string | undefined` - the load
// path's `tests` field, which it feeds. `scriptTextFor(c.elements, kind)` is
// what every caller now passes as that picker (issue #1512), so the fixtures
// here store scripts as elements and pick through the same helper production
// code uses, rather than a field `Collection` no longer has.
describe("scriptParts", () => {
	it("orders the chain root to leaf, then the request's own, each naming its origin", () => {
		const chain: Collection[] = [
			collection({ id: "root", name: "Root", elements: [scriptElement("script.pre", "A")] }),
			collection({ id: "leaf", name: "Leaf", elements: [scriptElement("script.pre", "B")] }),
		];

		const parts = scriptParts(
			chain,
			(c) => scriptTextFor(c.elements, "script.pre"),
			"req_1",
			"C"
		);

		expect(parts).toEqual([
			{ origin: "collection", id: "root", name: "Root", script: "A" },
			{ origin: "collection", id: "leaf", name: "Leaf", script: "B" },
			{ origin: "request", id: "req_1", script: "C" },
		]);
	});

	it("drops parts whose script is empty or only whitespace", () => {
		const chain: Collection[] = [
			collection({ id: "c1", name: "Blank", elements: [scriptElement("script.pre", "   ")] }),
			collection({ id: "c2", name: "Empty", elements: [] }),
			collection({
				id: "c3",
				name: "Real",
				elements: [scriptElement("script.pre", "real-chain-script")],
			}),
		];

		const parts = scriptParts(
			chain,
			(c) => scriptTextFor(c.elements, "script.pre"),
			"req_1",
			"\t\n "
		);

		expect(parts).toEqual([
			{ origin: "collection", id: "c3", name: "Real", script: "real-chain-script" },
		]);
	});

	it("returns undefined, not an empty list, when nothing survives", () => {
		const chain: Collection[] = [collection({ id: "c1", name: "Empty", elements: [] })];

		expect(
			scriptParts(chain, (c) => scriptTextFor(c.elements, "script.pre"), "req_1", undefined)
		).toBeUndefined();
		expect(scriptParts([], () => undefined, undefined, undefined)).toBeUndefined();
	});

	it("reads whichever field the picker selects (pre vs post)", () => {
		const chain: Collection[] = [
			collection({
				id: "c1",
				name: "C1",
				elements: [
					scriptElement("script.pre", "pre"),
					scriptElement("script.post", "post"),
				],
			}),
		];

		expect(
			scriptParts(
				chain,
				(c) => scriptTextFor(c.elements, "script.post"),
				undefined,
				undefined
			)
		).toEqual([{ origin: "collection", id: "c1", name: "C1", script: "post" }]);
	});
});
