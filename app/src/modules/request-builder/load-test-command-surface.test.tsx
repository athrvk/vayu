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
 * The live-draft channel, end to end: what the palette actually starts.
 *
 * The whole reason #526 shipped the command registry without a load-test entry
 * is that a command reaching the *saved* request would run the old URL after an
 * edit and report it as the run the user asked for. So the assertion that
 * matters is not "a handler fired" but "the handler received what is on screen"
 * - revert the wiring to the stored request and the third test below fails on
 * the URL it was handed.
 *
 * The provider is mocked down to the same seams `RequestBuilderProvider.name-sync`
 * uses: variable resolution, the save manager and the query hooks have nothing
 * to do with which draft crosses the channel.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RequestBuilderProvider, useRequestBuilderContext } from "./context";
import LoadTestCommandSurface from "./components/LoadTestCommandSurface";
import { useLiveCommandSurfaceStore } from "@/lib/commands";
import type { RequestState } from "./types";

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

/** Edits the draft the way the URL bar does. */
function UrlEditor() {
	const { updateField } = useRequestBuilderContext();
	return <button onClick={() => updateField("url", "https://api.test/edited")}>edit url</button>;
}

function Harness({ onStartLoadTest }: { onStartLoadTest?: (r: RequestState) => void }) {
	const initialRequest: Partial<RequestState> = {
		id: "req_1",
		name: "Charge card",
		url: "https://api.test/saved",
	};
	return (
		<RequestBuilderProvider
			initialRequest={initialRequest}
			collectionId="col_1"
			{...(onStartLoadTest ? { onStartLoadTest } : {})}
		>
			<UrlEditor />
			<LoadTestCommandSurface />
		</RequestBuilderProvider>
	);
}

const registered = () => useLiveCommandSurfaceStore.getState().startLoadTest;

beforeEach(() => {
	useLiveCommandSurfaceStore.setState({ startLoadTest: null });
});

describe("the request builder contributes its live draft to the command registry", () => {
	it("registers nothing until a builder is mounted", () => {
		expect(registered()).toBeNull();
	});

	it("publishes a handler while mounted", () => {
		render(<Harness onStartLoadTest={vi.fn()} />);
		expect(registered()).not.toBeNull();
	});

	it("hands over the request as edited, not as stored", () => {
		const started = vi.fn();
		render(<Harness onStartLoadTest={started} />);

		act(() => screen.getByText("edit url").click());
		act(() => registered()?.());

		expect(started).toHaveBeenCalledTimes(1);
		expect(started.mock.calls[0]?.[0]).toMatchObject({ url: "https://api.test/edited" });
	});

	it("keeps one registration across draft edits, so typing does not churn the store", () => {
		render(<Harness onStartLoadTest={vi.fn()} />);
		const first = registered();

		act(() => screen.getByText("edit url").click());

		// The builder's own `startLoadTest` is a new function after every edit;
		// what crosses the channel is a stable wrapper, or the palette re-renders
		// once per keystroke.
		expect(registered()).toBe(first);
	});

	it("clears the surface on unmount, so a closed tab leaves no dead handler", () => {
		const { unmount } = render(<Harness onStartLoadTest={vi.fn()} />);
		expect(registered()).not.toBeNull();

		unmount();

		expect(registered()).toBeNull();
	});

	it("leaves the clear to the current holder, so a remount out of order still stands", () => {
		render(<Harness onStartLoadTest={vi.fn()} />);
		const current = registered();

		// A previous builder's unmount arriving late must not empty the slot the
		// builder now on screen owns.
		act(() => useLiveCommandSurfaceStore.getState().clearStartLoadTest(() => {}));

		expect(registered()).toBe(current);
	});
});
