import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImportOrchestrator, type ImportApi } from "./orchestrator";
import { assignTempIds } from "./assign-ids";
import { parseImport } from "./factory";
import type { ImportResult } from "./types";
import type { ImportApplyRequest, VariableValue } from "@/types";

/**
 * Fake engine. `idMap` echoes every tempId it was sent unless `drop` names one,
 * which is how the "engine skipped an item" path is exercised.
 *
 * Globals are not part of the bulk payload - the engine keeps them as a
 * singleton - so the fake tracks that read/write pair separately, and `order`
 * records the sequence the two writes actually happened in.
 */
function fakeApi(
	options: {
		drop?: string[];
		reject?: Error;
		existingGlobals?: Record<string, VariableValue>;
		rejectGlobals?: Error;
	} = {}
): {
	api: ImportApi;
	calls: ImportApplyRequest[];
	globals: { reads: number; writes: Record<string, VariableValue>[] };
	order: string[];
} {
	const calls: ImportApplyRequest[] = [];
	const globals = { reads: 0, writes: [] as Record<string, VariableValue>[] };
	const order: string[] = [];
	const api: ImportApi = {
		applyImport: vi.fn(async (payload: ImportApplyRequest) => {
			calls.push(payload);
			order.push("apply");
			if (options.reject) throw options.reject;
			const idMap: Record<string, string> = {};
			const prefix = { collections: "col_", requests: "req_", environments: "env_" } as const;
			for (const kind of ["collections", "requests", "environments"] as const) {
				for (const item of payload[kind]) {
					if (options.drop?.includes(item.tempId)) continue;
					idMap[item.tempId] = `${prefix[kind]}${item.tempId}`;
				}
			}
			return { idMap };
		}),
		getGlobals: vi.fn(async () => {
			globals.reads++;
			return { id: "globals", variables: options.existingGlobals ?? {}, updatedAt: "0" };
		}),
		updateGlobals: vi.fn(async (variables: Record<string, VariableValue>) => {
			order.push("globals");
			if (options.rejectGlobals) throw options.rejectGlobals;
			globals.writes.push(variables);
			return { id: "globals", variables, updatedAt: "1" };
		}),
	};
	return { api, calls, globals, order };
}

function fixture(): ImportResult {
	return assignTempIds({
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
			exampleCount: 0,
			skipped: [],
			nonExecutableAuth: 0,
			unattachedFileParts: 0,
		},
	});
}

const opts = { importEnvironments: true, importScripts: true };

