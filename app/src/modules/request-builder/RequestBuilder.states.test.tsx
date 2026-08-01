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
 * A failed request lookup has two meanings, and the pane has to tell them
 * apart.
 *
 * `useRequestQuery` hits `GET /requests/:id`, which throws the
 * `RequestNotFoundError` sentinel for a genuine deletion and something else for
 * every transport failure. Both used to render "This request no longer exists"
 * with a Try again - so an engine that had not come up yet told the user their
 * request was deleted, and invited them to close a tab they would want back.
 *
 * The discrimination is by type, never by message, so the real `isRequestNotFound`
 * is used here rather than a stubbed predicate: a stub would assert nothing
 * about the distinction this pane exists to make.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore } from "@/stores";

const requestQuery = {
	data: undefined as unknown,
	isLoading: false,
	isError: false,
	error: null as unknown,
	refetch: vi.fn(),
};

vi.mock("@/queries", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/queries")>();
	return {
		...actual,
		useRequestQuery: () => requestQuery,
		useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn() }),
		useCollectionAncestors: () => [],
	};
});

// The builder itself renders Monaco and the whole response tree; the question
// here is only which pane it chooses when the lookup failed.
vi.mock("./components/RequestBuilderLayout", () => ({
	default: () => <div data-testid="builder-layout" />,
}));

const { RequestNotFoundError } = await import("@/queries");
const { default: RequestBuilder } = await import("./index");

/** The pane calls `useQueryClient()` before it ever reaches an error branch. */
function renderPane() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<RequestBuilder />, { wrapper });
}

beforeEach(() => {
	requestQuery.data = undefined;
	requestQuery.isLoading = false;
	requestQuery.isError = true;
	requestQuery.refetch = vi.fn();
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "r1", title: "Req" } as never],
		activeTabId: "t1",
	});
});

describe("the request lookup failed", () => {
	it("says the request is gone - and offers no retry - for a real 404", () => {
		requestQuery.error = new RequestNotFoundError("r1");

		renderPane();

		expect(screen.getByText(/no longer exists/i)).toBeTruthy();
		// A 404 can only 404 again, so a Try again here is a dead end dressed up
		// as a way out.
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
		expect(screen.getByRole("button", { name: /close tab/i })).toBeTruthy();
	});

	it("says the load failed - and offers a retry - for a transport failure", () => {
		requestQuery.error = new Error("Network error: fetch failed");

		renderPane();

		// The request is probably fine; only the lookup failed. Claiming it was
		// deleted here is the lie this branch exists to stop.
		expect(screen.getByText(/couldn't load this request/i)).toBeTruthy();
		expect(screen.queryByText(/no longer exists/i)).toBeNull();

		const retry = screen.getByRole("button", { name: /try again/i });
		retry.click();
		expect(requestQuery.refetch).toHaveBeenCalled();
	});

	it("treats a settled-but-empty lookup as gone, not as a failure", () => {
		// `isError` false with no data: nothing errored, the row simply is not
		// there. Same conclusion as the sentinel, and it must not fall through to
		// the transport pane.
		requestQuery.isError = false;
		requestQuery.error = null;

		renderPane();

		expect(screen.getByText(/no longer exists/i)).toBeTruthy();
	});
});
