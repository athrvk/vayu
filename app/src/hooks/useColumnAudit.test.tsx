/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The audit's collecting half (issue #2050). `ColumnAudit.test.tsx` pins the
 * collection path through the Data tab's panel; this pins the explicit-requests
 * path a single-request caller uses, which no panel exercises: the request is
 * audited as drafted, its inherited auth resolved through the chain of the
 * collection it names, and the stored rows are not fetched in its place.
 */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Collection, ElementDef } from "@/types";
import type { ColumnAuditRequest } from "./useColumnAudit";

const collections: Collection[] = [];
const fetchedIds: string[][] = [];

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: collections }),
	useFullCollectionRequests: (ids: string[]) => {
		fetchedIds.push(ids);
		return { requestsByCollection: new Map(), isLoading: ids.length > 0 };
	},
}));

const { useColumnAudit } = await import("./useColumnAudit");

function collection(id: string, overrides: Partial<Collection> = {}): Collection {
	return {
		id,
		name: id,
		description: "",
		order: 0,
		variables: {},
		auth: { mode: "none" },
		elements: [],
		dataSchema: {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as Collection;
}

function draft(url: string, overrides: Partial<ColumnAuditRequest> = {}): ColumnAuditRequest {
	return {
		url,
		params: [],
		headers: [],
		body: { mode: "none" },
		elements: [],
		auth: { mode: "inherit" },
		...overrides,
	};
}

const preScript = (script: string): ElementDef => ({
	id: "el_pre",
	kind: "script.pre",
	enabled: true,
	config: { script },
});

describe("useColumnAudit with explicit requests", () => {
	it("audits the request handed in, under its collection's chain, and fetches nothing", () => {
		collections.length = 0;
		collections.push(
			collection("root", {
				auth: { mode: "basic", username: "{{data.user}}", password: "secret" },
				elements: [preScript('pm.iterationData.get("plan");')],
			}),
			collection("child", { parentId: "root" })
		);
		fetchedIds.length = 0;
		const subject = { collectionId: "child", requests: [draft("https://x/{{data.email}}")] };

		const { result } = renderHook(() => useColumnAudit(subject, ["user", "plan"]));

		expect(result.current.isLoading).toBe(false);
		// `email` from the URL; `user` only through the auth `child` inherits
		// from `root` - mutation check: resolve against no ancestors and `user`
		// falls to unreferenced.
		expect(result.current.audit.undeclared).toEqual(["email"]);
		expect(result.current.audit.referenced).toEqual(["user"]);
		// The root's script runs around this request too.
		expect(result.current.audit.inScripts).toEqual(["plan"]);
		expect(fetchedIds.every((ids) => ids.length === 0)).toBe(true);
	});

	it("audits a request in no collection with nothing inherited", () => {
		collections.length = 0;
		collections.push(collection("root", { auth: { mode: "bearer", token: "{{data.token}}" } }));
		const subject = { collectionId: null, requests: [draft("https://x/{{data.id}}")] };

		const { result } = renderHook(() => useColumnAudit(subject, ["token"]));

		expect(result.current.audit.undeclared).toEqual(["id"]);
		expect(result.current.audit.unreferenced).toEqual(["token"]);
	});
});

describe("useColumnAudit with collection ids", () => {
	it("fetches those collections' stored requests and reports loading until they arrive", () => {
		collections.length = 0;
		fetchedIds.length = 0;
		const ids = ["root"];

		const { result } = renderHook(() => useColumnAudit(ids, ["id"]));

		expect(fetchedIds[fetchedIds.length - 1]).toEqual(["root"]);
		expect(result.current.isLoading).toBe(true);
	});
});
