/**
 * Every per-format fixture, imported through the single `/import/apply` payload,
 * must describe exactly the tree the old per-item POST path created (issue #96).
 *
 * The reference walk below *is* the deleted code: the same depth-first order, the
 * same fields, the same `bodyType = body.mode` and `order` indices, with
 * `parentId` / `collectionId` where the payload now carries `parentTempId` /
 * `collectionTempId`. Comparing against it catches a field the flattening
 * dropped, a parent it mis-wired, or an order it renumbered - none of which the
 * unit tests in orchestrator.test.ts would notice on a real collection's shape.
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ImportOrchestrator, type ImportApi } from "./orchestrator";
import { assignTempIds } from "./assign-ids";
import { parseImport } from "./factory";
import type { CollectionDraft, ImportOptions, ImportResult } from "./types";
import type { ImportApplyRequest } from "@/types";

const FIXTURES = [
	"postman-v21.json",
	"postman-v20.json",
	"postman-environment.json",
	"postman-globals.json",
	"insomnia-v4.json",
	"openapi-v3.json",
	"swagger-v2.json",
];

const opts: ImportOptions = { importEnvironments: true, importScripts: true };

function loadFixture(name: string): ImportResult {
	const raw = readFileSync(join(__dirname, "__fixtures__", name), "utf8");
	return parseImport(raw, opts, name);
}

/** What the pre-#96 orchestrator would have POSTed, item by item, in order. */
function legacyCreates(result: ImportResult, options: ImportOptions) {
	const collections: Record<string, unknown>[] = [];
	const requests: Record<string, unknown>[] = [];
	const environments: Record<string, unknown>[] = [];

	const createTree = (c: CollectionDraft, parentId: string | undefined, order: number) => {
		collections.push({
			id: c.tempId,
			name: c.name,
			description: c.description,
			parentId,
			order,
			variables: c.variables,
			auth: c.auth,
			preRequestScript: c.preRequestScript,
			postRequestScript: c.postRequestScript,
		});
		for (let i = 0; i < c.requests.length; i++) {
			const r = c.requests[i];
			requests.push({
				id: r.tempId,
				collectionId: c.tempId,
				name: r.name,
				description: r.description,
				method: r.method,
				url: r.url,
				params: r.params,
				headers: r.headers,
				body: r.body,
				bodyType: r.body.mode,
				auth: r.auth,
				preRequestScript: r.preRequestScript,
				postRequestScript: r.postRequestScript,
				order: i,
			});
		}
		for (let i = 0; i < c.children.length; i++) createTree(c.children[i], c.tempId, i);
	};

	for (let i = 0; i < result.collections.length; i++)
		createTree(result.collections[i], undefined, i);
	if (options.importEnvironments) {
		for (const e of result.environments) {
			environments.push({
				id: e.tempId,
				name: e.name,
				description: e.description,
				variables: e.variables,
			});
		}
	}
	return { collections, requests, environments };
}

/** Rename the payload's temp-id fields to the legacy id fields so the two are comparable. */
function asLegacyShape(payload: ImportApplyRequest) {
	return {
		collections: payload.collections.map(({ tempId, parentTempId, ...rest }) => ({
			id: tempId,
			parentId: parentTempId ?? undefined,
			...rest,
		})),
		requests: payload.requests.map(({ tempId, collectionTempId, ...rest }) => ({
			id: tempId,
			collectionId: collectionTempId,
			...rest,
		})),
		environments: payload.environments.map(({ tempId, ...rest }) => ({ id: tempId, ...rest })),
	};
}

async function capturePayload(result: ImportResult): Promise<ImportApplyRequest> {
	let captured: ImportApplyRequest | undefined;
	const api: ImportApi = {
		applyImport: vi.fn(async (payload: ImportApplyRequest) => {
			captured = payload;
			const idMap: Record<string, string> = {};
			for (const kind of ["collections", "requests", "environments"] as const) {
				for (const item of payload[kind]) idMap[item.tempId] = `real_${item.tempId}`;
			}
			return { idMap };
		}),
		// Globals are a singleton, not a payload item - a globals-only fixture must
		// still reach applyImport with an empty tree rather than skipping the call.
		getGlobals: vi.fn(async () => ({ id: "globals", variables: {}, updatedAt: "0" })),
		updateGlobals: vi.fn(async (variables) => ({ id: "globals", variables, updatedAt: "1" })),
	};
	await new ImportOrchestrator(api).run(result, opts);
	return captured!;
}

describe("import payload parity with the per-item path", () => {
	for (const name of FIXTURES) {
		it(`${name} produces the same tree in one call`, async () => {
			const result = assignTempIds(loadFixture(name));
			const legacy = legacyCreates(result, opts);

			// A fixture that parsed to nothing would make the comparison below
			// vacuous. Environment- and globals-only exports legitimately carry no
			// tree, so the guard counts every parsed item rather than requiring
			// collections - what it must never pass on is a fixture that parsed to
			// nothing at all.
			const parsedItems =
				legacy.collections.length +
				legacy.requests.length +
				legacy.environments.length +
				Object.keys(result.globals).length;
			expect(parsedItems).toBeGreaterThan(0);

			expect(asLegacyShape(await capturePayload(result))).toEqual(legacy);
		});
	}

	it("checks every fixture in the fixtures directory", () => {
		// Derived from the directory, not hardcoded: a new format's fixture has to
		// be added to FIXTURES rather than silently skipping this parity check.
		const onDisk = readdirSync(join(__dirname, "__fixtures__")).sort();
		expect(onDisk.length).toBeGreaterThan(0);
		expect([...FIXTURES].sort()).toEqual(onDisk);
	});
});
