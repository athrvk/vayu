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
 * What the request-tab variables section leads with (#1308): the variables this
 * request references, resolved or not, with the full in-scope set one disclosure
 * away rather than dumped inline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VariablesSection } from "./VariablesSection";
import { TooltipProvider } from "@/components/ui";
import { queryKeys } from "@/queries/keys";
import type { ResolvedVariable } from "@/types";

/** The request the bar reads - only its templated fields matter here. */
let requestUrl = "";

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({
		data: {
			id: "req_1",
			collectionId: "col_1",
			url: requestUrl,
			params: [],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
			preRequestScript: "",
			postRequestScript: "",
		},
	}),
	useCollectionAncestors: () => [],
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
}));

/** Everything in scope for this render. `getVariable` answers from the same map. */
let inScope: Record<string, ResolvedVariable> = {};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({
		getAllVariables: () => inScope,
		getVariable: (name: string) => inScope[name] ?? null,
	}),
}));

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(queryKeys.globals.all, { id: "globals", updatedAt: "", variables: {} });
	client.setQueryData(queryKeys.environments.list(), []);
	client.setQueryData(queryKeys.collections.list(), []);
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<VariablesSection tab={TAB} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	requestUrl = "";
	inScope = {};
});

describe("VariablesSection - references, resolved and not", () => {
	it("leads with the referenced names and hides the rest behind a disclosure", () => {
		inScope = {
			host: { value: "example.com", scope: "global" },
			base: { value: "/v1", scope: "collection", sourceId: "col_1" },
			token: { value: "t", scope: "environment", sourceId: "env_1" },
		};
		// References one defined name and one nothing defines.
		requestUrl = "https://{{host}}/{{missing}}";
		renderSection();

		// The resolved reference, with its scope badge and an editable value.
		expect(screen.getByRole("textbox", { name: "Value of host" })).toHaveValue("example.com");
		expect(screen.getByText("G")).toBeInTheDocument();

		// The undefined reference: marked, and with no input to commit to.
		expect(screen.getByText("missing")).toBeInTheDocument();
		expect(screen.getByText("not defined")).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Value of missing" })).toBeNull();

		// Everything else in scope is a count, collapsed - not `host` (already shown),
		// so `base` and `token`. Their rows are not mounted until it is expanded.
		expect(screen.getByText("All in scope (2)")).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Value of base" })).toBeNull();

		fireEvent.click(screen.getByText("All in scope (2)"));
		expect(screen.getByRole("textbox", { name: "Value of base" })).toHaveValue("/v1");
		expect(screen.getByRole("textbox", { name: "Value of token" })).toHaveValue("t");
	});

	it("says the request uses none, and keeps the full list a disclosure away", () => {
		inScope = {
			host: { value: "example.com", scope: "global" },
			token: { value: "t", scope: "environment", sourceId: "env_1" },
		};
		requestUrl = "https://example.com/no-tokens";
		renderSection();

		expect(screen.getByText("This request uses no variables")).toBeInTheDocument();
		// Not dumped inline: the two in-scope names are behind the collapsed count.
		expect(screen.getByText("All in scope (2)")).toBeInTheDocument();
		expect(screen.queryByRole("textbox", { name: "Value of host" })).toBeNull();
	});

	it("says nothing is in scope when there are no references and no definitions", () => {
		requestUrl = "https://example.com";
		renderSection();
		expect(screen.getByText("No variables in scope")).toBeInTheDocument();
		expect(screen.queryByText(/All in scope/)).toBeNull();
	});
});
