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
 * The streaming send branch (issue #574).
 *
 * A stream-flagged Send takes a different endpoint answer - `202 {runId,
 * eventsUrl}` and no exchange - so the provider has to do three things the
 * buffered path does not, each of which fails quietly on its own:
 *
 * - **Return to idle immediately.** The request is no longer in flight once the
 *   engine has answered, and leaving `isExecuting` set would hide the Events
 *   tab behind "Sending…" for the whole life of the stream.
 * - **Register the stream against the request that sent it.** One provider
 *   serves every request tab, so rows keyed to the wrong request would appear
 *   under a request that never streamed - the worst failure here, because such
 *   a timeline looks real.
 * - **Swap the live rows for the stored trace when it ends.** The completed
 *   run's `events` node is the record, and the only copy carrying the truthful
 *   `totalEvents` / `eventsTruncated` markers.
 *
 * The events hook is stubbed: it opens an `EventSource`, which jsdom has none
 * of, and what is under test is the branch around it - the store is driven
 * directly, exactly as the relay would.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, act, waitFor } from "@testing-library/react";
import { useResponseStore, useExecutionEventsStore } from "@/stores";
import type {
	RequestBuilderContextValue,
	RequestState,
	ResponseState,
	StreamStartResult,
} from "../types";

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
	}),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

const invalidateQueries = vi.fn();
vi.mock("@/lib/query-client", () => ({ queryClient: { invalidateQueries } }));

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
	queryKeys: {
		runs: { lists: () => ["runs"], recentDesign: (id: string) => ["runs", "recent", id] },
	},
}));

const getRunReport = vi.fn();
const stopRun = vi.fn(async () => ({}));
vi.mock("@/services", () => ({ apiService: { getRunReport, stopRun } }));

// The relay is driven by hand below; the hook only owns the socket.
vi.mock("../hooks/useExecutionEvents", () => ({ useExecutionEvents: () => {} }));

const { default: RequestBuilderProvider } = await import("./RequestBuilderProvider");
const { useRequestBuilderContext } = await import("./RequestBuilderContext");

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

function renderFor(
	id: string,
	onExecuteStream: (r: RequestState) => Promise<StreamStartResult | null>
) {
	return (
		<RequestBuilderProvider
			initialRequest={{ id, name: id, stream: true } as Partial<RequestState>}
			onExecute={async () => null}
			onExecuteStream={onExecuteStream}
		>
			<Capture />
		</RequestBuilderProvider>
	);
}

const started = async (): Promise<StreamStartResult> => ({
	ok: true,
	runId: "run_1",
	eventsUrl: "/runs/run_1/events",
});

/** A report whose one result carries a stored `events` node. */
function reportWithEvents(body: string) {
	return {
		results: [
			{
				timestamp: 1_750_000_000_000,
				statusCode: 200,
				statusText: "OK",
				latencyMs: 5,
				trace: {
					request: { method: "GET", url: "https://api.example.test/sse" },
					response: { headers: {}, body },
					events: {
						items: [{ event: "token", data: "stored" }],
						totalEvents: 9,
						eventsTruncated: true,
						endReason: "completed" as const,
					},
				},
			},
		],
	};
}

