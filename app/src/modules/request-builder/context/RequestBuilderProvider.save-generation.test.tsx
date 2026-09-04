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
 * A save only gets to call the request clean if it carried every edit
 * (issue #1381).
 *
 * `onSave(request)` serialises the state as it was when the save started, and
 * the engine round trip is tens of milliseconds - a window a script editor
 * lands keystrokes in constantly. Clearing `hasUnsavedChanges` when that
 * promise resolved marked those keystrokes saved: the payload never held them,
 * nothing was left dirty, so `useSaveManager` never re-armed, and the Dock said
 * "Saved" over an edit that was gone on the next open.
 *
 * The provider therefore stamps every edit with a generation and clears the
 * flag only for the generation it actually sent. The mocked save manager here
 * is the seam: it hands back the options it was given, so a test can drive
 * `onSave` by hand and read the `hasChanges` / `changeToken` the hook would
 * have debounced on. That the hook then re-arms on those values is
 * `useSaveManager.debounce.test.tsx`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import type { RequestState } from "../types";

/** The options the provider handed the save manager on the last render. */
let managerOptions: { onSave: () => Promise<void>; hasChanges: boolean; changeToken: number };

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		resolveObject: (o: unknown) => o,
		getVariable: () => null,
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
	}),
	useSaveManager: (options: {
		onSave: () => Promise<void>;
		hasChanges: boolean;
		changeToken: number;
	}) => {
		managerOptions = options;
		return { forceSave: vi.fn(), status: "idle", isSaving: false };
	},
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
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

/** Reads the dirty flag and offers the one edit the cases make. */
function ScriptProbe() {
	const { request, updateField, hasUnsavedChanges } = useRequestBuilderContext();
	return (
		<>
			<span data-testid="script">{request.testScript}</span>
			<span data-testid="dirty">{String(hasUnsavedChanges)}</span>
			<button onClick={() => updateField("testScript", "first")}>type first</button>
			<button onClick={() => updateField("testScript", "second")}>type second</button>
		</>
	);
}

/** A save the test holds open, so an edit can land while it is in flight. */
function heldSave() {
	const sent: RequestState[] = [];
	let release!: () => void;
	let pending = new Promise<void>((r) => {
		release = r;
	});
	const onSave = vi.fn((request: RequestState) => {
		sent.push(request);
		return pending;
	});
	return {
		onSave,
		sent,
		/** Let the in-flight save land, and arm the next one. */
		finish: async () => {
			const done = release;
			pending = new Promise<void>((r) => {
				release = r;
			});
			await act(async () => {
				done();
			});
		},
	};
}

const dirty = () => screen.getByTestId("dirty").textContent;
const click = (label: string) => act(() => screen.getByText(label).click());
const save = () => act(() => void managerOptions.onSave());

describe("a save that raced an edit", () => {
	let saves: ReturnType<typeof heldSave>;
	const harness = () => saves;

	beforeEach(() => {
		const initialRequest: Partial<RequestState> = { id: "req_1", name: "Req" };
		saves = heldSave();
		render(
			<RequestBuilderProvider
				initialRequest={initialRequest}
				collectionId="col_1"
				onSave={saves.onSave}
			>
				<ScriptProbe />
			</RequestBuilderProvider>
		);
	});

	it("leaves the request dirty, so the next save is still scheduled", async () => {
		click("type first");
		expect(dirty()).toBe("true");

		save();
		// The keystroke the flying payload does not carry.
		click("type second");

		await harness().finish();

		expect(dirty()).toBe("true");
		expect(managerOptions.hasChanges).toBe(true);
	});

	it("sends the newer state on the save that follows", async () => {
		click("type first");
		save();
		click("type second");
		await harness().finish();

		// The save manager only issues this one because the request is still
		// marked dirty; asserting the flag here is what ties the payload below
		// to the generation check rather than to the test calling `onSave`.
		expect(managerOptions.hasChanges).toBe(true);
		save();
		await harness().finish();

		expect(harness().sent.map((r) => r.testScript)).toEqual(["first", "second"]);
	});

	it("still reports clean when nothing was typed during the flight", async () => {
		click("type first");
		expect(dirty()).toBe("true");

		save();
		await harness().finish();

		expect(dirty()).toBe("false");
	});

	it("stamps each edit with a new generation for the debounce to restart on", () => {
		click("type first");
		const afterFirst = managerOptions.changeToken;

		click("type second");

		expect(managerOptions.changeToken).not.toBe(afterFirst);
	});
});
