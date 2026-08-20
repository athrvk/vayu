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
 * **The diffs are written out rather than computed** (issue #854). The
 * comparison is `POST /specs/diff`'s now, and its own rules - which request is
 * which operation after a rename, which fields moved, which of them the user had
 * edited - are pinned in `engine/tests/spec_diff_test.cpp` against real
 * documents. What is left here is the half this file owns: given that answer,
 * what gets written. So each case states the diff it is about, which also makes
 * the input to a payload readable in the same screen as the payload.
 */

import { describe, it, expect } from "vitest";
import {
	buildSyncPayload,
	defaultSelection,
	isEmptySelection,
	operationKey,
	type SpecApplySelection,
} from "./spec-apply";
import type {
	Collection,
	SpecDiffAdded,
	SpecDiffChanged,
	SpecDiffResponse,
	SpecDraftRequest,
	SpecField,
	SpecFieldDiff,
	SpecOperation,
} from "@/types";

/** The draft an import would build, with the fields a case cares about. */
function draft(overrides: Partial<SpecDraftRequest> = {}): SpecDraftRequest {
	return {
		name: "List pets",
		description: "",
		method: "GET",
		url: "{{baseUrl}}/pets",
		params: [],
		headers: [],
		body: { mode: "none" },
		examples: [],
		...overrides,
	};
}

/**
 * An added entry as the engine answers one.
 *
 * `safe` is part of the answer now (issue #871), not something this side works
 * out - these fixtures stand in for `POST /specs/diff`, so they state the marks
 * the engine would. What the marks *mean* is pinned engine-side, in
 * `spec_diff_test.cpp`.
 */
function added(
	operation: SpecOperation,
	folder: string,
	overrides: Partial<SpecDraftRequest> = {},
	safe = true
): SpecDiffAdded {
	return { operation, folder, draft: draft({ name: operation.path, ...overrides }), safe };
}

function field(name: SpecField, userTouched = false): SpecFieldDiff {
	return { field: name, current: "before", next: "after", userTouched };
}

function changed(
	requestId: string,
	operation: SpecOperation,
	fields: SpecFieldDiff[],
	overrides: Partial<SpecDiffChanged> = {}
): SpecDiffChanged {
	const base = {
		requestId,
		name: "List pets",
		boundOperation: operation,
		operation,
		matchedBy: "operationId" as const,
		renamed: false,
		previousUnknown: false,
		fields,
		draft: draft(),
		...overrides,
	};
	// The marks an engine answering this entry would attach, unless the case
	// states its own. Written out here rather than imported from anywhere,
	// because this is a stand-in for a wire answer - the rule itself has one
	// author and it is C++.
	const safeFields = base.previousUnknown
		? []
		: base.fields.filter((f) => !f.userTouched).map((f) => f.field);
	return {
		safe: !base.previousUnknown && (safeFields.length > 0 || base.renamed),
		safeFields,
		...base,
		...overrides,
	};
}

function diffOf(parts: Partial<SpecDiffResponse> = {}): SpecDiffResponse {
	return {
		identical: false,
		added: [],
		removed: [],
		changed: [],
		unchanged: 0,
		unmapped: 0,
		...parts,
	};
}

const LIST_PETS: SpecOperation = { operationId: "listPets", method: "GET", path: "/pets" };
const GET_PET: SpecOperation = { operationId: "getPet", method: "GET", path: "/pets/{petId}" };
const LIST_VETS: SpecOperation = { operationId: "listVets", method: "GET", path: "/vets" };
const GET_VET: SpecOperation = { operationId: "getVet", method: "GET", path: "/vets/{vetId}" };

const collections = (...names: string[]): Collection[] => [
	{ id: "col_root", name: "Pets API", order: 0 } as Collection,
	...names.map(
		(name, i) => ({ id: `col_${name}`, name, parentId: "col_root", order: i }) as Collection
	),
];

function payload(
	diff: SpecDiffResponse,
	selection?: (base: SpecApplySelection) => SpecApplySelection,
	stored: Collection[] = collections("pets", "owners")
) {
	const base = defaultSelection(diff);
	return buildSyncPayload({
		collectionId: "col_root",
		diff,
		selection: selection ? selection(base) : base,
		content: '{"openapi":"3.0.0"}',
		sourceUrl: "https://api.example.com/spec.json",
		collections: stored,
	});
}

describe("a duplicated operationId is not corruption a default apply can commit (issue #715)", () => {
	/*
	 * The end-to-end shape of the failure: a generated document declares one id
	 * on two operations, an import before the fix stamped it on both requests,
	 * and upstream then tweaks the first operation. The user clicks Check for
	 * changes and Apply with everything ticked as it came.
	 *
	 * The engine's comparison is what refuses to follow the shared id - pinned in
	 * `spec_diff_test.cpp`, where the second request is followed by its own path
	 * and reports no field at all. What must not be in the payload built from
	 * that answer is a write that moves the second request onto the first one's
	 * operation.
	 */
	it("writes nothing of the first operation onto the second request", () => {
		const createB: SpecOperation = { method: "POST", path: "/b" };
		const diff = diffOf({
			changed: [
				changed("req_a", { operationId: "list", method: "GET", path: "/a" }, [
					field("name"),
				]),
				// Followed by its path: the id two requests claim identifies neither,
				// so the document's `GET /a` never reaches this row. Its identity is
				// the whole of the change - dropping the id it can no longer state.
				changed("req_b", createB, [], {
					boundOperation: { operationId: "list", method: "POST", path: "/b" },
					matchedBy: "path",
					renamed: true,
				}),
			],
		});

		const body = payload(diff, undefined, collections());

		const b = body.update.find((u) => u.id === "req_b");
		expect(b?.specOperation).toEqual({ method: "POST", path: "/b" });
		// No field of it is written at all - the update exists only to drop the id
		// the other operation kept, which is the ambiguity being repaired. `method`
		// is one of those fields since #717, so it is absent rather than
		// re-asserted as "POST" - a stronger form of the same claim, because the
		// first operation's `GET` cannot reach this request through a key that is
		// not there.
		expect(b?.method).toBeUndefined();
		expect(b?.name).toBeUndefined();
		expect(b?.url).toBeUndefined();
		// The tweak lands where it belongs, on the request that operation is.
		expect(body.update.find((u) => u.id === "req_a")?.name).toBe("List pets");
	});
});

describe("defaultSelection reads the engine's marks", () => {
	/*
	 * What these ticks *mean* - everything the document adds, every field it
	 * moved that nobody had edited, no deletions, a request nothing can be told
	 * apart about left alone - is `core::safe_spec_apply`, pinned in the engine's
	 * `spec_diff_test.cpp` (issue #871). What is pinned here is that this side
	 * reads that answer rather than deriving its own, which is the whole of what
	 * moving the rule engine-side bought: an agent's `sync_spec` and a person's
	 * untouched Apply write the same rows.
	 */
	it("ticks what the engine marked safe and nothing it did not", () => {
		const diff = diffOf({
			added: [added(LIST_VETS, "vets"), added(GET_VET, "vets", {}, /* safe */ false)],
			removed: [
				{ requestId: "req_1", name: "List owners", operation: LIST_PETS, safe: false },
			],
			changed: [
				changed("req_0", LIST_PETS, [field("name")], { safe: false, safeFields: [] }),
				changed("req_1", GET_PET, [field("name"), field("url")], {
					safe: true,
					safeFields: ["url"],
				}),
			],
		});
		const selection = defaultSelection(diff);

		expect([...selection.added]).toEqual(["GET /vets"]);
		expect(selection.removed.size).toBe(0);
		expect(selection.changed.has("req_0")).toBe(false);
		expect([...(selection.changed.get("req_1") ?? [])]).toEqual(["url"]);
	});

	it("follows the marks even where they disagree with userTouched", () => {
		/*
		 * The mutation check for the move itself. Both entries are marked the
		 * opposite of what the old local derivation would have concluded: a
		 * hand-edited field the engine marked safe, and an untouched one it did
		 * not. Re-deriving from `userTouched` here - the rule this file used to
		 * own - flips both assertions.
		 *
		 * The disagreement is not a state the engine produces; it is how a test
		 * tells "reads the answer" apart from "computes the same answer".
		 */
		const diff = diffOf({
			changed: [
				changed("req_edited", LIST_PETS, [field("name", /* userTouched */ true)], {
					safe: true,
					safeFields: ["name"],
				}),
				changed("req_clean", GET_PET, [field("name")], { safe: false, safeFields: [] }),
			],
		});
		const selection = defaultSelection(diff);

		expect([...(selection.changed.get("req_edited") ?? [])]).toEqual(["name"]);
		expect(selection.changed.has("req_clean")).toBe(false);
	});

	it("ticks a deletion the engine marked safe, so the rule has one author", () => {
		// No document produces this today - `safe_spec_apply` never marks a
		// removal - and that is the point: if the policy ever does, this side
		// follows it instead of hardcoding "never delete" a second time.
		const diff = diffOf({
			removed: [{ requestId: "req_9", name: "Delete a pet", operation: GET_PET, safe: true }],
		});

		expect([...defaultSelection(diff).removed]).toEqual(["req_9"]);
	});

	it("takes a request whose only change is its identity, with no field ticked", () => {
		const diff = diffOf({
			changed: [changed("req_renamed", LIST_PETS, [], { renamed: true })],
		});
		const selection = defaultSelection(diff);

		// Present with an empty set - a real selection rather than an absence,
		// which is what makes the identity write happen.
		expect(selection.changed.has("req_renamed")).toBe(true);
		expect([...(selection.changed.get("req_renamed") ?? [])]).toEqual([]);
	});

	it("is empty when the document changed nothing this collection holds", () => {
		expect(isEmptySelection(defaultSelection(diffOf({ unchanged: 2 })))).toBe(true);
	});
});

describe("buildSyncPayload", () => {
	it("files an added operation in the tag folder that already exists", () => {
		const body = payload(diffOf({ added: [added(GET_PET, "pets")] }));

		expect(body.collections).toEqual([]);
		expect(body.create).toHaveLength(1);
		expect(body.create[0].collectionId).toBe("col_pets");
		expect(body.create[0].specOperation).toEqual(GET_PET);
	});

	it("creates one folder per new tag however many operations name it", () => {
		const body = payload(diffOf({ added: [added(LIST_VETS, "vets"), added(GET_VET, "vets")] }));

		expect(body.collections).toHaveLength(1);
		expect(body.collections[0].name).toBe("vets");
		expect(body.collections[0].parentId).toBe("col_root");
		const temp = body.collections[0].tempId;
		expect(body.create.map((item) => item.collectionTempId)).toEqual([temp, temp]);
		expect(body.create.every((item) => item.collectionId === undefined)).toBe(true);
	});

	it("puts an operation the engine filed nowhere on the bound collection", () => {
		// `folder: ""` is what the engine answers for an operation with no tag
		// whose path names no resource (issues #710, #655) - it imports onto the
		// root, and a sync has to put it in the same place.
		const body = payload(diffOf({ added: [added({ method: "GET", path: "/{id}" }, "")] }));

		expect(body.collections).toEqual([]);
		expect(body.create[0].collectionId).toBe("col_root");
	});

	it("builds an added request the way an import of the same document would", () => {
		// The three constants an OpenAPI import writes for every operation, which
		// the engine's draft omits because they never differ - so they are stated
		// here, and a create that dropped them would reach the engine with no auth
		// mode at all.
		const body = payload(
			diffOf({
				added: [
					added(LIST_VETS, "vets", {
						url: "{{baseUrl}}/vets?limit=10",
						params: [{ key: "limit", value: "10", enabled: true }],
						body: { mode: "json", content: "{}" },
						examples: [
							{
								name: "200 - ok",
								status: 200,
								headers: [
									{
										key: "Content-Type",
										value: "application/json",
										enabled: true,
									},
								],
								body: '{"id":1}',
								contentType: "application/json",
							},
						],
					}),
				],
			})
		);

		const item = body.create[0];
		expect(item.auth).toEqual({ mode: "inherit" });
		expect(item.preRequestScript).toBe("");
		expect(item.postRequestScript).toBe("");
		expect(item.url).toBe("{{baseUrl}}/vets?limit=10");
		expect(item.params).toEqual([{ key: "limit", value: "10", enabled: true }]);
		expect(item.bodyType).toBe("json");
		expect(item.specOperation).toEqual(LIST_VETS);
		// Not the documented responses, though the diff reported them: a sync
		// writes the examples the document it stores documents (issue #869), and
		// a create that stated its own is a 400.
		expect(item).not.toHaveProperty("examples");
	});

	it("never states examples on a created request, documented or not", () => {
		// The engine reads the operation's responses off the document it is
		// storing (issue #869), so there is no key here in either case - and a
		// payload that carried one would be refused rather than half applied.
		const documented = payload(
			diffOf({
				added: [
					added(LIST_VETS, "vets", {
						examples: [
							{
								name: "200 - ok",
								status: 200,
								headers: [],
								body: "{}",
								contentType: "application/json",
							},
						],
					}),
				],
			})
		);
		const silent = payload(diffOf({ added: [added(LIST_VETS, "vets")] }));

		expect(documented.create[0]).not.toHaveProperty("examples");
		expect(silent.create[0]).not.toHaveProperty("examples");
	});

	it("writes only the ticked fields, plus the identity and the examples", () => {
		const diff = diffOf({
			changed: [
				changed("req_0", LIST_PETS, [field("name"), field("url"), field("params")], {
					draft: draft({ name: "Every pet", url: "{{baseUrl}}/pets?limit=50" }),
				}),
			],
		});
		const body = payload(diff, (base) => ({
			...base,
			changed: new Map([["req_0", new Set<SpecField>(["name"])]]),
		}));

		expect(body.update).toHaveLength(1);
		const patch = body.update[0];
		expect(patch.name).toBe("Every pet");
		// `url` and `params` moved too, and were not ticked.
		expect(patch.url).toBeUndefined();
		expect(patch.params).toBeUndefined();
		// The identity always rides along - see the module comment.
		expect(patch.specOperation).toEqual(LIST_PETS);
		// `request.method` does not, since #717: it is a ticked field like `url`,
		// and this selection ticked only `name`.
		expect(patch.method).toBeUndefined();
		// The decision, not the rows (issue #869): every applied change refreshes
		// the request's imported examples from the document being stored, which
		// is what makes an operation whose responses were removed lose the ones
		// the last import wrote.
		expect(patch.examples).toBe(true);
	});

	it("sends a request whose only change is its identity", () => {
		// The document renamed the path under a stable operationId, so nothing
		// about the request's fields moved except the URL - untick it and the
		// identity is the whole of the change, which is still a change to write.
		const diff = diffOf({
			changed: [
				changed(
					"req_0",
					{ operationId: "listPets", method: "GET", path: "/animals" },
					[field("url")],
					{ boundOperation: LIST_PETS, renamed: true }
				),
			],
		});
		const body = payload(diff, (base) => ({
			...base,
			changed: new Map([["req_0", new Set<SpecField>()]]),
		}));

		expect(body.update).toHaveLength(1);
		expect(body.update[0].url).toBeUndefined();
		expect(body.update[0].specOperation?.path).toBe("/animals");
	});

	it("names a removal only once it is ticked, in the diff's own order", () => {
		const diff = diffOf({
			removed: [
				{ requestId: "req_1", name: "List owners", operation: GET_PET, safe: false },
				{ requestId: "req_2", name: "Get an owner", operation: LIST_VETS, safe: false },
			],
		});

		expect(payload(diff).delete).toEqual([]);
		expect(
			payload(diff, (base) => ({ ...base, removed: new Set(["req_2", "req_1"]) })).delete
		).toEqual(["req_1", "req_2"]);
	});

	it("asks for a refresh rather than sending the responses it was shown", () => {
		// The diff reports what an apply would write, so the rows are right there
		// - and sending them back is what let a payload state an example for a
		// response no document describes (issue #869). The engine reads them off
		// the document this sync is storing instead.
		const example = {
			name: "200 - ok",
			status: 200,
			headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
			body: '{"id":1}',
			contentType: "application/json",
		};
		const diff = diffOf({
			changed: [
				changed("req_0", LIST_PETS, [field("name")], {
					draft: draft({ examples: [example] }),
				}),
			],
		});

		const patch = payload(diff).update.find((item) => item.id === "req_0");

		expect(patch?.examples).toBe(true);
	});

	it("keys an added operation the way the checklist does", () => {
		// The UI ticks by `operationKey`, so a payload built from a selection the
		// UI produced depends on the two agreeing.
		const diff = diffOf({ added: [added(LIST_VETS, "vets")] });

		expect(diff.added.map((entry) => operationKey(entry.operation))).toEqual(["GET /vets"]);
		expect(payload(diff, (base) => ({ ...base, added: new Set() })).create).toEqual([]);
	});
});
