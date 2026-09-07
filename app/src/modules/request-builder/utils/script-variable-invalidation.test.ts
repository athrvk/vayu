/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An element that writes a variable has to leave the UI showing the new
 * value.
 *
 * Both send paths used to gate variable invalidation on `if (preScriptParts)`,
 * so a request whose only script sat in the Tests tab stored `auth_token`
 * engine-side while the variables editor and the resolver kept showing the
 * old one - indefinitely, since `refetchOnWindowFocus` is off. Generalized to
 * every element kind (issue #1512): an `extract.*` element writes to `env` /
 * `collection` / `globals` scope exactly as `pm.environment.set` does, so the
 * gate now reads the resolved elements list rather than two script-part
 * lists. The predicate is shared rather than written twice for the reason
 * `execute-mapping.ts` exists: the two copies of this gate had already
 * drifted from one another once.
 *
 * The scan half is not decoration. A correct predicate that no send path calls
 * is precisely the repo's "written but never read" defect, and a unit test of
 * the helper alone cannot see it.
 */

import { describe, it, expect } from "vitest";
import { elementsMayWriteVariables } from "./execute-mapping";
import type { ResolvedElement } from "@/types";

const element = (kind: string): ResolvedElement => ({
	id: "el_1",
	kind,
	enabled: true,
	config: {},
	origin: { kind: "request" },
});

describe("elementsMayWriteVariables", () => {
	it("is true for a post-request script alone - the case that was broken", () => {
		expect(elementsMayWriteVariables([element("script.post")])).toBe(true);
	});

	it("is true for a pre-request script alone", () => {
		expect(elementsMayWriteVariables([element("script.pre")])).toBe(true);
	});

	it("is true for a plain extractor - it can write scope too", () => {
		expect(elementsMayWriteVariables([element("extract.json")])).toBe(true);
	});

	it("is false when nothing ran - nothing could have been written", () => {
		expect(elementsMayWriteVariables(undefined)).toBe(false);
	});

	it("treats an empty list as no element", () => {
		expect(elementsMayWriteVariables([])).toBe(false);
	});
});

const sources = import.meta.glob(
	["/src/modules/request-builder/index.tsx", "/src/modules/history/main/DesignRunView.tsx"],
	{ query: "?raw", import: "default", eager: true }
);

describe("both send paths gate on the shared predicate", () => {
	it.each([
		["/src/modules/request-builder/index.tsx"],
		["/src/modules/history/main/DesignRunView.tsx"],
	])("%s calls elementsMayWriteVariables and no longer gates on a script list alone", (path) => {
		const src = sources[path] as string | undefined;
		// Guards the scan itself: vitest stubs some imports to "", and a moved
		// file would make every assertion below pass vacuously.
		expect(typeof src).toBe("string");
		expect((src ?? "").length).toBeGreaterThan(1000);

		const source = src ?? "";
		expect(source).toContain("elementsMayWriteVariables(elements)");
		// The reverted form. Matches `if (preScriptParts)` with any spacing, and
		// nothing in either file is written that way any more.
		expect(source).not.toMatch(/if\s*\(\s*preScriptParts\s*\)/);
	});

	it("invalidates all three variable families behind that gate", () => {
		for (const src of Object.values(sources)) {
			const source = src as string;
			const gate = source.indexOf("elementsMayWriteVariables(");
			expect(gate).toBeGreaterThan(-1);
			// The three families the engine can write from an element. Sliced to
			// the gate's own block so an unrelated invalidation elsewhere in the
			// file cannot stand in for one of them.
			const block = source.slice(gate, gate + 500);
			expect(block).toContain("queryKeys.environments.all");
			expect(block).toContain("queryKeys.globals.all");
			expect(block).toContain("queryKeys.collections.all");
		}
	});
});
