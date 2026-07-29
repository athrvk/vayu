import { describe, it, expect } from "vitest";
import { assignTempIds } from "./assign-ids";
import type { ImportResult } from "./types";

function fixture(): ImportResult {
	return {
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
						name: "r",
						description: "",
						method: "GET",
						url: "",
						params: [],
						headers: [],
						body: { mode: "none" },
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
								url: "",
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
		environments: [{ name: "e", description: "", variables: {} }],
		globals: {},
		meta: {
			format: "x",
			requestCount: 2,
			folderCount: 2,
			environmentCount: 1,
			globalCount: 0,
			skipped: [],
			nonExecutableAuth: 0,
		},
	};
}

describe("assignTempIds", () => {
	it("stamps a unique temp id on every collection, request, and environment", () => {
		const r = assignTempIds(fixture());
		const root = r.collections[0];
		const child = root.children[0];

		const all = [
			root.tempId,
			child.tempId,
			root.requests[0].tempId,
			child.requests[0].tempId,
			r.environments[0].tempId,
		];
		expect(all.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
		expect(new Set(all).size).toBe(all.length);
	});

	it("issues opaque temp ids, not engine record ids", () => {
		// The engine owns every real id on this path and rejects a client-supplied
		// `id`; a `col_`/`req_`/`env_`-shaped value here would read as a record id
		// and invite exactly that mistake back.
		const r = assignTempIds(fixture());
		const ids = [
			r.collections[0].tempId!,
			r.collections[0].requests[0].tempId!,
			r.environments[0].tempId!,
		];
		for (const id of ids) {
			expect(id).not.toMatch(/^(col|req|env)_/);
		}
	});
});
