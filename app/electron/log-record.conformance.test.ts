/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `docs/engine/log-record.schema.json` is the one contract both the app's
 * logger (`log.ts`) and the renderer's (`error-logger.ts`) claim to match.
 * This pins their category lists to the schema's `app` and `renderer`
 * branches exactly - a category added to one side alone is exactly the drift
 * that would let a record write successfully and fail every reader that
 * validates against the schema.
 *
 * Mutation check: add a category to `AppCategory` in `log.ts` without adding
 * it to the schema (or the reverse) and the matching case below reds.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fromRepoRoot } from "@/lib/routed-inputs.testkit";
import type { AppCategory, RendererCategory } from "./log";

const schemaText = readFileSync(fromRepoRoot("docs/engine/log-record.schema.json"), "utf8");
const schema = JSON.parse(schemaText) as {
	oneOf: { properties: { src: { const: string }; cat: { enum: string[] } } }[];
};

function catEnumFor(src: string): string[] {
	const branch = schema.oneOf.find((b) => b.properties.src.const === src);
	if (!branch) throw new Error(`no oneOf branch for src ${src}`);
	return branch.properties.cat.enum;
}

describe("log-record schema conformance", () => {
	it("read a non-empty schema file", () => {
		expect(schemaText.length).toBeGreaterThan(0);
	});

	it("log.ts's AppCategory union matches the schema's app (and mcp) enum exactly", () => {
		// A `Record<AppCategory, true>` is a two-way exhaustiveness check at
		// compile time: a member added to the type and missing here, or a key
		// here the type does not declare, is a `tsc` error - not just a runtime
		// one this test would have to notice on its own.
		const coverage: Record<AppCategory, true> = {
			main: true,
			sidecar: true,
			window: true,
			updater: true,
			ipc: true,
			mcp: true,
			power: true,
			notify: true,
		};
		expect(catEnumFor("app")).toEqual(Object.keys(coverage));
		// The app and mcp branches are declared as the same list in the schema
		// (both loggers share one file) - pinned here so a schema edit that
		// splits them is caught immediately rather than by a confusing runtime
		// validation failure later.
		expect(catEnumFor("mcp")).toEqual(catEnumFor("app"));
	});

	it("error-logger.ts's renderer categories match the schema's renderer enum exactly", () => {
		const coverage: Record<RendererCategory, true> = { renderer: true, boundary: true };
		expect(catEnumFor("renderer")).toEqual(Object.keys(coverage));
	});
});