describe("the streaming send branch", () => {
	beforeEach(() => {
		useResponseStore.getState().clearAll();
		useExecutionEventsStore.getState().clear();
		invalidateQueries.mockClear();
		getRunReport.mockReset();
		stopRun.mockClear();
	});

	it("registers the stream against the request that sent it, and returns to idle", async () => {
		render(renderFor("A", started));

		await act(async () => {
			await ctx().executeRequest();
		});

		// Idle, not "Sending": the engine has the transfer and has answered.
		expect(ctx().isExecuting).toBe(false);
		expect(ctx().isStreaming).toBe(true);
		expect(useExecutionEventsStore.getState()).toMatchObject({
			requestId: "A",
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		});
	});

	it("renders a refusal as a response under the request that ran", async () => {
		// A stream can still be refused with a 400 the user has to read - the
		// engine's own wording, here the transient/stream conflict - so the
		// failure travels as the response it should render. (Scripts are no
		// longer one of those refusals: #612 shipped them, #620 swept the claim.)
		const refused: ResponseState = {
			status: 0,
			statusText: "Error",
			headers: {},
			body: "'stream' and 'transient' cannot be combined",
			bodyType: "text",
			size: 0,
			time: 0,
			errorCode: "INTERNAL_ERROR",
		};
		render(renderFor("A", async () => ({ ok: false, response: refused })));

		await act(async () => {
			await ctx().executeRequest();
		});

		expect(ctx().response?.body).toContain("cannot be combined");
		expect(ctx().isStreaming).toBe(false);
		expect(useResponseStore.getState().getResponse("A")?.status).toBe(0);
	});

	it("stops the run it started, and lets the engine name the reason", async () => {
		render(renderFor("A", started));
		await act(async () => {
			await ctx().executeRequest();
		});

		await act(async () => {
			await ctx().stopStream();
		});

		expect(stopRun).toHaveBeenCalledWith("run_1");
		// Still streaming on this side: the relay's `complete` frame is what
		// ends it, carrying `reason: "stopped"`. Ending it locally would report
		// a reason the run never recorded.
		expect(ctx().isStreaming).toBe(true);
	});

	it("swaps the live rows for the run's stored trace when the stream ends", async () => {
		getRunReport.mockResolvedValue(reportWithEvents("ignored"));
		render(renderFor("A", started));
		await act(async () => {
			await ctx().executeRequest();
		});

		// What the relay delivered, then the frame that closes it.
		act(() => {
			useExecutionEventsStore.getState().addEvent("run_1", { event: "token", data: "live" });
			useExecutionEventsStore.getState().endStream("run_1", "completed", 9);
		});

		await waitFor(() => expect(ctx().response?.events).toBeDefined());
		expect(getRunReport).toHaveBeenCalledWith("run_1");
		expect(ctx().response?.events).toEqual([{ event: "token", data: "stored" }]);
		// The markers only the stored copy carries.
		expect(ctx().response?.totalEvents).toBe(9);
		expect(ctx().response?.eventsTruncated).toBe(true);
		// Durable, so switching away and back still shows it. Read through the
		// same cast the provider uses: `StoredResponse` is a structural subset
		// of `ResponseState` and deliberately does not name every field it
		// stores (see response-store.ts).
		const stored = useResponseStore.getState().getResponse("A") as ResponseState | null;
		expect(stored?.totalEvents).toBe(9);
	});

	it("keeps the rows on screen when the stored copy cannot be fetched", async () => {
		// The rows came from the stream itself and are still true; failing to
		// read the stored copy does not make them false.
		getRunReport.mockRejectedValue(new Error("engine went away"));
		render(renderFor("A", started));
		await act(async () => {
			await ctx().executeRequest();
		});

		act(() => {
			useExecutionEventsStore.getState().addEvent("run_1", { event: "token", data: "live" });
			useExecutionEventsStore.getState().endStream("run_1", "completed", 1);
		});

		await waitFor(() => expect(getRunReport).toHaveBeenCalled());
		expect(useExecutionEventsStore.getState().events).toHaveLength(1);
		expect(ctx().isStreaming).toBe(false);
	});

	it("does not report another request's stream as this one's", async () => {
		const { rerender } = render(renderFor("A", started));
		await act(async () => {
			await ctx().executeRequest();
		});
		expect(ctx().isStreaming).toBe(true);

		rerender(renderFor("B", started));

		// Mutation check for the staleness guard: drop the `s.requestId ===
		// requestId` test in the provider's selectors and B inherits A's live
		// stream, Stop button and all.
		expect(ctx().isStreaming).toBe(false);
	});
});
