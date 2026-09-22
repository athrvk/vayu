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
 * The provider half of "a re-send does not blank the response pane".
 *
 * `executeRequest` used to open with `setLocalResponse(null)` beside
 * `setIsExecuting(true)`, so the exchange the user was reading was discarded at
 * the press of Send - and no amount of care in `ResponseViewer` could keep it on
 * screen, because by then there was nothing left to keep. The pane's own guard
 * (`resend-keeps-response.test.tsx`) renders a response that is *given* to it;
 * this is the one that says a response survives a send at all.
 *
 * The streaming path is the deliberate exception and is guarded here too: its
 * pane is fed by a placeholder built from the relay's `open` frame, and that
 * placeholder is only built when there is no stored response, so a stream that
 * kept the last buffered exchange would never show its own.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, act, waitFor } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { useResponseStore, useExecutionEventsStore } from "@/stores";
import type { RequestBuilderContextValue, RequestState, ResponseState } from "../types";

// The provider is wired to variable resolution, the save manager and several
// TanStack Query hooks; none of that is under test here. Same inert stubs as
// execute-request-switch.test.tsx, which drives this provider the same way.
vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

vi.mock("@/queries", () => ({
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

function makeResponse(tag: string): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: {},
		body: tag,
		bodyType: "text",
		size: tag.length,
		time: 1,
	};
}

// The latest context value, republished after each commit. Updated in an effect
// (not during render) so it does not reassign an outer binding while rendering.
const captured: { ctx: RequestBuilderContextValue | null } = { ctx: null };
const ctx = () => {
	if (!captured.ctx) throw new Error("context not captured yet");
	return captured.ctx;
};
function Capture() {
	const value = useRequestBuilderContext();
	useEffect(() => {
		captured.ctx = value;
	});
	return null;
}

/** An onExecute whose promise the test resolves by hand. */
function deferredExecute() {
	let resolve!: (r: ResponseState | null) => void;
	const fn = vi.fn(() => new Promise<ResponseState | null>((r) => (resolve = r)));
	return { fn, resolve: (r: ResponseState | null) => resolve(r) };
}

describe("a send keeps the previous response until its own lands", () => {
	beforeEach(() => {
		useResponseStore.getState().clearAll();
		useExecutionEventsStore.getState().clear();
	});

	it("holds the previous exchange for the whole of a re-send", async () => {
		const first = deferredExecute();
		render(
			<RequestBuilderProvider
				initialRequest={{ id: "A", name: "A" } as Partial<RequestState>}
				onExecute={first.fn}
			>
				<Capture />
			</RequestBuilderProvider>
		);

		await act(async () => {
			void ctx().executeRequest();
		});
		await act(async () => {
			first.resolve(makeResponse("FIRST"));
		});
		await waitFor(() => expect(ctx().response?.body).toBe("FIRST"));

		// Send again. The previous response must still be there for the whole
		// time the second send is in flight - this is the assertion the old
		// `setLocalResponse(null)` failed.
		await act(async () => {
			void ctx().executeRequest();
		});
		expect(ctx().isExecuting).toBe(true);
		expect(ctx().response?.body).toBe("FIRST");

		await act(async () => {
			first.resolve(makeResponse("SECOND"));
		});
		await waitFor(() => expect(ctx().response?.body).toBe("SECOND"));
		expect(ctx().isExecuting).toBe(false);
	});

	it("a stream-flagged send still clears, so its own placeholder can show", async () => {
		const exec = deferredExecute();
		// Never resolved. The clear under test happens before the engine answers,
		// and letting the stream actually start would have the events hook open a
		// real `EventSource`, which jsdom does not provide.
		const onExecuteStream = vi.fn(() => new Promise<never>(() => {}));

		const { rerender } = render(
			<RequestBuilderProvider
				initialRequest={{ id: "A", name: "A" } as Partial<RequestState>}
				onExecute={exec.fn}
				onExecuteStream={onExecuteStream}
			>
				<Capture />
			</RequestBuilderProvider>
		);

		await act(async () => {
			void ctx().executeRequest();
		});
		await act(async () => {
			exec.resolve(makeResponse("BUFFERED"));
		});
		await waitFor(() => expect(ctx().response?.body).toBe("BUFFERED"));

		// Flip the request to a streaming one and send it.
		act(() => {
			ctx().updateField("stream", true);
		});
		rerender(
			<RequestBuilderProvider
				initialRequest={{ id: "A", name: "A" } as Partial<RequestState>}
				onExecute={exec.fn}
				onExecuteStream={onExecuteStream}
			>
				<Capture />
			</RequestBuilderProvider>
		);

		await act(async () => {
			void ctx().executeRequest();
		});
		expect(ctx().response).toBeNull();
	});
});
