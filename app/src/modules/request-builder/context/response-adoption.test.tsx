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
 * The builder adopts a response the store gains for the request it is showing.
 *
 * Opening a design run from history writes the restored response into the
 * response store and then opens that request's tab. Usually the provider mounts
 * fresh and reads the store in its initialiser - only the active tab is
 * rendered, so switching tabs unmounts and remounts it. The case that needs
 * this subscription is the one where the tab is *already* the active one: none
 * of the id-keyed effects fire, and without it the click appeared to do
 * nothing.
 *
 * The hazard it has to avoid is the opposite one. `executeRequest` clears the
 * pane with `setResponse(null)` while leaving the previous response in the
 * store; a sync that keyed on contents rather than identity would immediately
 * put the old response back and the pane would never show "Sending…".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { useResponseStore } from "@/stores";
import type { ResponseState } from "../types";

// The provider pulls in the whole variable-resolution and mutation stack; none
// of it matters to response adoption.
vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
	}),
	useSaveManager: () => ({ forceSave: async () => {}, status: "idle", isSaving: false }),
}));

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: undefined }),
	useUpdateGlobalsMutation: () => ({ mutate: () => {} }),
	useCollectionsQuery: () => ({ data: [] }),
	useUpdateCollectionMutation: () => ({ mutate: () => {} }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: () => {} }),
	useLastDesignRunQuery: () => ({ run: null, report: undefined, isLoading: false }),
}));

function response(body: string, runId?: string): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: {},
		body,
		bodyType: "json",
		size: body.length,
		time: 10,
		...(runId ? { restoredFrom: { runId, at: new Date().toISOString() } } : {}),
	};
}

/** Prints whatever the context currently holds, plus the executing flag. */
function Probe() {
	const { response: current, isExecuting, executeRequest } = useRequestBuilderContext();
	return (
		<div>
			<span data-testid="body">{current?.body ?? "none"}</span>
			<span data-testid="from">{current?.restoredFrom?.runId ?? "-"}</span>
			<span data-testid="executing">{String(isExecuting)}</span>
			<button onClick={() => void executeRequest()}>send</button>
		</div>
	);
}

function mount(onExecute?: () => Promise<ResponseState | null>) {
	return render(
		<RequestBuilderProvider initialRequest={{ id: "req-1" }} onExecute={onExecute}>
			<Probe />
		</RequestBuilderProvider>
	);
}

beforeEach(() => {
	useResponseStore.getState().clearAll();
});

describe("a response arriving in the store", () => {
	it("is picked up by a builder already on screen for that request", () => {
		mount();
		expect(screen.getByTestId("body").textContent).toBe("none");

		act(() => {
			useResponseStore.getState().setResponse("req-1", response('{"ok":true}', "run-7"));
		});

		expect(screen.getByTestId("body").textContent).toBe('{"ok":true}');
		expect(screen.getByTestId("from").textContent).toBe("run-7");
	});

	it("is ignored when it belongs to a different request", () => {
		mount();

		act(() => {
			useResponseStore.getState().setResponse("req-2", response("someone else's"));
		});

		expect(screen.getByTestId("body").textContent).toBe("none");
	});

	it("replaces one restored run with the next", () => {
		// Clicking two design runs for the same request in a row.
		mount();

		act(() => {
			useResponseStore.getState().setResponse("req-1", response("first", "run-7"));
		});
		act(() => {
			useResponseStore.getState().setResponse("req-1", response("second", "run-8"));
		});

		expect(screen.getByTestId("body").textContent).toBe("second");
		expect(screen.getByTestId("from").textContent).toBe("run-8");
	});
});

describe("sending, with a restored response already on screen", () => {
	it("clears the pane and does not let the stale store entry put it back", async () => {
		let release: (r: ResponseState) => void = () => {};
		const pending = new Promise<ResponseState>((resolve) => {
			release = resolve;
		});

		mount(() => pending);

		act(() => {
			useResponseStore.getState().setResponse("req-1", response("restored", "run-7"));
		});
		expect(screen.getByTestId("body").textContent).toBe("restored");

		act(() => {
			screen.getByText("send").click();
		});

		// The regression this guards: the store still holds "restored", and a
		// contents-keyed sync would re-adopt it here, hiding the loading state.
		expect(screen.getByTestId("executing").textContent).toBe("true");
		expect(screen.getByTestId("body").textContent).toBe("none");

		await act(async () => {
			release(response("fresh"));
			await pending;
		});

		await waitFor(() => expect(screen.getByTestId("body").textContent).toBe("fresh"));
		// A response that was just executed carries no age chip.
		expect(screen.getByTestId("from").textContent).toBe("-");
	});
});
