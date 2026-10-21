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
 * The audit reads what each stored request sends, through the real query
 * hooks rather than a stub of them (`useColumnAudit.test.tsx` stubs them). The
 * tree's cached rows are summaries (#2546), which carry no URL params,
 * headers, body, auth or scripts - an audit over them finds nothing and calls
 * every declared column unreferenced.
 */

import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { useColumnAudit } from "./useColumnAudit";
import type { Collection, Request, RequestSummary } from "@/types";

const root = {
	id: "root",
	name: "Checkout",
	order: 0,
	auth: { mode: "none" },
	elements: [],
} as unknown as Collection;

const summary: RequestSummary = {
	id: "r-1",
	collectionId: "root",
	name: "Charge",
	method: "POST",
	url: "https://api.example.com/charge",
	order: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
};

const stored = {
	...summary,
	params: [],
	headers: [{ key: "X-Plan", value: "{{data.plan}}", enabled: true }],
	body: { mode: "json", content: '{"email":"{{data.email}}"}' },
	auth: { mode: "inherit" },
	elements: [],
} as unknown as Request;

const listRequests = vi.fn(async () => [stored]);
const listRequestSummaries = vi.fn(async () => [summary]);

vi.mock("@/services/api", () => ({
	apiService: {
		listCollections: async () => [root],
		listRequests: () => listRequests(),
		listRequestSummaries: () => listRequestSummaries(),
	},
}));

describe("useColumnAudit over stored requests", () => {
	it("audits the whole rows, finding columns a summary does not carry", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		);
		const subject = ["root"];
		const columns = ["plan", "email"];

		const { result } = renderHook(() => useColumnAudit(subject, columns), { wrapper });
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		// Mutation check: read the tree's `useMultipleCollectionRequests` here and
		// both columns fall to unreferenced.
		await waitFor(() => expect(result.current.audit.referenced).toEqual(["plan", "email"]));
		expect(listRequests).toHaveBeenCalled();
	});
});
