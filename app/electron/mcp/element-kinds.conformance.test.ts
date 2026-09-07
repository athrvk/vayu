/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file element-kinds.conformance.test.ts
 * @brief Keeps the MCP element surface honest against the engine's registry
 *        (issue #1517). The `vayu://elements/kinds` resource must serve
 *        exactly what the engine's `GET /elements/kinds` returns - the same
 *        anti-drift shape `variable-origins.conformance.test.ts` follows for
 *        variable resolution - and any kind literal a tool schema names as an
 *        example (the `elements` field's `kind` description, or the
 *        `script.pre` / `script.post` mentions the script sugar fields
 *        generate) must be a kind the registry actually has. A kind renamed
 *        engine-side with no matching update here would otherwise tell an
 *        agent to write a kind that no longer exists.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { STATIC_RESOURCES, type ElementKindEntry } from "./resources.js";
import { elementSchema, TOOLS, type ToolContext } from "./tools.js";
import type { EngineClient } from "./engine-client.js";

const [fixturePath] = ENGINE_READING_GUARDS.mcpElementKinds.paths.map(fromRepoRoot);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ElementKindEntry[];
const fixtureKinds = new Set(fixture.map((k) => k.kind));
// Derived from the fixture rather than hardcoded, so a category the engine
// adds later (e.g. `control.*`, #1515) is picked up with no edit here.
const CATEGORY_PREFIXES = [...new Set(fixture.map((k) => k.kind.split(".")[0]))];

function elementsResource() {
	const r = STATIC_RESOURCES.find((s) => s.uri === "vayu://elements/kinds");
	if (!r) throw new Error("elements resource is not registered");
	return r;
}

describe("the vayu://elements/kinds resource agrees with the engine's fixture", () => {
	test("returns exactly the fixture's kinds", async () => {
		const getElementKinds = vi.fn().mockResolvedValue(fixture);
		const ctx = { client: { getElementKinds } as unknown as EngineClient } as ToolContext;
		await expect(elementsResource().read(ctx)).resolves.toEqual(fixture);
	});

	test("the fixture is non-empty and covers more than one category", () => {
		expect(fixture.length).toBeGreaterThan(0);
		expect(CATEGORY_PREFIXES.length).toBeGreaterThan(1);
	});
});

/**
 * Every `<category>.<name>` token in `text` whose category is one the
 * fixture actually has. Narrower than a bare `\w+\.\w+` scan, which would
 * also catch `pm.test`, `pm.request` and this project's own `vayu://` URIs -
 * none of them an element kind.
 */
function kindLiteralsIn(text: string): string[] {
	const pattern = new RegExp(`\\b(?:${CATEGORY_PREFIXES.join("|")})\\.[a-zA-Z]+\\b`, "g");
	return text.match(pattern) ?? [];
}

describe("every element kind a tool schema names is a real registry kind", () => {
	test.each(
		TOOLS.map((tool) => {
			const fieldText = Object.values(tool.inputSchema)
				.map((field) => field.description ?? "")
				.join("\n");
			const mentioned = [...new Set(kindLiteralsIn(`${tool.description}\n${fieldText}`))];
			return [tool.name, mentioned] as const;
		}).filter(([, mentioned]) => mentioned.length > 0)
	)("%s names only kinds the registry has (%j)", (_name, mentioned) => {
		for (const kind of mentioned) {
			expect(fixtureKinds.has(kind), `"${kind}" is not in the element-kinds fixture`).toBe(
				true
			);
		}
	});

	test("the shared `elements` field's kind examples are real kinds too", () => {
		const mentioned = kindLiteralsIn(elementSchema.shape.kind.description ?? "");
		expect(mentioned.length).toBeGreaterThan(0);
		for (const kind of mentioned) {
			expect(fixtureKinds.has(kind), `"${kind}" is not in the element-kinds fixture`).toBe(
				true
			);
		}
	});

	// Confirms the two tests above would actually catch a drift, rather than
	// vacuously passing because nothing matched: at least one real tool
	// mentions a real kind today.
	test("at least one tool schema mentions at least one kind", () => {
		const anyMentioned = TOOLS.some((tool) => {
			const fieldText = Object.values(tool.inputSchema)
				.map((field) => field.description ?? "")
				.join("\n");
			return kindLiteralsIn(`${tool.description}\n${fieldText}`).length > 0;
		});
		expect(anyMentioned).toBe(true);
	});
});
