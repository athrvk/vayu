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

function collection(
	id: string,
	parentId?: string,
	columns?: string[],
	overrides: Partial<Collection> = {}
): Collection {
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
		...overrides,
	} as Collection;
}

function request(url: string, overrides: Partial<Request> = {}): Request {
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
		verifySSL: true,
		httpVersion: "auto",
		stream: false,
		order: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
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

/*
 * What a request *sends* rather than what it holds (issue #729).
 *
 * Two surfaces the audit used to read off the stored row, while a run resolves
 * both through the collection chain: the auth an `inherit` request presents,
 * and the scripts the chain runs around every step. Each miss printed "declared
 * but not referenced" beside a column every iteration binds.
 */
describe("what the run actually resolves", () => {
	it("counts the columns bound into auth a request inherits", () => {
		// The #591 flagship: the credentials live on the collection, the requests
		// inherit, and a row supplies the pair per iteration.
		const root = collection("root", undefined, ["user", "password"], {
			auth: { mode: "basic", username: "{{data.user}}", password: "{{data.password}}" },
		});
		setTree([root], { root: [request("https://x/users")] });

		render(<ColumnAudit collection={root} />);

		expect(bucket("Declared and referenced")).toEqual(["user", "password"]);
		expect(bucket("Declared but not referenced")).toEqual([]);
	});

	it("counts the credentials a request configures for itself", () => {
		const root = collection("root", undefined, ["token"]);
		setTree([root], {
			root: [
				request("https://x/users", {
					auth: { mode: "bearer", token: "{{data.token}}" },
				}),
			],
		});

		render(<ColumnAudit collection={root} />);

		expect(bucket("Declared and referenced")).toEqual(["token"]);
	});

	it("leaves a column alone when an ancestor's script is the only thing naming it", () => {
		// The chain's scripts run for every step, so a `get("plan")` written once
		// on a parent is evidence - best-effort evidence, so it moves the verdict
		// only in the direction that does not get a working column deleted.
		const root = collection("root", undefined, ["plan"], {
			preRequestScript: 'pm.iterationData.get("plan");',
		});
		setTree([root, collection("child", "root")], { root: [], child: [request("https://x/a")] });

		render(<ColumnAudit collection={root} />);

		expect(bucket("Declared but not referenced")).toEqual([]);
		expect(screen.getByText(/Scripts also name plan/)).toBeTruthy();
	});

	it("does not count a token in an inherited OAuth 2.0 config", () => {
		// Refused at plan time rather than bound - the panel must not promise it.
		const root = collection("root", undefined, ["clientId"], {
			auth: {
				mode: "oauth2",
				config: {
					grantType: "client_credentials",
					accessTokenUrl: "https://auth.example.com/token",
					clientId: "{{data.clientId}}",
				},
			},
		});
		setTree([root], { root: [request("https://x/users")] });

		render(<ColumnAudit collection={root} />);

		expect(bucket("Declared but not referenced")).toEqual(["clientId"]);
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
