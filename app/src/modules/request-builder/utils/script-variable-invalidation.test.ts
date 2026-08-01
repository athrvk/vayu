/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A script that writes a variable has to leave the UI showing the new value.
 *
 * Both send paths gated variable invalidation on `if (preScriptParts)`, so a
 * request whose only script sat in the Tests tab stored `auth_token`
 * engine-side while the variables editor and the resolver kept showing the old
 * one - indefinitely, since `refetchOnWindowFocus` is off. The predicate is
 * shared rather than written twice for the reason `execute-mapping.ts` exists:
 * the two copies of this gate had already drifted from one another once.
 *
 * The scan half is not decoration. A correct predicate that no send path calls
 * is precisely the repo's "written but never read" defect, and a unit test of
 * the helper alone cannot see it.
 */

import { describe, it, expect } from "vitest";
import { scriptsMayWriteVariables } from "./execute-mapping";
import type { ScriptPart } from "@/types";

const part = (script: string): ScriptPart => ({ origin: "request", script });

describe("scriptsMayWriteVariables", () => {
	it("is true for a post-request script alone - the case that was broken", () => {
		expect(scriptsMayWriteVariables(undefined, [part("pm.environment.set('t', 1)")])).toBe(
			true
		);
	});

	it("is true for a pre-request script alone", () => {
		expect(scriptsMayWriteVariables([part("pm.globals.set('t', 1)")], undefined)).toBe(true);
	});

	it("is true when both kinds ran", () => {
		expect(scriptsMayWriteVariables([part("a")], [part("b")])).toBe(true);
	});

	it("is false when neither ran - nothing could have been written", () => {
		expect(scriptsMayWriteVariables(undefined, undefined)).toBe(false);
	});

	it("treats an empty part list as no script", () => {
		// `scriptParts()` returns undefined rather than [], but a replay builds
		// its list by hand; an empty one means nothing executed either way.
		expect(scriptsMayWriteVariables([], [])).toBe(false);
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
	])("%s calls scriptsMayWriteVariables and no longer gates on preScriptParts alone", (path) => {
		const src = sources[path] as string | undefined;
		// Guards the scan itself: vitest stubs some imports to "", and a moved
		// file would make every assertion below pass vacuously.
		expect(typeof src).toBe("string");
		expect((src ?? "").length).toBeGreaterThan(1000);

		const source = src ?? "";
		expect(source).toContain("scriptsMayWriteVariables(preScriptParts, postScriptParts)");
		// The reverted form. Matches `if (preScriptParts)` with any spacing, and
		// nothing else in either file is written that way.
		expect(source).not.toMatch(/if\s*\(\s*preScriptParts\s*\)/);
	});

	it("invalidates all three variable families behind that gate", () => {
		for (const src of Object.values(sources)) {
			const source = src as string;
			const gate = source.indexOf("scriptsMayWriteVariables(");
			expect(gate).toBeGreaterThan(-1);
			// The three families the engine can write from a script. Sliced to the
			// gate's own block so an unrelated invalidation elsewhere in the file
			// cannot stand in for one of them.
			const block = source.slice(gate, gate + 500);
			expect(block).toContain("queryKeys.environments.all");
			expect(block).toContain("queryKeys.globals.all");
			expect(block).toContain("queryKeys.collections.all");
		}
	});
});
