/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turning a diff and a set of ticks into the one call that applies it (#655).
 *
 * The rules here are the ones a user's work depends on, so each is pinned
 * against the payload rather than against the UI that builds it:
 *
 *  - **A field the user edited is not in the payload** unless it was ticked, and
 *    a request whose bound document could not be read is not in it at all.
 *  - **A removal is never a default.** `delete` is empty until somebody says
 *    otherwise, however obviously gone the operation is.
 *  - **An added operation lands where an import would have put it** - the tag
 *    folder that already exists, or one folder created per tag and no more.
 *  - **The identity travels with an applied change**, even when no field was
 *    ticked, because a request left recording the old identity is one the next
 *    sync diffs against the wrong operation.
 *
 * The requests are built from the bound document's own drafts, exactly as
 * `spec-diff.test.ts` builds them, so a difference here is one the app would
 * really have had.
 */

import { describe, it, expect } from "vitest";
import { diffSpec } from "./spec-diff";
import {
	buildSyncPayload,
	defaultSelection,
	isEmptySelection,
	operationKey,
	type SpecApplySelection,
} from "./spec-apply";
import { readSpecOperations, type SpecRequestDraft } from "./spec-operations";
import type { Collection, Request } from "@/types";

interface OperationSpec {
	operationId?: string;
	summary?: string;
	tags?: string[];
	parameters?: unknown[];
	responses?: unknown;
}

const doc = (paths: Record<string, Record<string, OperationSpec>>): string =>
	JSON.stringify({
		openapi: "3.0.0",
		info: { title: "Pets API" },
		servers: [{ url: "https://api.example.com" }],
		paths,
	});

const BOUND = doc({
	"/pets": { get: { operationId: "listPets", summary: "List pets", tags: ["pets"] } },
	"/owners": { get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] } },
});

function requestFrom(
	id: string,
	entry: SpecRequestDraft,
	overrides: Partial<Request> = {}
): Request {
	const { draft, operation } = entry;
	return {
		id,
		collectionId: "col_pets",
		name: draft.name,
		description: draft.description,
		method: draft.method,
		url: draft.url,
		params: draft.params,
		headers: draft.headers,
		body: draft.body,
		bodyType: draft.body.mode,
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		stream: false,
		specOperation: operation,
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as Request;
}

function boundCollection(overrides: Record<string, Partial<Request>> = {}): Request[] {
	return readSpecOperations(BOUND).requests.map((entry, i) =>
		requestFrom(`req_${i}`, entry, overrides[entry.operation.operationId ?? ""] ?? {})
	);
}

const collections = (...names: string[]): Collection[] => [
	{ id: "col_root", name: "Pets API", order: 0 } as Collection,
	...names.map(
		(name, i) => ({ id: `col_${name}`, name, parentId: "col_root", order: i }) as Collection
	),
];

function diffOf(fetchedRaw: string, requests: Request[]) {
	return diffSpec({
		bound: readSpecOperations(BOUND).requests,
		fetched: readSpecOperations(fetchedRaw).requests,
		requests,
	});
}

function payload(
	fetchedRaw: string,
	requests: Request[],
	selection?: (base: SpecApplySelection) => SpecApplySelection,
	stored: Collection[] = collections("pets", "owners")
) {
	const diff = diffOf(fetchedRaw, requests);
	const base = defaultSelection(diff);
	return buildSyncPayload({
		collectionId: "col_root",
		diff,
		selection: selection ? selection(base) : base,
		content: fetchedRaw,
		sourceUrl: "https://api.example.com/spec.json",
		collections: stored,
	});
}

describe("defaultSelection", () => {
	it("ticks every added operation and no removal", () => {
		const fetched = doc({
			"/pets": { get: { operationId: "listPets", summary: "List pets", tags: ["pets"] } },
			"/vets": { get: { operationId: "listVets", summary: "List vets", tags: ["vets"] } },
		});
		const diff = diffOf(fetched, boundCollection());
		const selection = defaultSelection(diff);

		expect([...selection.added]).toEqual(["GET /vets"]);
		// `listOwners` is gone from the document, and stays until somebody says so.
		expect(diff.removed).toHaveLength(1);
		expect(selection.removed.size).toBe(0);
	});

	it("leaves a field the user edited unticked, and takes one only the document moved", () => {
		// Mutation check: drop the `userTouched` filter and `name` appears here.
		const fetched = doc({
			"/pets": { get: { operationId: "listPets", summary: "Every pet", tags: ["pets"] } },
			"/owners": {
				get: { operationId: "listOwners", summary: "Every owner", tags: ["owners"] },
			},
		});
		const requests = boundCollection({ listPets: { name: "My pets call" } });
		const selection = defaultSelection(diffOf(fetched, requests));

		expect([...(selection.changed.get("req_0") ?? [])]).toEqual([]);
		expect([...(selection.changed.get("req_1") ?? [])]).toEqual(["name"]);
	});

	it("offers nothing for a request whose bound document could not be read", () => {
		// With no old value, "the user edited it" is not a claim anything can
		// make - so the whole request is left for the user to decide about.
		const fetched = doc({
			"/pets": { get: { operationId: "listPets", summary: "Every pet", tags: ["pets"] } },
			"/owners": {
				get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] },
			},
		});
		const diff = diffSpec({
			bound: null,
			fetched: readSpecOperations(fetched).requests,
			requests: boundCollection(),
		});

		expect(diff.changed).toHaveLength(1);
		expect(diff.changed[0].previousUnknown).toBe(true);
		expect(defaultSelection(diff).changed.size).toBe(0);
	});

	it("is empty when the document changed nothing this collection holds", () => {
		expect(isEmptySelection(defaultSelection(diffOf(BOUND, boundCollection())))).toBe(true);
	});
});

