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
 * Send's live-draft channel, end to end: what the palette actually sends (#1243).
 *
 * Two properties, and both are the reason this file exists rather than a
 * store-level test. The first is the one that kept Send out of the palette until
 * now - a command reaching for the *saved* request would put the old URL on the
 * wire after an edit and report it as the send the user asked for; revert the
 * wiring to the stored request and "as edited, not as stored" fails on the URL it
 * was handed.
 *
 * The second is the gate. The builder withdraws the contribution whenever a send
 * would be refused - an empty URL, a request in flight, an open stream where
 * Send is Stop (#574) - so the palette row is absent exactly when the Send button
 * is disabled or gone. Drop the `canSendRequest` call in the surface and the
 * three withdrawal cases fail with a handler registered.
 *
 * The provider is mocked down to the same seams `load-test-command-surface` uses:
 * variable resolution, the save manager and the query hooks have nothing to do
 * with which draft crosses the channel.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { RequestBuilderProvider, useRequestBuilderContext } from "./context";
import SendRequestCommandSurface from "./components/SendRequestCommandSurface";
import { useLiveCommandSurfaceStore } from "@/lib/commands";
import { useExecutionEventsStore } from "@/stores";
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
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

/** Edits the draft the way the URL bar does. */
function UrlEditor() {
	const { updateField } = useRequestBuilderContext();
	return (
		<>
			<button onClick={() => updateField("url", "https://api.test/edited")}>edit url</button>
			<button onClick={() => updateField("url", "   ")}>clear url</button>
		</>
	);
}

type Execute = (request: RequestState, dataRow?: Record<string, unknown>) => Promise<null>;

function Harness({ onExecute, url }: { onExecute?: Execute; url?: string }) {
	const initialRequest: Partial<RequestState> = {
		id: "req_1",
		name: "Charge card",
		url: url ?? "https://api.test/saved",
	};
	return (
		<RequestBuilderProvider
			initialRequest={initialRequest}
			collectionId="col_1"
			{...(onExecute ? { onExecute } : {})}
		>
			<UrlEditor />
			<SendRequestCommandSurface />
		</RequestBuilderProvider>
	);
}

const registered = () => useLiveCommandSurfaceStore.getState().sendRequest;

/** An `onExecute` that never settles - the builder stays "in flight". */
function pendingExecute(): { execute: Execute; calls: RequestState[] } {
	const calls: RequestState[] = [];
	return {
		calls,
		execute: (request) => {
			calls.push(request);
			return new Promise<null>(() => {});
		},
	};
}

beforeEach(() => {
	useLiveCommandSurfaceStore.setState({ sendRequest: null });
	useExecutionEventsStore.setState({ isStreaming: false, requestId: null });
});

describe("the request builder contributes Send to the command registry", () => {
	it("registers nothing until a builder is mounted", () => {
		expect(registered()).toBeNull();
	});

	it("publishes a handler while a mounted builder could send", () => {
		render(<Harness onExecute={vi.fn(async () => null)} />);
		expect(registered()).not.toBeNull();
	});

	it("sends the request as edited, not as stored", () => {
		const { execute, calls } = pendingExecute();
		render(<Harness onExecute={execute} />);

		act(() => screen.getByText("edit url").click());
		act(() => registered()?.());

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ url: "https://api.test/edited" });
	});

	it("sends with no bound row, so the row a picker last chose is not resent", () => {
		const onExecute = vi.fn<Execute>(async () => null);
		render(<Harness onExecute={onExecute} />);

		act(() => registered()?.());

		// Send-with-row is a distinct action with its own picker; this is the
		// plain Send, and `executeRequest` un-binds the last row for it.
		expect(onExecute).toHaveBeenCalledTimes(1);
		expect(onExecute.mock.calls[0]?.[1]).toBeUndefined();
	});

	it("keeps one registration across draft edits, so typing does not churn the store", () => {
		render(<Harness onExecute={vi.fn(async () => null)} />);
		const first = registered();

		act(() => screen.getByText("edit url").click());

		expect(registered()).toBe(first);
	});

	it("offers nothing while the URL is empty, the way the Send button is disabled", () => {
		render(<Harness onExecute={vi.fn(async () => null)} url="  " />);
		expect(registered()).toBeNull();
	});

	it("withdraws the offer when the draft's URL is emptied", () => {
		render(<Harness onExecute={vi.fn(async () => null)} />);
		expect(registered()).not.toBeNull();

		act(() => screen.getByText("clear url").click());

		expect(registered()).toBeNull();
	});

	it("withdraws the offer while a send is in flight", () => {
		const { execute, calls } = pendingExecute();
		render(<Harness onExecute={execute} />);

		act(() => registered()?.());

		// A second pick would be a second request behind the first, which the
		// chord refuses too - so the row goes away rather than sitting there.
		expect(calls).toHaveLength(1);
		expect(registered()).toBeNull();
	});

	it("withdraws the offer while this builder's stream is open, where Send is Stop", () => {
		render(<Harness onExecute={vi.fn(async () => null)} />);
		expect(registered()).not.toBeNull();

		act(() => useExecutionEventsStore.setState({ isStreaming: true, requestId: "req_1" }));

		expect(registered()).toBeNull();
	});

	it("clears the surface on unmount, so a closed tab leaves no dead handler", () => {
		const { unmount } = render(<Harness onExecute={vi.fn(async () => null)} />);
		expect(registered()).not.toBeNull();

		unmount();

		expect(registered()).toBeNull();
	});

	it("leaves the clear to the current holder, so a remount out of order still stands", () => {
		render(<Harness onExecute={vi.fn(async () => null)} />);
		const current = registered();

		act(() => useLiveCommandSurfaceStore.getState().clearSurface("sendRequest", () => {}));

		expect(registered()).toBe(current);
	});
});
