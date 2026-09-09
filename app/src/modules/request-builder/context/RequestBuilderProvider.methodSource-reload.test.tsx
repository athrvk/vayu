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
 * `graphql-method.test.ts` proves `switchGraphQLMethod` is correct in
 * isolation - fed a `methodSource` by hand, it reverts `method` from `POST`
 * to `GET`. What it cannot prove is that a `methodSource` a fresh mount was
 * actually seeded with - the shape a reload delivers, through
 * `RequestTransformer.toFrontend` and `index.tsx`'s `initialRequest` mapping -
 * reaches `RequestState` at all (issue #1505's whole point: the old
 * `AutoMethod` ref could not survive exactly this hop).
 *
 * So this file drives the seam the unit test cannot reach: mount the real
 * `RequestBuilderProvider` with `initialRequest` carrying `methodSource`, the
 * way `index.tsx` hands it a freshly fetched request, and make the same two
 * calls `BodyPanel.handleModeChange` makes - `switchGraphQLMethod` then
 * `setRequest` - through the real context, not a hand-built `RequestState`.
 * Mocked down to the same seams `RequestBuilderProvider.name-sync.test.tsx`
 * uses.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { switchGraphQLMethod } from "../components/RequestTabs/panels/body/graphql-method";
import type { BodyMode } from "@/types";
import type { RequestState } from "../types";

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
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

/** Shows what the builder holds, and makes `BodyPanel`'s own two calls. */
function MethodProbe() {
	const { request, setRequest } = useRequestBuilderContext();
	const leaveGraphQL = () => {
		const next = switchGraphQLMethod("none" as BodyMode, request.method, request.methodSource);
		setRequest({ method: next.method, methodSource: next.methodSource });
	};
	return (
		<>
			<span data-testid="method">{request.method}</span>
			<span data-testid="source">{String(request.methodSource)}</span>
			<button onClick={leaveGraphQL}>leave graphql</button>
		</>
	);
}

/**
 * Stands in for what `index.tsx` hands the provider after a fetch -
 * `RequestTransformer.toFrontend`'s output, flattened - which is exactly the
 * shape a reload rebuilds from the engine's stored row rather than from
 * anything held in memory.
 */
function Harness({ initialRequest }: { initialRequest: Partial<RequestState> }) {
	return (
		<RequestBuilderProvider initialRequest={initialRequest} collectionId="col_1">
			<MethodProbe />
		</RequestBuilderProvider>
	);
}

const method = () => screen.getByTestId("method").textContent;
const source = () => screen.getByTestId("source").textContent;

describe("methodSource survives a fresh mount and drives the real provider", () => {
	it("carries a fetched methodSource into RequestState on the first render", () => {
		render(
			<Harness initialRequest={{ id: "req_1", method: "POST", methodSource: "graphql" }} />
		);

		// No BodyPanel mount, no earlier record in this process at all - if this
		// reads back, the marker rode in through `initialRequest` alone, the same
		// path a reload takes.
		expect(method()).toBe("POST");
		expect(source()).toBe("graphql");
	});

	it("reverts the method on leaving GraphQL, from a marker no in-memory record ever held", () => {
		render(
			<Harness initialRequest={{ id: "req_1", method: "POST", methodSource: "graphql" }} />
		);

		act(() => screen.getByText("leave graphql").click());

		expect(method()).toBe("GET");
		expect(source()).toBe("undefined");
	});

	it("does not revert a method the user chose, even one a fresh mount carries no marker for", () => {
		render(<Harness initialRequest={{ id: "req_1", method: "PUT" }} />);

		act(() => screen.getByText("leave graphql").click());

		expect(method()).toBe("PUT");
	});
});