describe("ImportOrchestrator", () => {
	it("forwards a draft's redirect settings, and omits them when unstated", async () => {
		// `followRedirects`/`maxRedirects` are optional on the draft precisely so an
		// import that says nothing is distinguishable from one that said `true` -
		// the engine seeds its own defaults for an absent field. A key present with
		// `undefined` would blur that, so presence is what is asserted.
		const result = fixture();
		result.collections[0].requests[0].followRedirects = false;
		result.collections[0].requests[0].maxRedirects = 3;

		const { api, calls } = fakeApi();
		await new ImportOrchestrator(api).run(result, opts);

		const [stated, unstated] = calls[0].requests;
		expect(stated.followRedirects).toBe(false);
		expect(stated.maxRedirects).toBe(3);
		expect(Object.keys(unstated)).not.toContain("followRedirects");
		expect(Object.keys(unstated)).not.toContain("maxRedirects");
	});

	it("stores an imported request's query inside its url (issue #590)", async () => {
		/*
		 * The end of the chain the issue traced: whatever `url` this payload
		 * carries is what the engine stores, what the builder loads into the URL
		 * bar, and what every execution path - design Send, scenario run, load
		 * run - sends verbatim, since no engine path reads `params[]` at all. So
		 * the query has to be in `url` by the time the import is applied, not
		 * repaired later by the user's first edit of the Params table.
		 */
		const result = assignTempIds(
			parseImport(
				readFileSync(join(__dirname, "__fixtures__", "postman-v21.json"), "utf8"),
				opts
			)
		);
		const { api, calls } = fakeApi();
		await new ImportOrchestrator(api).run(result, opts);

		const listUsers = calls[0].requests.find((r) => r.name === "List users")!;
		expect(listUsers.url).toBe("{{baseUrl}}/users?page=1");
		expect(listUsers.params).toEqual([
			{ key: "page", value: "1", enabled: true },
			{ key: "trace", value: "1", enabled: false },
		]);
	});

	it("sends the whole tree in exactly one /import/apply call", async () => {
		const { api, calls } = fakeApi();
		await new ImportOrchestrator(api).run(fixture(), opts);

		expect(api.applyImport).toHaveBeenCalledTimes(1);
		const payload = calls[0];
		expect(payload.collections).toHaveLength(2);
		expect(payload.requests).toHaveLength(2);
		expect(payload.environments).toHaveLength(1);
	});

	it("wires parents, owners, order, bodyType and auth through temp ids", async () => {
		const { api, calls } = fakeApi();
		await new ImportOrchestrator(api).run(fixture(), opts);
		const { collections, requests, environments } = calls[0];

		const root = collections[0];
		const child = collections[1];
		expect(root.parentTempId).toBeNull();
		/*
		 * A root states no order at all (issue #360). The engine's create path
		 * appends after the roots already in the workspace; sending the payload
		 * index collided with their 0, 1, 2... and an import into a non-empty
		 * workspace interleaved itself through the user's tree by tie lottery.
		 * Asserted as an absent *key*, not `undefined`: the field appliers read
		 * presence, and `order: undefined` would serialize away in a way this
		 * assertion could not tell from the real thing.
		 */
		expect("order" in root).toBe(false);
		expect(child.parentTempId).toBe(root.tempId);
		expect(child.order).toBe(0); // first child of its own parent, no collision

		const r1 = requests.find((r) => r.name === "r1")!;
		const r2 = requests.find((r) => r.name === "r2")!;
		expect(r1.collectionTempId).toBe(root.tempId);
		expect(r2.collectionTempId).toBe(child.tempId);
		expect(r1.bodyType).toBe("json"); // the engine never derives this
		expect(r1.auth).toEqual({ mode: "inherit" });
		expect(typeof r1.order).toBe("number");

		expect(environments[0].description).toBe("d");
		expect("isActive" in environments[0]).toBe(false);
		// Temp ids are the only identity the client sends; a real id would be a 400.
		for (const item of [...collections, ...requests, ...environments]) {
			expect("id" in item).toBe(false);
		}
	});

	it("skips environments when importEnvironments=false", async () => {
		const { api, calls } = fakeApi();
		await new ImportOrchestrator(api).run(fixture(), { ...opts, importEnvironments: false });
		expect(calls[0].environments).toHaveLength(0);
	});

	it("propagates the engine's failure (nothing to roll back - the write is atomic)", async () => {
		const { api } = fakeApi({ reject: new Error("boom") });
		await expect(new ImportOrchestrator(api).run(fixture(), opts)).rejects.toThrow("boom");
	});

	it("fails loudly when the id-map omits an item the engine was sent", async () => {
		// A silently skipped item would look like a clean import until the user
		// noticed something missing, so the id-map is checked rather than trusted.
		const withTempIds = fixture();
		const droppedRequest = withTempIds.collections[0].requests[0].tempId!;
		const { api } = fakeApi({ drop: [droppedRequest] });
		await expect(new ImportOrchestrator(api).run(withTempIds, opts)).rejects.toThrow(
			/Import incomplete/
		);
	});

	it("throws before calling the engine when a draft has no temp id", async () => {
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
				exampleCount: 0,
				skipped: [],
				nonExecutableAuth: 0,
				unattachedFileParts: 0,
			},
		};
		await expect(new ImportOrchestrator(api).run(result, opts)).rejects.toThrow(
			/assignTempIds/
		);
		expect(calls).toHaveLength(0);
	});

	describe("globals", () => {
		/** A globals-only result, the shape a Postman globals export parses to. */
		function globalsFixture(globals: Record<string, VariableValue>): ImportResult {
			return assignTempIds({
				collections: [],
				environments: [],
				globals,
				meta: {
					format: "Postman Globals",
					requestCount: 0,
					folderCount: 0,
					environmentCount: 0,
					globalCount: Object.keys(globals).length,
					exampleCount: 0,
					skipped: [],
					nonExecutableAuth: 0,
					unattachedFileParts: 0,
				},
			});
		}

		it("merges into the existing set rather than replacing it", async () => {
			// POST /globals replaces everything, so a write that is not a merge would
			// delete `keep` - the whole reason applyGlobals reads first.
			const { api, globals } = fakeApi({
				existingGlobals: { keep: { value: "old", enabled: true } },
			});
			await new ImportOrchestrator(api).run(
				globalsFixture({ fresh: { value: "new", enabled: true } }),
				opts
			);
			expect(globals.writes).toHaveLength(1);
			expect(globals.writes[0]).toEqual({
				keep: { value: "old", enabled: true },
				fresh: { value: "new", enabled: true },
			});
		});

		it("lets the imported value win a name collision", async () => {
			const { api, globals } = fakeApi({
				existingGlobals: { token: { value: "old", enabled: true } },
			});
			await new ImportOrchestrator(api).run(
				globalsFixture({ token: { value: "imported", enabled: true } }),
				opts
			);
			expect(globals.writes[0].token).toEqual({ value: "imported", enabled: true });
		});

		it("neither reads nor writes globals when the result has none", async () => {
			// Every other format lands here; an import must not touch the globals scope.
			const { api, globals } = fakeApi();
			await new ImportOrchestrator(api).run(fixture(), opts);
			expect(globals.reads).toBe(0);
			expect(globals.writes).toHaveLength(0);
		});

		it("skips globals when importEnvironments=false", async () => {
			const { api, globals } = fakeApi();
			await new ImportOrchestrator(api).run(
				globalsFixture({ a: { value: "1", enabled: true } }),
				{ ...opts, importEnvironments: false }
			);
			expect(globals.reads).toBe(0);
			expect(globals.writes).toHaveLength(0);
		});

		it("does not touch globals when the bulk apply fails", async () => {
			// The apply is atomic, so a failed import created nothing - and the globals
			// singleton is the one thing here that would outlive it.
			const { api, globals } = fakeApi({ reject: new Error("boom") });
			const result = globalsFixture({ g: { value: "1", enabled: true } });
			await expect(new ImportOrchestrator(api).run(result, opts)).rejects.toThrow("boom");
			expect(globals.reads).toBe(0);
			expect(globals.writes).toHaveLength(0);
		});

		it("surfaces a failed globals write with the imported tree already committed", async () => {
			// The engine call is atomic but the globals write is a second, separate
			// request, so this is the one partial outcome left: the tree landed and the
			// globals did not. The error must reach the user rather than be swallowed -
			// there is no rollback to undo an atomic apply that succeeded.
			const { api, calls } = fakeApi({ rejectGlobals: new Error("globals boom") });
			const result = fixture();
			result.globals = { g: { value: "1", enabled: true } };
			result.meta.globalCount = 1;
			await expect(new ImportOrchestrator(api).run(result, opts)).rejects.toThrow(
				"globals boom"
			);
			expect(calls).toHaveLength(1);
		});

		it("writes globals only after the bulk apply has landed", async () => {
			// Ordering is load-bearing: globals is the one write that can destroy data the
			// import did not create, so nothing may fail behind it.
			const { api, order } = fakeApi();
			const result = fixture();
			result.globals = { g: { value: "1", enabled: true } };
			await new ImportOrchestrator(api).run(result, opts);
			expect(order).toEqual(["apply", "globals"]);
		});
	});
});
