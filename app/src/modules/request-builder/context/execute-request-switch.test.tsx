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
 * One `RequestBuilderProvider` is reused across request tabs (Shell renders a
 * single `<RequestBuilder />` with no per-entity key), so an execute that is
 * still in flight when the user switches requests must land on the request that
 * actually ran - not on whatever is on screen when it resolves.
 *
 * Before the fix the shared `isExecuting` / `response` state leaked: switching
 * mid-flight left the new request showing a "Sending" spinner it never
 * triggered, and the slow request's body then appeared under the new request.
 * These lock the two halves of the fix - the reset effect clears `isExecuting`
 * on a request change, and `executeRequest` guards the shared view with the id
 * that is on screen *now* while still persisting the result under the id that
 * ran. Revert either half and one of these fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, act, waitFor } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import { useResponseStore } from "@/stores";
import type { RequestBuilderContextValue, RequestState, ResponseState } from "../types";

// The provider is wired to variable resolution, the save manager and several
// TanStack Query hooks. None of those are under test here, so stub them to inert
// values - the response store stays real, because the leak we are guarding is a
// write to it under the wrong id.
vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
	}),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

vi.mock("@/queries", () => ({
	useGlobalsQuery: () => ({ data: { variables: {} } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useCollectionsQuery: () => ({ data: [] }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
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

function renderFor(id: string, onExecute: (r: RequestState) => Promise<ResponseState | null>) {
	return (
		<RequestBuilderProvider
			initialRequest={{ id, name: id } as Partial<RequestState>}
			onExecute={onExecute}
		>
			<Capture />
		</RequestBuilderProvider>
	);
}

/** An onExecute whose promise the test resolves by hand. */
function deferredExecute() {
	let resolve!: (r: ResponseState | null) => void;
	const fn = vi.fn(() => new Promise<ResponseState | null>((r) => (resolve = r)));
	return { fn, resolve: (r: ResponseState | null) => resolve(r) };
}

describe("execute survives a request switch without leaking", () => {
	beforeEach(() => {
		useResponseStore.getState().clearAll();
	});

	it("harness: a normal execute shows its own response (guards the wiring)", async () => {
		const exec = deferredExecute();
		render(renderFor("A", exec.fn));

		await act(async () => {
			void ctx().executeRequest();
		});
		expect(ctx().isExecuting).toBe(true);

		const result = makeResponse("A-RESULT");
		await act(async () => {
			exec.resolve(result);
		});
		await waitFor(() => expect(ctx().response?.body).toBe("A-RESULT"));
		expect(ctx().isExecuting).toBe(false);
		expect(useResponseStore.getState().getResponse("A")?.body).toBe("A-RESULT");
	});

	it("finishing after switching to another request does not leak into it", async () => {
		const exec = deferredExecute();
		const { rerender } = render(renderFor("A", exec.fn));

		// Send request A, then switch to B before it resolves.
		await act(async () => {
			void ctx().executeRequest();
		});
		expect(ctx().isExecuting).toBe(true);

		rerender(renderFor("B", exec.fn));
		// The switched-to request must not inherit A's spinner.
		expect(ctx().isExecuting).toBe(false);
		expect(ctx().response).toBeNull();

		// A finishes now, while B is on screen.
		const resultA = makeResponse("A-RESULT");
		await act(async () => {
			exec.resolve(resultA);
		});
		// Its result is stored under A (returning to A would show it)...
		await waitFor(() =>
			expect(useResponseStore.getState().getResponse("A")?.body).toBe("A-RESULT")
		);
		// ...but never touches B's live view or B's stored response.
		expect(ctx().response).toBeNull();
		expect(ctx().isExecuting).toBe(false);
		expect(useResponseStore.getState().getResponse("B")).toBeNull();
	});

	it("finishing after switching away and back lands the response in view", async () => {
		const exec = deferredExecute();
		const { rerender } = render(renderFor("A", exec.fn));

		await act(async () => {
			void ctx().executeRequest();
		});

		// Leave A, then come back before it finishes.
		rerender(renderFor("B", exec.fn));
		rerender(renderFor("A", exec.fn));

		const resultA = makeResponse("A-RESULT");
		await act(async () => {
			exec.resolve(resultA);
		});

		// Same instance is still in flight for A, so the result appears.
		await waitFor(() => expect(ctx().response?.body).toBe("A-RESULT"));
		expect(ctx().isExecuting).toBe(false);
		expect(useResponseStore.getState().getResponse("A")?.body).toBe("A-RESULT");
	});
});
