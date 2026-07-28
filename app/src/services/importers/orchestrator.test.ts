import { describe, it, expect, vi } from "vitest";
import { ImportOrchestrator, type ImportApi } from "./orchestrator";
import { assignIds } from "./assign-ids";
import type { Collection, Environment, VariableValue } from "@/types";
import type { ImportResult } from "./types";

function fakeApi(overrides: Partial<ImportApi> = {}): { api: ImportApi; calls: any } {
	const calls = {
		collections: [] as any[],
		requests: [] as any[],
		environments: [] as any[],
		deletedCols: [] as string[],
		deletedEnvs: [] as string[],
		globalsRead: 0,
		globalsWritten: [] as Record<string, unknown>[],
	};
	const api: ImportApi = {
		createCollection: vi.fn(async (d) => {
			calls.collections.push(d);
			return { id: d.id } as any;
		}),
		createRequest: vi.fn(async (d) => {
			calls.requests.push(d);
			return { id: d.id } as any;
		}),
		createEnvironment: vi.fn(async (d) => {
			calls.environments.push(d);
			return { id: d.id } as any;
		}),
		deleteCollection: vi.fn(async (id) => {
			calls.deletedCols.push(id);
		}),
		deleteEnvironment: vi.fn(async (id) => {
			calls.deletedEnvs.push(id);
		}),
		getGlobals: vi.fn(async () => {
			calls.globalsRead++;
			return { id: "globals", variables: {}, updatedAt: "0" };
		}),
		updateGlobals: vi.fn(async (variables) => {
			calls.globalsWritten.push(variables);
			return { id: "globals", variables, updatedAt: "1" };
		}),
		...overrides,
	};
	return { api, calls };
}

function fixture(): ImportResult {
	return assignIds({
		collections: [
			{
				name: "root",
				description: "",
				variables: {},
				auth: { mode: "none" },
				preRequestScript: "",
				postRequestScript: "",
				requests: [
					{
						name: "r1",
						description: "",
						method: "POST",
						url: "u",
						params: [],
						headers: [],
						body: { mode: "json", content: "{}" },
						auth: { mode: "inherit" },
						preRequestScript: "",
						postRequestScript: "",
					},
				],
				children: [
					{
						name: "child",
						description: "",
						variables: {},
						auth: { mode: "none" },
						preRequestScript: "",
						postRequestScript: "",
						requests: [
							{
								name: "r2",
								description: "",
								method: "GET",
								url: "u2",
								params: [],
								headers: [],
								body: { mode: "none" },
								auth: { mode: "inherit" },
								preRequestScript: "",
								postRequestScript: "",
							},
						],
						children: [],
					},
				],
			},
		],
		environments: [
			{ name: "Prod", description: "d", variables: { a: { value: "1", enabled: true } } },
		],
		globals: {},
		meta: {
			format: "x",
			requestCount: 2,
			folderCount: 1,
			environmentCount: 1,
			globalCount: 0,
			skipped: [],
			nonExecutableAuth: 0,
		},
	});
}

const opts = { importEnvironments: true, importScripts: true };