describe("buildSyncPayload", () => {
	it("files an added operation in the tag folder that already exists", () => {
		const fetched = doc({
			"/pets": { get: { operationId: "listPets", summary: "List pets", tags: ["pets"] } },
			"/pets/{petId}": {
				get: { operationId: "getPet", summary: "Get a pet", tags: ["pets"] },
			},
			"/owners": {
				get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] },
			},
		});
		const body = payload(fetched, boundCollection());

		expect(body.collections).toEqual([]);
		expect(body.create).toHaveLength(1);
		expect(body.create[0].collectionId).toBe("col_pets");
		expect(body.create[0].specOperation).toEqual({
			operationId: "getPet",
			method: "GET",
			path: "/pets/{petId}",
		});
	});

	it("creates one folder per new tag however many operations name it", () => {
		const fetched = doc({
			"/pets": { get: { operationId: "listPets", summary: "List pets", tags: ["pets"] } },
			"/owners": {
				get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] },
			},
			"/vets": { get: { operationId: "listVets", summary: "List vets", tags: ["vets"] } },
			"/vets/{vetId}": {
				get: { operationId: "getVet", summary: "Get a vet", tags: ["vets"] },
			},
		});
		const body = payload(fetched, boundCollection());

		expect(body.collections).toHaveLength(1);
		expect(body.collections[0].name).toBe("vets");
		expect(body.collections[0].parentId).toBe("col_root");
		const temp = body.collections[0].tempId;
		expect(body.create.map((item) => item.collectionTempId)).toEqual([temp, temp]);
		expect(body.create.every((item) => item.collectionId === undefined)).toBe(true);
	});

	it("puts an untagged operation on the bound collection itself", () => {
		const fetched = doc({
			"/pets": { get: { operationId: "listPets", summary: "List pets", tags: ["pets"] } },
			"/owners": {
				get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] },
			},
			"/health": { get: { operationId: "health", summary: "Health" } },
		});
		const body = payload(fetched, boundCollection());

		expect(body.collections).toEqual([]);
		expect(body.create[0].collectionId).toBe("col_root");
	});

	it("writes only the ticked fields, plus the identity and the examples", () => {
		const fetched = doc({
			"/pets": {
				get: {
					operationId: "listPets",
					summary: "Every pet",
					tags: ["pets"],
					parameters: [{ name: "limit", in: "query", required: true, example: "50" }],
				},
			},
			"/owners": {
				get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] },
			},
		});
		const body = payload(fetched, boundCollection(), (base) => ({
			...base,
			changed: new Map([["req_0", new Set<"name">(["name"])]]),
		}));

		expect(body.update).toHaveLength(1);
		const patch = body.update[0];
		expect(patch.name).toBe("Every pet");
		// `url` and `params` moved too, and were not ticked.
		expect(patch.url).toBeUndefined();
		expect(patch.params).toBeUndefined();
		// The identity always rides along - see the module comment.
		expect(patch.specOperation).toEqual({
			operationId: "listPets",
			method: "GET",
			path: "/pets",
		});
		expect(patch.method).toBe("GET");
		expect(patch.examples).toEqual([]);
	});

	it("sends a request whose only change is its identity", () => {
		// The document renamed the path under a stable operationId, so nothing
		// about the request's fields moved except the URL - untick it and the
		// identity is the whole of the change, which is still a change to write.
		const fetched = doc({
			"/animals": { get: { operationId: "listPets", summary: "List pets", tags: ["pets"] } },
			"/owners": {
				get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] },
			},
		});
		const body = payload(fetched, boundCollection(), (base) => ({
			...base,
			changed: new Map([["req_0", new Set()]]),
		}));

		expect(body.update).toHaveLength(1);
		expect(body.update[0].url).toBeUndefined();
		expect(body.update[0].specOperation?.path).toBe("/animals");
	});

	it("names a removal only once it is ticked, in the diff's own order", () => {
		const fetched = doc({
			"/pets": { get: { operationId: "listPets", summary: "List pets", tags: ["pets"] } },
		});
		const requests = boundCollection();

		expect(payload(fetched, requests).delete).toEqual([]);
		expect(
			payload(fetched, requests, (base) => ({
				...base,
				removed: new Set(["req_1"]),
			})).delete
		).toEqual(["req_1"]);
	});

	it("carries the document's own responses as the examples that replace the imported ones", () => {
		const fetched = doc({
			"/pets": {
				get: {
					operationId: "listPets",
					summary: "Every pet",
					tags: ["pets"],
					responses: {
						"200": {
							description: "ok",
							content: { "application/json": { example: { id: 1 } } },
						},
					},
				},
			},
			"/owners": {
				get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] },
			},
		});
		const patch = payload(fetched, boundCollection()).update.find(
			(item) => item.id === "req_0"
		);

		expect(patch?.examples).toHaveLength(1);
		expect(patch?.examples?.[0].status).toBe(200);
	});

	it("keys an added operation the way the checklist does", () => {
		// The UI ticks by `operationKey`, so a payload built from a selection the
		// UI produced depends on the two agreeing.
		const fetched = doc({
			"/pets": { get: { operationId: "listPets", summary: "List pets", tags: ["pets"] } },
			"/owners": {
				get: { operationId: "listOwners", summary: "List owners", tags: ["owners"] },
			},
			"/vets": { get: { operationId: "listVets", summary: "List vets", tags: ["vets"] } },
		});
		const diff = diffOf(fetched, boundCollection());

		expect(diff.added.map((entry) => operationKey(entry.operation))).toEqual(["GET /vets"]);
		expect(
			payload(fetched, boundCollection(), (base) => ({ ...base, added: new Set() })).create
		).toEqual([]);
	});
});
