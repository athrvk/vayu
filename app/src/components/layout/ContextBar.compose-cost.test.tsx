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
 * What the bar actually costs, and actually draws, on a plain REST request.
 *
 * Every other test around the bar stubs the registry to keep its subject narrow,
 * which is right for the frame's behaviour and wrong for this one claim: that
 * opening request tabs with the bar open issues no `POST /compose` at all until
 * someone opens the Code section (#1310). That claim is a property of the *real*
 * registry - which sections there are, which of them ships collapsed, which
 * declares no relevance hook - so a stub section standing in for `code` would
 * prove the mechanism and not the wiring. This file mounts the real thing and
 * spies on the API.
 *
 * The fixture is the issue's own opening scenario: a never-sent REST request, no
 * variables, no cookies for its host. So it pins the other half of that scenario
 * too - which sections a user in that state is actually shown.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContextBar } from "./ContextBar";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore, useTabsStore, useSessionStore } from "@/stores";

const composeRequest = vi.fn();

vi.mock("@/services/api", () => ({
	apiService: {
		composeRequest: (...args: unknown[]) => composeRequest(...args),
	},
}));

/*
 * The open request is whatever id the tab carries, so switching tabs switches
 * the request without a fixture to keep in step - a plain REST request nobody
 * has sent, in every case.
 */
vi.mock("@/queries", () => ({
	useRequestQuery: (id: string | null) => ({
		data: id
			? {
					id,
					collectionId: "col_1",
					method: "GET",
					url: "https://api.example.com/v1/users",
					bodyType: "json",
					body: { mode: "none" },
					params: [],
					headers: [],
					auth: { mode: "none" },
					preRequestScript: "",
					postRequestScript: "",
				}
			: undefined,
		isLoading: false,
	}),
	useCollectionAncestors: () => [],
	// Never sent: the section reports "not sent yet" and never mounts.
	useRecentDesignRunsQuery: () => ({ data: { data: [] }, isLoading: false }),
}));

vi.mock("@/queries/cookies", () => ({
	// A host with an empty jar - the issue's "no cookies on its host".
	useCookiesQuery: () => ({
		data: { scopes: [{ environmentId: "env_1", cookies: [] }] },
		isLoading: false,
	}),
	useClearCookiesMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({
		getVariable: () => null,
		getAllVariables: () => ({}),
		resolveString: (s: string) => s,
		resolveObject: <T,>(o: T) => o,
	}),
}));

function renderBar() {
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<TooltipProvider>
				<ContextBar />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** Open a request tab, the way switching tabs reaches the bar. */
function openRequestTab(id: string) {
	useTabsStore.setState({
		openTabs: [{ id: `tab_${id}`, type: "request", entityId: id }],
		activeTabId: `tab_${id}`,
	});
}

beforeEach(() => {
	composeRequest.mockReset();
	composeRequest.mockResolvedValue({
		method: "GET",
		url: "https://api.example.com/v1/users",
		headers: {},
		body: { mode: "none" },
		auth: { mode: "none" },
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	// The state a user who has never touched the bar has, taken from the store
	// rather than written out here - that is the thing under test.
	useLayoutStore.setState({
		contextBarOpen: true,
		contextBarCollapsedSections: [
			...useLayoutStore.getInitialState().contextBarCollapsedSections,
		],
	});
	openRequestTab("req_1");
});

describe("ContextBar - what a plain REST request costs", () => {
	it("opens five request tabs without composing anything", () => {
		const { rerender } = renderBar();

		for (const id of ["req_2", "req_3", "req_4", "req_5"]) {
			openRequestTab(id);
			rerender(
				<QueryClientProvider
					client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
				>
					<TooltipProvider>
						<ContextBar />
					</TooltipProvider>
				</QueryClientProvider>
			);
		}

		// The defect this closes: Code mounted on every request tab and composed
		// a snippet over the network before anyone had asked to see one.
		expect(composeRequest).not.toHaveBeenCalled();
	});

	it("composes once, when the user opens Code", async () => {
		renderBar();
		expect(composeRequest).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Code" }));

		await waitFor(() => expect(composeRequest).toHaveBeenCalledTimes(1));
		// And the expansion is the user's now, so it outlives the default.
		expect(useLayoutStore.getState().contextBarCollapsedSections).not.toContain("code");
	});
});

describe("ContextBar - what a plain REST request shows", () => {
	it("expands Auth, collapses Code, and quiets the rest", () => {
		renderBar();

		// Expandable, and open: the section with something to say.
		expect(screen.getByRole("button", { name: "Auth" })).toHaveAttribute(
			"aria-expanded",
			"true"
		);
		// Expandable, and closed.
		expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute(
			"aria-expanded",
			"false"
		);

		// Present as dimmed headers, with no way in - there is nothing to expand.
		for (const title of ["Variables used", "Cookies for this host", "Recent sends"]) {
			expect(screen.getByText(title)).toBeInTheDocument();
			expect(screen.queryByRole("button", { name: title })).not.toBeInTheDocument();
		}
		expect(screen.getAllByText("none")).toHaveLength(2);
		expect(screen.getByText("not sent yet")).toBeInTheDocument();
	});

	it("leaves out GraphQL entirely, rather than saying it does not apply", () => {
		renderBar();

		// Absent, not a header reading "This request does not send a GraphQL
		// body" - and so its ~320KB chunk (#1146) is never even requested.
		expect(screen.queryByText("GraphQL")).not.toBeInTheDocument();
	});
});
