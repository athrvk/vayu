/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A collection's declared data-file contract, as MCP hands it back (issue
 * #1742): stated when the Data tab declared one, absent when it did not - never
 * the engine's `{}` placeholder. The reader restates the renderer's
 * `hasDataContract` across the `electron/` boundary, so the two are held to the
 * same answers here.
 */

import { describe, expect, test, vi } from "vitest";
import { hasDataContract, type CollectionDataSchema } from "@/types/domain";
import { DATA_CONTRACT_SENTENCE, readDataContract } from "./collection-shape.js";
import { STATIC_RESOURCES } from "./resources.js";
import { TOOLS, dispatchTool, type ToolContext } from "./tools.js";
import { resolveSafetyConfig } from "./config.js";
import type { EngineClient } from "./engine-client.js";

const DECLARED = {
	id: "col_data",
	name: "Checkout",
	dataSchema: {
		columns: ["userId", "sku"],
		fileName: "users.csv",
		declaredAt: 1_758_800_000_000,
	},
};
// What the engine answers for a collection that never declared one, and for one
// whose contract was cleared.
const NONE = { id: "col_none", name: "Health", dataSchema: {} };

function ctxWith(client: Partial<Record<keyof EngineClient, unknown>>): ToolContext {
	return {
		client: client as unknown as EngineClient,
		config: resolveSafetyConfig({ allowWrites: true }),
	};
}

const parsed = (r: { content: Array<{ text: string }> }) =>
	JSON.parse(r.content[0].text) as unknown;

describe("a collection's data contract on the MCP surface", () => {
	test("list_collections states a declared contract and omits an absent one", async () => {
		const ctx = ctxWith({ listCollections: vi.fn().mockResolvedValue([DECLARED, NONE]) });
		const rows = parsed(await dispatchTool("list_collections", {}, ctx)) as Array<
			Record<string, unknown>
		>;
		expect(rows[0].dataSchema).toEqual({
			columns: ["userId", "sku"],
			fileName: "users.csv",
			declaredAt: 1_758_800_000_000,
		});
		// Mutation check: return the engine's answer unshaped and this fails on `{}`.
		expect(rows[1]).not.toHaveProperty("dataSchema");
		expect(rows[1]).toEqual({ id: "col_none", name: "Health" });
	});

	test("the collections resource answers in the same shape", async () => {
		const resource = STATIC_RESOURCES.find((r) => r.uri === "vayu://collections")!;
		const ctx = ctxWith({ listCollections: vi.fn().mockResolvedValue([DECLARED, NONE]) });
		const rows = (await resource.read(ctx)) as Array<Record<string, unknown>>;
		expect(rows[0].dataSchema).toEqual(DECLARED.dataSchema);
		expect(rows[1]).not.toHaveProperty("dataSchema");
	});

	test.each([
		["create_collection", { name: "Health" }, "createCollection"],
		["update_collection", { collectionId: "col_none", name: "Health" }, "updateCollection"],
	] as const)("%s returns the row in the same shape", async (tool, args, method) => {
		const ctx = ctxWith({ [method]: vi.fn().mockResolvedValue(NONE) });
		const row = parsed(await dispatchTool(tool, args, ctx));
		expect(row).toEqual({ id: "col_none", name: "Health" });
	});

	test("the tool and the resource say what the field is", () => {
		const resource = STATIC_RESOURCES.find((r) => r.uri === "vayu://collections")!;
		const tool = TOOLS.find((t) => t.name === "list_collections")!;
		expect(resource.description).toContain(DATA_CONTRACT_SENTENCE);
		expect(tool.description).toContain(DATA_CONTRACT_SENTENCE);
	});
});

describe("readDataContract agrees with the renderer's hasDataContract", () => {
	const CASES: Array<[string, unknown]> = [
		["absent", undefined],
		["the engine's empty object", {}],
		["cleared columns", { columns: [] }],
		["a file name with no columns", { fileName: "users.csv" }],
		["one column", { columns: ["id"] }],
		["columns with metadata", DECLARED.dataSchema],
	];

	test.each(CASES)("%s", (_label, schema) => {
		expect(readDataContract(schema) !== null).toBe(
			hasDataContract(schema as CollectionDataSchema | undefined)
		);
	});

	test("the cases cover both answers", () => {
		// A table where every row agrees on `false` proves nothing about `true`.
		const answers = new Set(CASES.map(([, s]) => readDataContract(s) !== null));
		expect(answers).toEqual(new Set([true, false]));
	});
});
