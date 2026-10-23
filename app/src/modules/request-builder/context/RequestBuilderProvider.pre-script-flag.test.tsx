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
 * The saved request's `runsPreRequestScript` (#2741) is a provider prop beside
 * the draft, not a field of it: the draft is what the user edits and saves, the
 * flag is the engine's derived answer. This pins the prop reaching the context
 * the Params panel reads, and the draft staying free of it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";

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

vi.mock("@/queries", () => ({
	// RequestBuilderProvider now reads the catalogue itself (issue #1635); an
	// empty list means "nothing required", so the save-skip check is inert.
	useElementKindsQuery: () => ({ data: [] }),
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

function Probe() {
	const { runsPreRequestScript, request } = useRequestBuilderContext();
	return (
		<>
			<span data-testid="flag">{String(runsPreRequestScript)}</span>
			<span data-testid="in-draft">{String("runsPreRequestScript" in request)}</span>
		</>
	);
}

function renderWith(runsPreRequestScript: boolean | undefined) {
	render(
		<RequestBuilderProvider
			initialRequest={{ id: "req_1" }}
			collectionId="col_1"
			runsPreRequestScript={runsPreRequestScript}
		>
			<Probe />
		</RequestBuilderProvider>
	);
	return screen.getByTestId("flag").textContent;
}

describe("runsPreRequestScript through the provider", () => {
	it.each([[true], [false], [undefined]])("hands %s to the context unchanged", (flag) => {
		expect(renderWith(flag)).toBe(String(flag));
	});

	it("keeps it out of the editable draft", () => {
		renderWith(true);
		expect(screen.getByTestId("in-draft").textContent).toBe("false");
	});
});
