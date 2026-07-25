import { describe, it, expect, vi } from "vitest";
import { ImportOrchestrator, type ImportApi } from "./orchestrator";
import { assignTempIds } from "./assign-ids";
import type { ImportResult } from "./types";
import type { ImportApplyRequest } from "@/types";

/**
 * Fake engine. `idMap` echoes every tempId it was sent unless `drop` names one,
 * which is how the "engine skipped an item" path is exercised.
 */
function fakeApi(options: { drop?: string[]; reject?: Error } = {}): {
	api: ImportApi;
	calls: ImportApplyRequest[];
} {
	const calls: ImportApplyRequest[] = [];
	const api: ImportApi = {
		applyImport: vi.fn(async (payload: ImportApplyRequest) => {
			calls.push(payload);
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
	};
	return { api, calls };
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
		meta: {
			format: "x",
			requestCount: 2,
			folderCount: 1,
			environmentCount: 1,
			skipped: [],
			nonExecutableAuth: 0,
		},
	});
}

const opts = { importEnvironments: true, importScripts: true };

describe("ImportOrchestrator", () => {
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
		expect(root.order).toBe(0);
		expect(child.parentTempId).toBe(root.tempId);
		expect(child.order).toBe(0); // first child of its own parent

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
			meta: {
				format: "x",
				requestCount: 0,
				folderCount: 1,
				environmentCount: 1,
				skipped: [],
				nonExecutableAuth: 0,
			},
		};
		await expect(new ImportOrchestrator(api).run(result, opts)).rejects.toThrow(
			/assignTempIds/
		);
		expect(calls).toHaveLength(0);
	});
});
