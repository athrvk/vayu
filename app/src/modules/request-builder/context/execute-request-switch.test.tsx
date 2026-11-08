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
 * The send lifecycle is held per request (#3352): a switch neither hands the
 * spinner to the switched-to request nor takes it from the one still sending,
 * and of two sends of one request only the newer one's finish and answer count.
 * `executeRequest` guards the shared view with the id that is on screen *now*
 * while still persisting the result under the id that ran. A buffered send can
 * be cancelled, and a cancelled send's answer is dropped like an overtaken one's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TestQueryClient } from "@/test/TestQueryClient";
import { useEffect } from "react";
import { render, renderHook, act, waitFor, screen, fireEvent } from "@testing-library/react";
import RequestBuilderProvider from "./RequestBuilderProvider";
import { useRequestBuilderContext } from "./RequestBuilderContext";
import UrlBar from "../components/UrlBar";
import { TooltipProvider } from "@/components/ui";
import { useResponseStore } from "@/stores";
// The module itself, past the `@/hooks` stub below: the cancel's whole chain
// to `fetch` is what one case here walks.
import { useEngine } from "@/hooks/useEngine";
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
	// The provider walks this for the auth an `inherit` resolves to; nothing
	// here is about inheritance, so the chain is empty.
	useCollectionAncestors: () => [],
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
	useEnvironmentsQuery: () => ({ data: [] }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useLastDesignRunQuery: () => ({ run: undefined, report: undefined, isLoading: false }),
	// The provider reads the engine data caps for Send-with-row's row cap
	// (`useDataFileLimits`); empty entries leave it on the seeds.
	useConfigQuery: () => ({ data: { entries: [] } }),
}));

// The URL bar's method and URL fields pull in the variable-highlighting input;
// the Send button is all these cases read.
vi.mock("../components/UrlBar/MethodSelector", () => ({ default: () => null }));
vi.mock("../components/UrlBar/UrlInput", () => ({ default: () => null }));

function makeResponse(tag: string): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: {},
		body: tag,
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

type OnExecute = (
	r: RequestState,
	dataRow?: Record<string, unknown>,
	signal?: AbortSignal
) => Promise<ResponseState | null>;

function renderFor(id: string, onExecute: OnExecute) {
	return (
		<TestQueryClient>
			<TooltipProvider>
				<RequestBuilderProvider
					initialRequest={{ id, name: id, url: `https://api.test/${id}` }}
					onExecute={onExecute}
				>
					<Capture />
					<UrlBar />
				</RequestBuilderProvider>
			</TooltipProvider>
		</TestQueryClient>
	);
}

/** An onExecute whose calls the test resolves by hand, each on its own. */
function deferredExecute() {
	const pending: Array<(r: ResponseState | null) => void> = [];
	const fn = vi.fn(
		(_r: RequestState, _row?: Record<string, unknown>, _signal?: AbortSignal) =>
			new Promise<ResponseState | null>((r) => pending.push(r))
	);
	return {
		fn,
		/** Resolve the `call`-th send (0 is the first). */
		resolveCall: (call: number, r: ResponseState | null) => pending[call](r),
		resolve: (r: ResponseState | null) => pending[0](r),
	};
}

/** The URL bar's Send button, whichever label it carries. */
const sendButton = () => screen.getByRole("button", { name: /^(Send|Sending…)$/ });

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
		expect(ctx().isExecuting).toBe(true);

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

describe("the send lifecycle is held per request (#3352)", () => {
	beforeEach(() => {
		useResponseStore.getState().clearAll();
	});

	it("A, B, A during a send keeps A's Send disabled until its response lands", async () => {
		const exec = deferredExecute();
		const { rerender } = render(renderFor("A", exec.fn));

		await act(async () => {
			fireEvent.click(sendButton());
		});
		expect(sendButton()).toBeDisabled();

		rerender(renderFor("B", exec.fn));
		expect(sendButton()).toBeEnabled();

		rerender(renderFor("A", exec.fn));
		expect(sendButton()).toBeDisabled();
		expect(sendButton()).toHaveAccessibleName("Sending…");
		// The disabled button is the whole gate: a click on it sends nothing.
		fireEvent.click(sendButton());
		expect(exec.fn).toHaveBeenCalledTimes(1);

		await act(async () => {
			exec.resolve(makeResponse("A-RESULT"));
		});
		await waitFor(() => expect(sendButton()).toBeEnabled());
		expect(ctx().response?.body).toBe("A-RESULT");
	});

	it("of two quick sends, an older answer arriving last is dropped", async () => {
		const exec = deferredExecute();
		render(renderFor("A", exec.fn));

		await act(async () => {
			void ctx().executeRequest();
			void ctx().executeRequest();
		});
		expect(exec.fn).toHaveBeenCalledTimes(2);

		await act(async () => {
			exec.resolveCall(1, makeResponse("NEWER"));
		});
		await waitFor(() => expect(ctx().response?.body).toBe("NEWER"));

		await act(async () => {
			exec.resolveCall(0, makeResponse("OLDER"));
		});
		expect(ctx().response?.body).toBe("NEWER");
		expect(useResponseStore.getState().getResponse("A")?.body).toBe("NEWER");
		expect(ctx().isExecuting).toBe(false);
	});

	it("of two quick sends, the older one finishing first leaves the newer one sending", async () => {
		const exec = deferredExecute();
		render(renderFor("A", exec.fn));

		await act(async () => {
			void ctx().executeRequest();
			void ctx().executeRequest();
		});

		await act(async () => {
			exec.resolveCall(0, makeResponse("OLDER"));
		});
		expect(ctx().isExecuting).toBe(true);
		expect(ctx().response?.body).not.toBe("OLDER");
		expect(useResponseStore.getState().getResponse("A")).toBeNull();

		await act(async () => {
			exec.resolveCall(1, makeResponse("NEWER"));
		});
		await waitFor(() => expect(ctx().response?.body).toBe("NEWER"));
		expect(ctx().isExecuting).toBe(false);
	});
});

