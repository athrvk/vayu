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
 * The builder's copy of the request name has to follow the stored one.
 *
 * This is the half that lets the Info tab rename at all. The provider resets
 * only when the request *id* changes, and a rename does not change the id - so
 * the name it held was a snapshot taken when the tab opened. That is why the
 * save payload omitted `name` for as long as it did: an edit made minutes after
 * a sidebar rename fired a debounced auto-save carrying the pre-rename name and
 * put it back.
 *
 * Adoption removes the staleness rather than working around it, so the payload
 * can carry the name again (`save-request-name.test.ts` guards that end). Three
 * things have to hold at once, and each of them is a way the naive version
 * fails:
 *
 *   - a name that changes under us is picked up **without** an id change;
 *   - a name the user is typing is **not** overwritten while it changes;
 *   - adopting is not an edit, so it must not mark the request dirty - a save
 *     scheduled by adoption would write back what it just read, on every
 *     rename, from every open tab.
 *
 * The provider is mocked down to the same seams `body-drafts-lifetime.test.tsx`
 * uses: none of variable resolution, the save manager or the query hooks has
 * anything to do with which string the name field holds.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
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
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	// The provider reads the engine data caps for Send-with-row's row cap
	// (`useDataFileLimits`); empty entries leave it on the seeds.
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

/** Shows what the builder holds, and offers the two writes the Info tab makes. */
function NameProbe() {
	const { request, updateField, restoreStoredName, hasUnsavedChanges } =
		useRequestBuilderContext();
	return (
		<>
			<span data-testid="name">{request.name}</span>
			<span data-testid="dirty">{String(hasUnsavedChanges)}</span>
			<button onClick={() => updateField("name", "typed locally")}>type</button>
			<button onClick={restoreStoredName}>restore</button>
		</>
	);
}

/**
 * Stands in for the request query delivering a name for the *same* request. The
 * id never changes, which is the whole point - a changing id would take the
 * reset path and prove nothing about adoption.
 */
function Harness({ storedName }: { storedName: string }) {
	const initialRequest: Partial<RequestState> = { id: "req_1", name: storedName };
	return (
		<RequestBuilderProvider initialRequest={initialRequest} collectionId="col_1">
			<NameProbe />
		</RequestBuilderProvider>
	);
}

/** Mount, and get back a "the stored name just changed" driver. */
function mount(storedName: string) {
	const { rerender } = render(<Harness storedName={storedName} />);
	return (next: string) => act(() => rerender(<Harness storedName={next} />));
}

const shown = () => screen.getByTestId("name").textContent;
const dirty = () => screen.getByTestId("dirty").textContent;
const click = (label: string) => act(() => screen.getByText(label).click());

describe("the builder adopts a request name that changes underneath it", () => {
	it("picks up a rename that arrives without an id change", () => {
		const storedNameChanges = mount("Old name");
		expect(shown()).toBe("Old name");

		// A sidebar rename: the mutation writes the detail cache, the query hands
		// the provider a new name, the id is untouched.
		storedNameChanges("Renamed elsewhere");

		expect(shown()).toBe("Renamed elsewhere");
	});

	it("does not call that adoption an unsaved change", () => {
		const storedNameChanges = mount("Old name");
		storedNameChanges("Renamed elsewhere");

		// `setRequest` would flip this, and the debounced auto-save would then
		// write the adopted name straight back to the engine.
		expect(dirty()).toBe("false");
	});

	it("leaves a name being typed alone", () => {
		const storedNameChanges = mount("Old name");
		click("type");
		expect(shown()).toBe("typed locally");
		expect(dirty()).toBe("true");

		// A re-render with the same stored name must not reach in and undo it.
		storedNameChanges("Old name");

		expect(shown()).toBe("typed locally");
	});

	it("hands the stored name back when an edit is refused", () => {
		mount("Old name");
		click("type");
		expect(shown()).toBe("typed locally");

		click("restore");

		expect(shown()).toBe("Old name");
	});

	it("restores the newest stored name, not the one the tab opened with", () => {
		// The two writes racing is the case a captured-at-mount copy gets wrong:
		// restore has to undo the local edit against what is stored *now*.
		const storedNameChanges = mount("Old name");
		storedNameChanges("Renamed elsewhere");
		click("type");

		click("restore");

		expect(shown()).toBe("Renamed elsewhere");
	});
});