describe("ImportOrchestrator", () => {
	it("creates parents before children before requests, with explicit order, bodyType, and parentId", async () => {
		const { api, calls } = fakeApi();
		await new ImportOrchestrator(api).run(fixture(), opts);

		expect(calls.collections[0].parentId).toBeUndefined();
		expect(calls.collections[0].order).toBe(0);
		expect(calls.collections[1].parentId).toBe(calls.collections[0].id);

		const r1 = calls.requests.find((r: any) => r.name === "r1");
		expect(r1.collectionId).toBe(calls.collections[0].id);
		expect(r1.bodyType).toBe("json");
		expect(typeof r1.order).toBe("number");
		expect(r1.auth).toEqual({ mode: "inherit" });

		expect(calls.environments[0].description).toBe("d");
		expect("isActive" in calls.environments[0]).toBe(false);
	});

	it("skips environments when importEnvironments=false", async () => {
		const { api, calls } = fakeApi();
		await new ImportOrchestrator(api).run(fixture(), { ...opts, importEnvironments: false });
		expect(calls.environments).toHaveLength(0);
	});

	it("rolls back created roots + envs when a create fails midway", async () => {
		const calls = { requests: [] as any[] };
		const { api, calls: c } = fakeApi({
			createRequest: vi.fn(async (d: any) => {
				if (d.name === "r2") throw new Error("boom");
				calls.requests.push(d);
				return { id: d.id } as any;
			}),
		});
		await expect(new ImportOrchestrator(api).run(fixture(), opts)).rejects.toThrow("boom");
		expect(c.deletedCols).toHaveLength(1);
		expect(api.deleteCollection).toHaveBeenCalledWith(c.collections[0].id);
	});

	it("throws (no creates) when given a result whose drafts have no ids", async () => {
		const { api, calls } = fakeApi();
		const result: ImportResult = {
			collections: [
				{
					name: "root",
					description: "",
					variables: {},
					auth: { mode: "none" },
					preRequestScript: "",
					postRequestScript: "",
					requests: [],
					children: [],
				},
			],
			environments: [{ name: "e", description: "", variables: {} }],
			globals: {},
			meta: {
				format: "x",
				requestCount: 0,
				folderCount: 1,
				environmentCount: 1,
				globalCount: 0,
				skipped: [],
				nonExecutableAuth: 0,
			},
		};
		await expect(new ImportOrchestrator(api).run(result, opts)).rejects.toThrow(/assignIds/);
		expect(calls.collections).toHaveLength(0);
		expect(calls.environments).toHaveLength(0);
	});

	it("rolls back ALL created roots when a request in a later root's subtree fails", async () => {
		const { api, calls } = fakeApi({
			createRequest: vi.fn(async (d: any) => {
				if (d.name === "fail") throw new Error("boom");
				return { id: d.id } as any;
			}),
		});
		const result = assignIds({
			collections: [
				{
					name: "root0",
					description: "",
					variables: {},
					auth: { mode: "none" },
					preRequestScript: "",
					postRequestScript: "",
					requests: [
						{
							name: "ok",
							description: "",
							method: "GET",
							url: "u",
							params: [],
							headers: [],
							body: { mode: "none" },
							auth: { mode: "inherit" },
							preRequestScript: "",
							postRequestScript: "",
						},
					],
					children: [],
				},
				{
					name: "root1",
					description: "",
					variables: {},
					auth: { mode: "none" },
					preRequestScript: "",
					postRequestScript: "",
					requests: [
						{
							name: "fail",
							description: "",
							method: "GET",
							url: "u",
							params: [],
							headers: [],
							body: { mode: "none" },
							auth: { mode: "inherit" },
							preRequestScript: "",
							postRequestScript: "",
						},
					],
					children: [],
				},
			],
			environments: [],
			globals: {},
			meta: {
				format: "x",
				requestCount: 2,
				folderCount: 2,
				environmentCount: 0,
				globalCount: 0,
				skipped: [],
				nonExecutableAuth: 0,
			},
		});
		await expect(new ImportOrchestrator(api).run(result, opts)).rejects.toThrow("boom");
		expect(calls.deletedCols).toContain(result.collections[0].id);
		expect(calls.deletedCols).toContain(result.collections[1].id);
		expect(calls.deletedCols).toHaveLength(2);
	});

	describe("globals", () => {
		/** A globals-only result, the shape a Postman globals export parses to. */
		function globalsFixture(globals: Record<string, VariableValue>): ImportResult {
			return assignIds({
				collections: [],
				environments: [],
				globals,
				meta: {
					format: "Postman Globals",
					requestCount: 0,
					folderCount: 0,
					environmentCount: 0,
					globalCount: Object.keys(globals).length,
					skipped: [],
					nonExecutableAuth: 0,
				},
			});
		}

		it("merges into the existing set rather than replacing it", async () => {
			// POST /globals replaces everything, so a write that is not a merge would
			// delete `keep` - the whole reason applyGlobals reads first.
			const { api, calls } = fakeApi({
				getGlobals: vi.fn(async () => ({
					id: "globals",
					variables: { keep: { value: "old", enabled: true } },
					updatedAt: "0",
				})),
			});
			await new ImportOrchestrator(api).run(
				globalsFixture({ fresh: { value: "new", enabled: true } }),
				opts
			);
			expect(calls.globalsWritten).toHaveLength(1);
			expect(calls.globalsWritten[0]).toEqual({
				keep: { value: "old", enabled: true },
				fresh: { value: "new", enabled: true },
			});
		});

		it("lets the imported value win a name collision", async () => {
			const { api, calls } = fakeApi({
				getGlobals: vi.fn(async () => ({
					id: "globals",
					variables: { token: { value: "old", enabled: true } },
					updatedAt: "0",
				})),
			});
			await new ImportOrchestrator(api).run(
				globalsFixture({ token: { value: "imported", enabled: true } }),
				opts
			);
			expect(calls.globalsWritten[0].token).toEqual({ value: "imported", enabled: true });
		});

		it("neither reads nor writes globals when the result has none", async () => {
			// Every other format lands here; an import must not touch the globals scope.
			const { api, calls } = fakeApi();
			await new ImportOrchestrator(api).run(fixture(), opts);
			expect(calls.globalsRead).toBe(0);
			expect(calls.globalsWritten).toHaveLength(0);
		});

		it("skips globals when importEnvironments=false", async () => {
			const { api, calls } = fakeApi();
			await new ImportOrchestrator(api).run(
				globalsFixture({ a: { value: "1", enabled: true } }),
				{ ...opts, importEnvironments: false }
			);
			expect(calls.globalsRead).toBe(0);
			expect(calls.globalsWritten).toHaveLength(0);
		});

		it("rolls back created collections when the globals write fails", async () => {
			const { api, calls } = fakeApi({
				updateGlobals: vi.fn(async () => {
					throw new Error("globals boom");
				}),
			});
			const result = fixture();
			result.globals = { g: { value: "1", enabled: true } };
			result.meta.globalCount = 1;
			await expect(new ImportOrchestrator(api).run(result, opts)).rejects.toThrow(
				"globals boom"
			);
			expect(calls.deletedCols).toContain(result.collections[0].id);
			expect(calls.deletedEnvs).toHaveLength(1);
		});

		it("writes globals only after collections and environments exist", async () => {
			// Ordering is load-bearing: globals is the one write that can destroy data the
			// import did not create, so nothing may fail behind it.
			const order: string[] = [];
			const { api } = fakeApi({
				createCollection: vi.fn(async (d) => {
					order.push("collection");
					return { id: d.id } as Collection;
				}),
				createEnvironment: vi.fn(async (d) => {
					order.push("environment");
					return { id: d.id } as Environment;
				}),
				updateGlobals: vi.fn(async (variables) => {
					order.push("globals");
					return { id: "globals", variables, updatedAt: "1" };
				}),
			});
			const result = fixture();
			result.globals = { g: { value: "1", enabled: true } };
			await new ImportOrchestrator(api).run(result, opts);
			expect(order[order.length - 1]).toBe("globals");
			expect(order.indexOf("collection")).toBeLessThan(order.indexOf("globals"));
			expect(order.indexOf("environment")).toBeLessThan(order.indexOf("globals"));
		});
	});
});
