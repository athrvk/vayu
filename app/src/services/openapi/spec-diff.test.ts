/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The sync diff (issue #654).
 *
 * Four things have to hold, and each is one #655 will act on rather than a
 * detail of the report:
 *
 *  - **A moved operation is followed, not lost.** Renaming a path under a stable
 *    `operationId` (or the reverse) must not read as "delete this request and
 *    make a new one" - that is data loss dressed as a sync.
 *  - **Changed means "no longer what the document produces"**, measured against
 *    the same parsers an import runs.
 *  - **The user-touched flag is three-way.** A two-way comparison cannot tell an
 *    edit apart from a spec change, and #655 would then quietly revert the edit.
 *  - **Nothing outside the contract is touched**: a request carrying no
 *    operation is counted and left alone.
 *
 * The requests are built *from* the bound document's own drafts, which is what
 * an import of it produced - so a difference these tests see is a difference the
 * app would really have.
 */

import { describe, it, expect } from "vitest";
import { diffSpec } from "./spec-diff";
import { readSpecOperations, type SpecRequestDraft } from "./spec-operations";
import type { Request } from "@/types";

interface OperationSpec {
	operationId?: string;
	summary?: string;
	description?: string;
	parameters?: unknown[];
	requestBody?: unknown;
}

const doc = (paths: Record<string, Record<string, OperationSpec>>): string =>
	JSON.stringify({
		openapi: "3.0.0",
		info: { title: "Pets API" },
		servers: [{ url: "https://api.example.com" }],
		paths,
	});

const jsonBody = (properties: Record<string, unknown>) => ({
	content: { "application/json": { schema: { type: "object", properties } } },
});

const BOUND = doc({
	"/pets": {
		get: { operationId: "listPets", summary: "List pets" },
		post: {
			operationId: "createPet",
			summary: "Create a pet",
			requestBody: jsonBody({ name: { type: "string" } }),
		},
	},
	"/pets/{petId}": { get: { operationId: "getPet", summary: "Get a pet" } },
});

/** One operation of a document, by `operationId`. */
function draftOf(raw: string, operationId: string): SpecRequestDraft {
	const found = readSpecOperations(raw).requests.find(
		(entry) => entry.operation.operationId === operationId
	);
	if (!found) throw new Error(`no operation ${operationId} in this fixture`);
	return found;
}

/** The request an import of that draft created, before anybody edited it. */
function requestFrom(
	id: string,
	entry: SpecRequestDraft,
	overrides: Partial<Request> = {}
): Request {
	const { draft, operation } = entry;
	return {
		id,
		collectionId: "col_1",
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

/** The whole collection as an import of `BOUND` left it. */
function boundCollection(): Request[] {
	return readSpecOperations(BOUND).requests.map((entry, i) => requestFrom(`req_${i}`, entry));
}

function diffAgainst(fetchedRaw: string, requests: Request[]) {
	return diffSpec({
		bound: readSpecOperations(BOUND).requests,
		fetched: readSpecOperations(fetchedRaw).requests,
		requests,
	});
}

const fieldNames = (fields: { field: string }[]): string[] => fields.map((f) => f.field).sort();

describe("a document that declares one operationId twice (issue #715)", () => {
	/*
	 * Invalid OpenAPI and ordinary in generated specs. Import now keeps a
	 * repeated id on its first declaration only, so what the diff has to survive
	 * is the shape an import *before* that fix left behind: two requests
	 * claiming one id, plus a document whose id names an operation that
	 * contradicts what the second request says it is.
	 */
	const DUP = doc({
		"/a": { get: { operationId: "list", summary: "List A" } },
		"/b": { post: { operationId: "list", summary: "Create B" } },
	});
	/** What an import before the fix stamped on the second declaration. */
	const staleStamp = { operationId: "list", method: "POST", path: "/b" } as const;

	const entries = () => readSpecOperations(DUP).requests;

	/** Both requests, the second still carrying the id the first also claims. */
	function collection(): Request[] {
		const [a, b] = entries();
		return [
			requestFrom("req_a", a),
			requestFrom("req_b", b, { specOperation: { ...staleStamp } }),
		];
	}

	const diffDup = (fetchedRaw: string, requests: Request[]) =>
		diffSpec({
			bound: entries(),
			fetched: readSpecOperations(fetchedRaw).requests,
			requests,
		});

	it("leaves the second request on its own operation when the first one changes", () => {
		const tweaked = doc({
			"/a": {
				get: { operationId: "list", summary: "List A", description: "Now documented" },
			},
			"/b": { post: { operationId: "list", summary: "Create B" } },
		});

		const diff = diffDup(tweaked, collection());

		// The id two requests claim identifies neither, so each is followed by its
		// own endpoint. Following the id instead pairs `req_b` with `GET /a` and
		// reports its name, url and body as changed.
		const b = diff.changed.find((c) => c.request.id === "req_b");
		expect(b?.matchedBy).toBe("path");
		expect(b?.operation).toEqual({ method: "POST", path: "/b" });
		expect(b?.fields).toEqual([]);
		const a = diff.changed.find((c) => c.request.id === "req_a");
		expect(fieldNames(a?.fields ?? [])).toEqual(["description"]);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
	});

	it("prefers the request's own endpoint over an id naming a different one", () => {
		// One claimant, so the id is not ambiguous among the requests - what
		// refuses it here is the entry it names having a different method and
		// path from the stamp, while the document still declares the stamp's own.
		const orphaned = [requestFrom("req_b", entries()[1], { specOperation: { ...staleStamp } })];

		const diff = diffDup(DUP, orphaned);

		const b = diff.changed.find((c) => c.request.id === "req_b");
		expect(b?.matchedBy).toBe("path");
		expect(b?.operation).toEqual({ method: "POST", path: "/b" });
		expect(b?.fields).toEqual([]);
		expect(diff.removed).toEqual([]);
		// Nothing claims `GET /a` now, which is an addition to offer and not a
		// request to overwrite.
		expect(diff.added.map((entry) => entry.operation.path)).toEqual(["/a"]);
	});

	it("reports a moved endpoint as gone rather than following the shared id to the other operation", () => {
		const moved = doc({
			"/a": { get: { operationId: "list", summary: "List A" } },
			"/b2": { post: { operationId: "list", summary: "Create B" } },
		});

		const diff = diffDup(moved, collection());

		expect(diff.removed.map((r) => r.id)).toEqual(["req_b"]);
		expect(diff.added.map((entry) => entry.operation.path)).toEqual(["/b2"]);
		expect(diff.changed).toEqual([]);
		expect(diff.unchanged).toBe(1);
	});
});

describe("diffSpec", () => {
	it("reports nothing changed when the document is the same", () => {
		const diff = diffAgainst(BOUND, boundCollection());

		expect(diff.changed).toEqual([]);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
		expect(diff.unchanged).toBe(3);
	});

	it("puts an operation no request claims in added, and a request whose operation is gone in removed", () => {
		const next = doc({
			"/pets": { get: { operationId: "listPets", summary: "List pets" } },
			"/owners": { get: { operationId: "listOwners", summary: "List owners" } },
		});

		const diff = diffAgainst(next, boundCollection());

		expect(diff.added.map((a) => a.operation.operationId)).toEqual(["listOwners"]);
		expect(diff.removed.map((r) => r.specOperation?.operationId).sort()).toEqual([
			"createPet",
			"getPet",
		]);
		expect(diff.unchanged).toBe(1);
	});

	it("counts a request that carries no operation instead of treating it as removed", () => {
		const handWritten = {
			...boundCollection()[0],
			id: "req_hand",
			specOperation: undefined,
		} as Request;

		const diff = diffAgainst(BOUND, [...boundCollection(), handWritten]);

		expect(diff.unmapped).toBe(1);
		expect(diff.removed).toEqual([]);
		expect(diff.unchanged).toBe(3);
	});

	it("follows an operationId whose path moved, rather than reporting a delete and an add", () => {
		const next = doc({
			"/pets": {
				get: { operationId: "listPets", summary: "List pets" },
				post: {
					operationId: "createPet",
					summary: "Create a pet",
					requestBody: jsonBody({ name: { type: "string" } }),
				},
			},
			"/animals/{petId}": { get: { operationId: "getPet", summary: "Get a pet" } },
		});

		const diff = diffAgainst(next, boundCollection());

		expect(diff.removed).toEqual([]);
		expect(diff.added).toEqual([]);
		const moved = diff.changed.find((c) => c.operation.operationId === "getPet");
		expect(moved?.matchedBy).toBe("operationId");
		expect(moved?.renamed).toBe(true);
		expect(moved?.boundOperation.path).toBe("/pets/{petId}");
		expect(fieldNames(moved?.fields ?? [])).toContain("url");
	});

	it("follows a path whose operationId moved, and reports it as a rename with no field change", () => {
		const next = doc({
			"/pets": {
				get: { operationId: "listPets", summary: "List pets" },
				post: {
					operationId: "createPet",
					summary: "Create a pet",
					requestBody: jsonBody({ name: { type: "string" } }),
				},
			},
			"/pets/{petId}": { get: { operationId: "readPet", summary: "Get a pet" } },
		});

		const diff = diffAgainst(next, boundCollection());

		const moved = diff.changed.find((c) => c.operation.operationId === "readPet");
		expect(moved?.matchedBy).toBe("path");
		expect(moved?.renamed).toBe(true);
		// Nothing an import writes differs - only the identity the request
		// records, which is why a pure rename is still in the changed bucket.
		expect(moved?.fields).toEqual([]);
		expect(diff.added).toEqual([]);
		expect(diff.removed).toEqual([]);
	});

	it("discloses an operation whose id and path both moved as a removal and an addition", () => {
		const next = doc({
			"/pets": {
				get: { operationId: "listPets", summary: "List pets" },
				post: {
					operationId: "createPet",
					summary: "Create a pet",
					requestBody: jsonBody({ name: { type: "string" } }),
				},
			},
			"/animals/{animalId}": { get: { operationId: "readAnimal", summary: "Get an animal" } },
		});

		const diff = diffAgainst(next, boundCollection());

		expect(diff.removed.map((r) => r.specOperation?.operationId)).toEqual(["getPet"]);
		expect(diff.added.map((a) => a.operation.operationId)).toEqual(["readAnimal"]);
		expect(diff.changed).toEqual([]);
	});

	it("treats a renamed path parameter as the same endpoint", () => {
		// Neither side declares an operationId, so only the path can carry the
		// identity - and `{petId}` -> `{id}` is the same position on the server,
		// which is the rule `matchOperations` already binds by.
		const bound = doc({ "/pets/{petId}": { get: { summary: "Get a pet" } } });
		const next = doc({ "/pets/{id}": { get: { summary: "Get a pet" } } });

		const diff = diffSpec({
			bound: readSpecOperations(bound).requests,
			fetched: readSpecOperations(next).requests,
			requests: [requestFrom("req_0", readSpecOperations(bound).requests[0])],
		});

		expect(diff.removed).toEqual([]);
		expect(diff.added).toEqual([]);
		expect(diff.changed).toHaveLength(1);
		expect(diff.changed[0].renamed).toBe(true);
	});

	describe("field comparison", () => {
		it("names every field the document moved, with the value it would write", () => {
			const next = doc({
				"/pets": {
					get: {
						operationId: "listPets",
						summary: "List all the pets",
						parameters: [{ name: "limit", in: "query", required: true, example: "10" }],
					},
					post: {
						operationId: "createPet",
						summary: "Create a pet",
						requestBody: jsonBody({ name: { type: "string" } }),
					},
				},
				"/pets/{petId}": { get: { operationId: "getPet", summary: "Get a pet" } },
			});

			const diff = diffAgainst(next, boundCollection());
			const listed = diff.changed.find((c) => c.operation.operationId === "listPets");

			expect(fieldNames(listed?.fields ?? [])).toEqual(["name", "params", "url"]);
			expect(listed?.fields.find((f) => f.field === "url")?.next).toContain("limit=10");
			expect(listed?.fields.find((f) => f.field === "name")?.next).toBe("List all the pets");
			expect(listed?.fields.some((f) => f.userTouched)).toBe(false);
			expect(diff.unchanged).toBe(2);
		});

		it("reports the body a changed schema now produces", () => {
			const next = doc({
				"/pets": {
					get: { operationId: "listPets", summary: "List pets" },
					post: {
						operationId: "createPet",
						summary: "Create a pet",
						requestBody: jsonBody({
							name: { type: "string" },
							tag: { type: "string" },
						}),
					},
				},
				"/pets/{petId}": { get: { operationId: "getPet", summary: "Get a pet" } },
			});

			const diff = diffAgainst(next, boundCollection());
			const created = diff.changed.find((c) => c.operation.operationId === "createPet");

			expect(fieldNames(created?.fields ?? [])).toEqual(["body"]);
			expect(created?.fields[0].next).toContain("tag");
		});

		it("flags a field the user edited away from the bound document's value", () => {
			const edited = requestFrom("req_0", draftOf(BOUND, "listPets"), {
				url: "{{baseUrl}}/pets?limit=5",
			});
			const next = doc({
				"/pets": {
					get: {
						operationId: "listPets",
						summary: "List pets",
						parameters: [{ name: "limit", in: "query", required: true, example: "50" }],
					},
				},
			});

			const diff = diffAgainst(next, [edited]);
			const field = diff.changed[0].fields.find((f) => f.field === "url");

			expect(field?.userTouched).toBe(true);
			expect(field?.current).toContain("limit=5");
			expect(field?.next).toContain("limit=50");
		});

		it("does not flag a field only the document moved", () => {
			// The mutation check for the three-way rule: compare the request
			// against the *new* document instead of the bound one and this flags,
			// which would have #655 refuse to apply a change nobody had touched.
			const untouched = requestFrom("req_0", draftOf(BOUND, "listPets"));
			const next = doc({
				"/pets": {
					get: {
						operationId: "listPets",
						summary: "List pets",
						parameters: [{ name: "limit", in: "query", required: true, example: "50" }],
					},
				},
			});

			const diff = diffAgainst(next, [untouched]);

			expect(diff.changed[0].fields.length).toBeGreaterThan(0);
			expect(diff.changed[0].fields.some((f) => f.userTouched)).toBe(false);
		});

		it("makes no claim about who edited what when the bound document cannot be read", () => {
			const edited = requestFrom("req_0", draftOf(BOUND, "listPets"), {
				name: "My list call",
			});

			const diff = diffSpec({
				bound: null,
				fetched: readSpecOperations(
					doc({ "/pets": { get: { operationId: "listPets", summary: "List pets" } } })
				).requests,
				requests: [edited],
			});

			expect(diff.changed[0].previousUnknown).toBe(true);
			expect(fieldNames(diff.changed[0].fields)).toEqual(["name"]);
			expect(diff.changed[0].fields[0].userTouched).toBe(false);
		});

		it("reports a request the user edited as divergence, flagged as theirs", () => {
			// The document did not move; this request no longer matches it because
			// somebody renamed it. It is still a difference #655 must know about -
			// and the flag is what stops #655 from putting the summary back.
			const renamedByUser = requestFrom("req_2", draftOf(BOUND, "getPet"), {
				name: "Fetch one pet",
			});

			const diff = diffAgainst(BOUND, [renamedByUser]);

			expect(fieldNames(diff.changed[0].fields)).toEqual(["name"]);
			expect(diff.changed[0].fields[0].userTouched).toBe(true);
			expect(diff.changed[0].renamed).toBe(false);
		});
	});
});
