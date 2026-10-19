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
import { TOOLS, dispatchTool, resolveDescription, type ToolContext } from "./tools.js";
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

function ctxWith(
	client: Partial<Record<keyof EngineClient, unknown>>,
	extra: Partial<ToolContext> = {}
): ToolContext {
	return {
		client: client as unknown as EngineClient,
		config: resolveSafetyConfig({ allowWrites: true }),
		host: "app",
		...extra,
	};
}

const USERS_FILE = { path: "/data/users.csv", fileName: "users.csv", hash: "c".repeat(64) };
/** What the Electron host hands a tool: the app remembers a file for `col_data` only. */
const remembered = (id: string) => (id === "col_data" ? USERS_FILE : undefined);

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
		expect(resolveDescription(tool, resolveSafetyConfig())).toContain(DATA_CONTRACT_SENTENCE);
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

describe("the remembered data file on the MCP surface (Part B)", () => {
	test("list_collections names the file the app remembers, and only for that collection", async () => {
		const ctx = ctxWith(
			{ listCollections: vi.fn().mockResolvedValue([DECLARED, NONE]) },
			{ dataFileLocation: remembered }
		);
		const rows = parsed(await dispatchTool("list_collections", {}, ctx)) as Array<
			Record<string, unknown>
		>;
		// Mutation check: drop the `dataFile` spread in presentCollection and this fails.
		expect(rows[0].dataFile).toEqual(USERS_FILE);
		expect(rows[1]).not.toHaveProperty("dataFile");
	});

	test("names the hash the app last read the file with, and none before it has (#2051)", async () => {
		const listed = async (location: Record<string, string>) =>
			(
				parsed(
					await dispatchTool(
						"list_collections",
						{},
						ctxWith(
							{ listCollections: vi.fn().mockResolvedValue([DECLARED]) },
							{ dataFileLocation: () => location as typeof USERS_FILE }
						)
					)
				) as Array<Record<string, unknown>>
			)[0].dataFile;

		// Mutation check: drop the hash from presentLocation and this fails.
		expect(await listed(USERS_FILE)).toEqual(USERS_FILE);
		// A location remembered before hashes were recorded: absent, not `undefined`.
		const unhashed = { path: USERS_FILE.path, fileName: USERS_FILE.fileName };
		expect(await listed(unhashed)).toEqual(unhashed);
		expect(Object.keys((await listed(unhashed)) as object)).toEqual(["path", "fileName"]);
	});

	/*
	 * The hash a list answers is the file's as it is at call time (#2051), so
	 * an edit made after a run shows up without the app re-reading the file.
	 * Mutation check: list without `withCurrentDataFileHashes` and the fresh
	 * cases fail; let a rejection escape it and the fallback cases fail.
	 */
	describe("a list hashes the file as it is now", () => {
		const FRESH = "d".repeat(64);
		const unhashed = { path: USERS_FILE.path, fileName: USERS_FILE.fileName };
		const ctxHashing = (
			location: Record<string, string>,
			currentDataFileHash: (filePath: string) => Promise<string>
		) =>
			ctxWith(
				{ listCollections: vi.fn().mockResolvedValue([DECLARED, NONE]) },
				{ dataFileLocation: () => location as typeof USERS_FILE, currentDataFileHash }
			);
		const viaTool = async (ctx: ToolContext) =>
			(
				parsed(await dispatchTool("list_collections", {}, ctx)) as Array<
					Record<string, unknown>
				>
			)[0].dataFile;
		const viaResource = async (ctx: ToolContext) =>
			(
				(await STATIC_RESOURCES.find((r) => r.uri === "vayu://collections")!.read(
					ctx
				)) as Array<Record<string, unknown>>
			)[0].dataFile;

		test.each([
			["list_collections", viaTool],
			["vayu://collections", viaResource],
		])("%s answers the current digest over the stored one", async (_, list) => {
			const hashOf = vi.fn(async () => FRESH);
			expect(await list(ctxHashing(USERS_FILE, hashOf))).toEqual({
				...USERS_FILE,
				hash: FRESH,
			});
			expect(hashOf).toHaveBeenCalledWith(USERS_FILE.path);
			// A location remembered before any read gains one, in the same place.
			const gained = await list(ctxHashing(unhashed, hashOf));
			expect(Object.keys(gained as object)).toEqual(["path", "fileName", "hash"]);
		});

		test.each([
			["list_collections", viaTool],
			["vayu://collections", viaResource],
		])("%s falls back to the stored hash for a file it cannot read", async (_, list) => {
			const missing = async (): Promise<string> => {
				throw new Error("The file is no longer at /data/users.csv - pick it again.");
			};
			expect(await list(ctxHashing(USERS_FILE, missing))).toEqual(USERS_FILE);
			expect(await list(ctxHashing(unhashed, missing))).toEqual(unhashed);
		});

		test("a missing file is never an error", async () => {
			const result = await dispatchTool(
				"list_collections",
				{},
				ctxHashing(USERS_FILE, () => Promise.reject(new Error("gone")))
			);
			expect(result.isError).toBeFalsy();
		});
	});

	test("the resource and the write tools' results carry it the same way", async () => {
		const resource = STATIC_RESOURCES.find((r) => r.uri === "vayu://collections")!;
		const listed = (await resource.read(
			ctxWith(
				{ listCollections: vi.fn().mockResolvedValue([DECLARED]) },
				{ dataFileLocation: remembered }
			)
		)) as Array<Record<string, unknown>>;
		expect(listed[0].dataFile).toEqual(USERS_FILE);

		const updated = parsed(
			await dispatchTool(
				"update_collection",
				{ collectionId: "col_data", name: "Checkout" },
				ctxWith(
					{ updateCollection: vi.fn().mockResolvedValue(DECLARED) },
					{ dataFileLocation: remembered }
				)
			)
		) as Record<string, unknown>;
		expect(updated.dataFile).toEqual(USERS_FILE);
	});

	test("a host with no record of paths (the stdio CLI) names none", async () => {
		const ctx = ctxWith({ listCollections: vi.fn().mockResolvedValue([DECLARED]) });
		const rows = parsed(await dispatchTool("list_collections", {}, ctx)) as Array<
			Record<string, unknown>
		>;
		expect(rows[0]).not.toHaveProperty("dataFile");
	});

	test("it rides a read tool, answered with writes off, and names a path, never contents", async () => {
		const tool = TOOLS.find((t) => t.name === "list_collections")!;
		expect(tool.category).toBe("read");
		expect(tool.annotations.readOnlyHint).toBe(true);
		const ctx: ToolContext = {
			client: {
				listCollections: vi.fn().mockResolvedValue([DECLARED]),
			} as unknown as EngineClient,
			config: resolveSafetyConfig({ allowWrites: false }),
			host: "app",
			dataFileLocation: remembered,
		};
		const result = await dispatchTool("list_collections", {}, ctx);
		expect(result.isError).toBeFalsy();
		// A path, never contents: nothing in the answer holds a row.
		expect(
			Object.keys((parsed(result) as Array<Record<string, unknown>>)[0].dataFile as object)
		).toEqual(["path", "fileName", "hash"]);
	});
});