describe("Cancel on a buffered send (#3352)", () => {
	beforeEach(() => {
		useResponseStore.getState().clearAll();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const cancelButton = () => screen.getByRole("button", { name: /^cancel$/i });

	it("aborts the send's signal and returns the request to idle at once", async () => {
		const exec = deferredExecute();
		render(renderFor("A", exec.fn));

		await act(async () => {
			fireEvent.click(sendButton());
		});
		const signal = exec.fn.mock.calls[0][2];
		expect(signal?.aborted).toBe(false);

		fireEvent.click(cancelButton());

		expect(signal?.aborted).toBe(true);
		expect(ctx().isExecuting).toBe(false);
		expect(sendButton()).toBeEnabled();
		expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
	});

	it("drops the cancelled send's late answer and keeps the previous response", async () => {
		const exec = deferredExecute();
		render(renderFor("A", exec.fn));

		await act(async () => {
			void ctx().executeRequest();
		});
		await act(async () => {
			exec.resolveCall(0, makeResponse("PREVIOUS"));
		});
		await waitFor(() => expect(ctx().response?.body).toBe("PREVIOUS"));

		await act(async () => {
			fireEvent.click(sendButton());
		});
		fireEvent.click(cancelButton());
		await act(async () => {
			exec.resolveCall(1, makeResponse("CANCELLED"));
		});

		expect(ctx().response?.body).toBe("PREVIOUS");
		expect(useResponseStore.getState().getResponse("A")?.body).toBe("PREVIOUS");
		expect(ctx().isExecuting).toBe(false);
	});

	it("is not offered while a stream's start is in flight", async () => {
		const stream = vi.fn(() => new Promise<null>(() => {}));
		render(
			<TestQueryClient>
				<TooltipProvider>
					<RequestBuilderProvider
						initialRequest={{
							id: "S",
							name: "S",
							url: "https://api.test/S",
							stream: true,
						}}
						onExecute={vi.fn()}
						onExecuteStream={stream}
					>
						<Capture />
						<UrlBar />
					</RequestBuilderProvider>
				</TooltipProvider>
			</TestQueryClient>
		);

		await act(async () => {
			void ctx().executeRequest();
		});

		expect(ctx().isExecuting).toBe(true);
		expect(ctx().canCancelSend).toBe(false);
		expect(screen.queryByRole("button", { name: /^cancel$/i })).toBeNull();
		ctx().cancelSend();
		expect(ctx().isExecuting).toBe(true);
	});

	it("reaches the engine call: the fetch is aborted and no error response lands", async () => {
		const fetchSignals: AbortSignal[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				const signal = init.signal as AbortSignal;
				fetchSignals.push(signal);
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError"))
					);
				});
			})
		);
		const engine = renderHook(() => useEngine()).result;
		// What the engine call answered, which the provider would drop anyway:
		// a cancel must not be synthesised into a `status: 0` failure on the way.
		const answers: unknown[] = [];
		const onExecute: OnExecute = async (r, _row, signal) => {
			const result = await engine.current.executeRequest(
				{ method: r.method, url: r.url },
				undefined,
				signal
			);
			answers.push(result);
			return result ? makeResponse(`status ${result.status}`) : null;
		};
		render(renderFor("A", onExecute));

		await act(async () => {
			fireEvent.click(sendButton());
		});
		await waitFor(() => expect(fetchSignals).toHaveLength(1));

		await act(async () => {
			fireEvent.click(cancelButton());
		});

		expect(fetchSignals[0].aborted).toBe(true);
		await waitFor(() => expect(answers).toEqual([null]));
		expect(ctx().response).toBeNull();
		expect(useResponseStore.getState().getResponse("A")).toBeNull();
		expect(ctx().isExecuting).toBe(false);
	});
});
