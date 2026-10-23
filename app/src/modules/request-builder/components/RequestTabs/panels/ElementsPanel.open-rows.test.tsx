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
 * Which element rows are expanded on a request's Elements tab, kept per
 * request id in `tab-selection-store`.
 *
 * Rows used to hold their own `useState`, so `Shell` unmounting the builder
 * (any non-request tab) and a swap between two open request tabs (same
 * provider instance, `request.elements` replaced) both closed every row. The
 * shape is `RequestBuilderProvider.tab-persistence.test.tsx`'s: the real
 * provider, mocked down to the seams that have nothing to do with disclosure.
 *
 * Mutation check: drop `{...openRows}` from `ElementsPanel`'s `<ElementList>`
 * and the remount and swap cases fail red (the unmount probe from the issue);
 * drop `useOpenElementRows`' `openIds` and the same two fail. The no-id case
 * guards the opposite edge: returning props for a null id would write under
 * a `null` key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TestQueryClient } from "@/test/TestQueryClient";
import { render, screen, fireEvent } from "@testing-library/react";
import RequestBuilderProvider from "../../../context/RequestBuilderProvider";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import type { ElementDef, ElementKindSchema } from "@/types";
import type { RequestState } from "../../../types";
import ElementsPanel from "./ElementsPanel";

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

const EXTRACT_KIND: ElementKindSchema = {
	kind: "extract.json",
	version: 1,
	label: "Extract JSON",
	description: "Extract JSON description",
	category: "extract",
	hotPathClass: "declarative",
	collectionOnly: false,
	configSchema: {
		type: "object",
		properties: { path: { type: "string", title: "JSONPath" } },
	},
	phases: [],
};

vi.mock("@/queries", () => ({
	useElementKindsQuery: () => ({ data: [EXTRACT_KIND] }),
	useRequestQuery: () => ({ data: undefined }),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

vi.mock("@/queries/collections", () => ({
	useCollectionAncestors: () => [],
}));

const extractElement = (id: string): ElementDef => ({
	id,
	kind: "extract.json",
	enabled: true,
	config: { path: "" },
});

/** Both requests carry an element with the same id, to prove the set is per request. */
function Harness({ id }: { id: string | null }) {
	const initialRequest: Partial<RequestState> = { id, elements: [extractElement("el_shared")] };
	return (
		<TestQueryClient>
			<RequestBuilderProvider initialRequest={initialRequest} collectionId="col_1">
				<ElementsPanel />
			</RequestBuilderProvider>
		</TestQueryClient>
	);
}

const toggle = () => screen.getByRole("button", { name: /^(Expand|Collapse) Extract JSON$/ });
const expand = () => fireEvent.click(screen.getByRole("button", { name: "Expand Extract JSON" }));
const isExpanded = () => toggle().getAttribute("aria-expanded") === "true";

beforeEach(() => {
	useTabSelectionStore.getState().clearAll();
});

describe("expanded element rows, kept per request id", () => {
	it("shows every row collapsed for a request seen for the first time", () => {
		render(<Harness id="req_a" />);

		expect(isExpanded()).toBe(false);
		expect(screen.queryByLabelText("JSONPath")).not.toBeInTheDocument();
	});

	it("survives Shell unmounting and remounting the builder for the same request", () => {
		const { unmount } = render(<Harness id="req_a" />);
		expand();
		expect(isExpanded()).toBe(true);

		unmount();
		render(<Harness id="req_a" />);

		expect(isExpanded()).toBe(true);
		expect(screen.getByLabelText("JSONPath")).toBeInTheDocument();
	});

	it("keeps a collapse too: a row closed before switching away is still closed", () => {
		const { unmount } = render(<Harness id="req_a" />);
		expand();
		fireEvent.click(screen.getByRole("button", { name: "Collapse Extract JSON" }));

		unmount();
		render(<Harness id="req_a" />);

		expect(isExpanded()).toBe(false);
	});

	it("keeps each request's rows separate across a swap that reuses the provider", () => {
		const { rerender } = render(<Harness id="req_a" />);
		expand();

		// req_b has a row with the very same element id; req_a's set must not open it.
		rerender(<Harness id="req_b" />);
		expect(isExpanded()).toBe(false);

		rerender(<Harness id="req_a" />);
		expect(isExpanded()).toBe(true);
	});

	it("takes the local path for a request with no id, writing nothing to the store", () => {
		render(<Harness id={null} />);

		expand();

		expect(isExpanded()).toBe(true);
		expect(useTabSelectionStore.getState().openElementRows.size).toBe(0);
	});
});
