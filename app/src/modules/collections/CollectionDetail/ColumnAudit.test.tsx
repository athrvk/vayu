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
 * The Data tab's referenced-columns panel (issue #600).
 *
 * `auditDataColumns` has its own suite for the bucketing; what is pinned here
 * is the part only the component knows - **which requests are audited**. The
 * chain rule says a contract binds every request beneath it, so a column
 * referenced one level down is referenced, and a sub-collection that declares
 * its own contract answers for itself. Getting that wrong prints "declared but
 * not referenced" beside a column a run binds on every iteration, which is the
 * reading that gets a working column deleted.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Collection, Request } from "@/types";

const collections: Collection[] = [];
const requestsByCollection = new Map<string, Request[]>();

vi.mock("@/queries", () => ({
	useCollectionsQuery: () => ({ data: collections }),
	useMultipleCollectionRequests: (ids: string[]) => ({
		// Mirrors the real hook: one entry per requested id, empty where the
		// collection holds nothing.
		requestsByCollection: new Map(ids.map((id) => [id, requestsByCollection.get(id) ?? []])),
		isLoading: false,
	}),
}));

const { default: ColumnAudit } = await import("./ColumnAudit");

function collection(id: string, parentId?: string, columns?: string[]): Collection {
	return {
		id,
		name: `Collection ${id}`,
		description: "",
		parentId,
		order: 0,
		variables: {},
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
		dataSchema: columns ? { columns } : {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	} as Collection;
}

function request(url: string): Request {
	return {
		id: `req_${url}`,
		collectionId: "",
		name: "req",
		description: "",
		method: "GET",
		url,
		params: [],
		headers: [],
		body: { mode: "none" },
		bodyType: "none",
		auth: { mode: "inherit" },
		preRequestScript: "",
		postRequestScript: "",
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		stream: false,
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	} as Request;
}

function setTree(rows: Collection[], requests: Record<string, Request[]>) {
	collections.length = 0;
	collections.push(...rows);
	requestsByCollection.clear();
	for (const [id, list] of Object.entries(requests)) requestsByCollection.set(id, list);
}

/** The chips under a bucket heading, in order. */
function bucket(label: string): string[] {
	const heading = screen.queryByText(label);
	if (!heading) return [];
	const chips = heading.parentElement?.querySelectorAll("code") ?? [];
	return [...chips].map((chip) => chip.textContent ?? "");
}

describe("which requests the audit reads", () => {
	it("counts a reference from a sub-collection that declares nothing of its own", () => {
		setTree([collection("root", undefined, ["id", "email"]), collection("child", "root")], {
			root: [request("https://x/{{data.id}}")],
			child: [request("https://x/{{data.email}}")],
		});

		render(<ColumnAudit collection={collection("root", undefined, ["id", "email"])} />);

		expect(bucket("Declared and referenced")).toEqual(["id", "email"]);
		expect(bucket("Declared but not referenced")).toEqual([]);
	});

	it("stops at a sub-collection that declares its own contract", () => {
		// `owner` answers for its own requests now, so a token in one of them is
		// not evidence about the root's contract.
		setTree(
			[
				collection("root", undefined, ["id", "email"]),
				collection("owner", "root", ["email"]),
			],
			{
				root: [request("https://x/{{data.id}}")],
				owner: [request("https://x/{{data.email}}")],
			}
		);

		render(<ColumnAudit collection={collection("root", undefined, ["id", "email"])} />);

		expect(bucket("Declared and referenced")).toEqual(["id"]);
		expect(bucket("Declared but not referenced")).toEqual(["email"]);
	});
});

describe("what the panel says", () => {
	it("warns about a column the requests reference and the contract does not declare", () => {
		setTree([collection("root", undefined, ["email"])], {
			root: [request("https://x/{{data.emial}}")],
		});

		render(<ColumnAudit collection={collection("root", undefined, ["email"])} />);

		expect(bucket("Referenced but not declared")).toEqual(["emial"]);
		expect(screen.getByText(/Nothing will bind these/)).toBeTruthy();
	});

	it("labels the script scan as best-effort, always", () => {
		// The claim the panel must never make is that it knows what a script
		// reads: `pm.iterationData.get(key)` is unanswerable at authoring time.
		setTree([collection("root", undefined, ["email"])], { root: [] });

		render(<ColumnAudit collection={collection("root", undefined, ["email"])} />);

		expect(screen.getByText(/best-effort/)).toBeTruthy();
	});
});
