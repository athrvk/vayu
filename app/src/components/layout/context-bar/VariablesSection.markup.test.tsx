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
 * What a variable row *is* on screen, as opposed to where its edits land
 * (`VariablesSection.commit-scope.test.tsx`).
 *
 * Each case pins a defect the row shipped with: unnamed value inputs, and a
 * scope visible only in a mouse-only `title`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VariablesSection } from "./VariablesSection";
import { queryKeys } from "@/queries/keys";
import type { ResolvedVariable } from "@/types";

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: { id: "req_1", collectionId: "col_1" } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
}));

let resolved: Record<string, ResolvedVariable> = {};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => resolved }),
}));

const TAB = { id: "t1", type: "request", entityId: "req_1" } as const;

function renderSection() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(queryKeys.globals.all, { id: "globals", updatedAt: "", variables: {} });
	client.setQueryData(queryKeys.environments.list(), []);
	client.setQueryData(queryKeys.collections.list(), []);
	return render(
		<QueryClientProvider client={client}>
			<VariablesSection tab={TAB} />
		</QueryClientProvider>
	);
}

beforeEach(() => {
	resolved = {};
});

describe("VariablesSection - naming what a screen reader reads", () => {
	it("names the editable value input after the variable it edits", () => {
		resolved = { host: { value: "example.com", scope: "global" } };
		renderSection();

		// Was an unnamed textbox: "textbox, blank", with a blur that silently
		// persisted the edit.
		expect(screen.getByRole("textbox", { name: "Value of host" })).toHaveValue("example.com");
	});

	it("names the masked input of a secret the same way", () => {
		resolved = { apiKey: { value: "s3cret", scope: "collection", secret: true } };
		renderSection();

		const input = screen.getByRole("textbox", { name: "Value of apiKey" });
		expect(input).toHaveAttribute("readonly");
		expect(input).toHaveValue("••••••");
		expect(screen.queryByDisplayValue("s3cret")).not.toBeInTheDocument();
	});
});

describe("VariablesSection - the scope is visible, not hover-only", () => {
	it("badges each row with the scope the winner came from", () => {
		resolved = {
			host: { value: "example.com", scope: "global" },
			base: { value: "/v1", scope: "collection", sourceId: "col_1" },
			token: { value: "t", scope: "environment", sourceId: "env_1" },
		};
		renderSection();

		// The compact letters `VariableScopeBadge` renders - the primitive the
		// variable popover already uses, rather than a hand-rolled copy.
		expect(screen.getByText("G")).toBeInTheDocument();
		expect(screen.getByText("C")).toBeInTheDocument();
		expect(screen.getByText("E")).toBeInTheDocument();
	});

	it("does not hand-write an unconditional title on the name", () => {
		resolved = { host: { value: "example.com", scope: "global" } };
		renderSection();

		// `TruncatedText` supplies the title only while the text is clipped -
		// jsdom never clips, so a title here means the old `truncate` + literal
		// `title` pattern came back.
		const name = screen.getByText("host");
		expect(name.className).toContain("truncate");
		expect(name).not.toHaveAttribute("title");
	});

	it("says so when nothing is in scope", () => {
		renderSection();
		expect(screen.getByText("No variables in scope")).toBeInTheDocument();
	});
});
