/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { scriptParts } from "./script-parts";
import type { Collection } from "@/types";

/** Minimal `Collection` fixture - only the fields `scriptParts` reads matter. */
function collection(overrides: Partial<Collection> & { id: string; name: string }): Collection {
	return {
		description: "",
		parentId: undefined,
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		createdAt: "",
		updatedAt: "",
		...overrides,
	};
}

describe("scriptParts", () => {
	it("orders the chain root to leaf, then the request's own, each naming its origin", () => {
		const chain: Collection[] = [
			collection({ id: "root", name: "Root", preRequestScript: "A" }),
			collection({ id: "leaf", name: "Leaf", preRequestScript: "B" }),
		];

		const parts = scriptParts(chain, (c) => c.preRequestScript, "req_1", "C");

		expect(parts).toEqual([
			{ origin: "collection", id: "root", name: "Root", script: "A" },
			{ origin: "collection", id: "leaf", name: "Leaf", script: "B" },
			{ origin: "request", id: "req_1", script: "C" },
		]);
	});

	it("drops parts whose script is empty or only whitespace", () => {
		const chain: Collection[] = [
			collection({ id: "c1", name: "Blank", preRequestScript: "   " }),
			collection({ id: "c2", name: "Empty", preRequestScript: "" }),
			collection({ id: "c3", name: "Real", preRequestScript: "real-chain-script" }),
		];

		const parts = scriptParts(chain, (c) => c.preRequestScript, "req_1", "\t\n ");

		expect(parts).toEqual([
			{ origin: "collection", id: "c3", name: "Real", script: "real-chain-script" },
		]);
	});

	it("returns undefined, not an empty list, when nothing survives", () => {
		const chain: Collection[] = [collection({ id: "c1", name: "Empty", preRequestScript: "" })];

		expect(scriptParts(chain, (c) => c.preRequestScript, "req_1", undefined)).toBeUndefined();
		expect(scriptParts([], () => undefined, undefined, undefined)).toBeUndefined();
	});

	it("reads whichever field the picker selects (pre vs post)", () => {
		const chain: Collection[] = [
			collection({
				id: "c1",
				name: "C1",
				preRequestScript: "pre",
				postRequestScript: "post",
			}),
		];

		expect(scriptParts(chain, (c) => c.postRequestScript, undefined, undefined)).toEqual([
			{ origin: "collection", id: "c1", name: "C1", script: "post" },
		]);
	});
});
