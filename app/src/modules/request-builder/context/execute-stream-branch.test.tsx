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
 *   `totalEvents` / `eventsTruncated` markers. The trace's top-level `warnings`
 *   (#3315) arrive the same way: neither the `202` nor a relay frame has them.
 *
 * The events hook is stubbed: it opens an `EventSource`, which jsdom has none
 * of, and what is under test is the branch around it - the store is driven
 * directly, exactly as the relay would.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TestQueryClient } from "@/test/TestQueryClient";
import { useEffect } from "react";
import { render, act, waitFor, screen } from "@testing-library/react";
import { useResponseStore, useExecutionEventsStore } from "@/stores";
import { ExchangeWarnings } from "@/components/shared/ExchangeWarnings";
import type {
	RequestBuilderContextValue,
	RequestState,
	ResponseState,
	StreamStartResult,
} from "../types";

/** What `useLastDesignRunQuery` answers; a case seeds it, `beforeEach` empties it. */
const lastDesign = vi.hoisted(() => ({
	run: undefined as { id: string } | undefined,
	report: undefined as unknown,
	isLoading: false,
}));

vi.mock("@/hooks", () => ({
	useVariableResolver: () => ({
		resolveString: (s: string) => s,
		getVariable: () => null,
		getAllVariables: () => ({}),
	}),
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

const invalidateQueries = vi.fn();
vi.mock("@/lib/query-client", () => ({
	queryClient: { invalidateQueries },
	// `runDetailOptions`' retry asks it; the watched run here never fails.
	isEngineStartFailure: () => false,
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
	useLastDesignRunQuery: () => ({ ...lastDesign }),
	// The provider reads the engine data caps for Send-with-row's row cap
	// (`useDataFileLimits`); empty entries leave it on the seeds.
	useConfigQuery: () => ({ data: { entries: [] } }),
	queryKeys: {
		runs: {
			lists: () => ["runs"],
			recentDesign: (id: string) => ["runs", "recent", id],
			lastDesign: (id: string) => ["runs", "last", id],
		},
	},
}));

const getRunReport = vi.fn();
const getRun = vi.fn();
const stopRun = vi.fn(async () => ({}));
vi.mock("@/services", () => ({
	apiService: { getRunReport, stopRun },
	ApiError: class ApiError extends Error {},
}));
// The real `runDetailOptions` watches a replaced feed, and reads the run here.
vi.mock("@/services/api", () => ({ apiService: { getRun } }));

// The relay is driven by hand below; the hook only owns the socket.
vi.mock("../hooks/useExecutionEvents", () => ({ useExecutionEvents: () => {} }));

const { RUN_IN_PROGRESS_POLL_MS } = await import("@/queries/runs");
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

/** What the response pane draws above its tabs, read from the same context. */
function WarningsBand() {
	return <ExchangeWarnings warnings={useRequestBuilderContext().response?.warnings} />;
}

function renderFor(
	id: string,
	onExecuteStream: (r: RequestState) => Promise<StreamStartResult | null>
) {
	return (
		<TestQueryClient>
			<RequestBuilderProvider
				initialRequest={{ id, name: id, stream: true } as Partial<RequestState>}
				onExecute={async () => null}
				onExecuteStream={onExecuteStream}
			>
				<Capture />
				<WarningsBand />
			</RequestBuilderProvider>
		</TestQueryClient>
	);
}

const started = async (): Promise<StreamStartResult> => ({
	ok: true,
	runId: "run_1",
	eventsUrl: "/runs/run_1/events",
});

/** A report whose one result carries a stored `events` node. */
function reportWithEvents(body: string, warnings?: unknown[]) {
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
					...(warnings && { warnings }),
				},
			},
		],
	};
}

describe("the streaming send branch", () => {
	beforeEach(() => {
		useResponseStore.getState().clearAll();
		useExecutionEventsStore.getState().clear();
		lastDesign.run = undefined;
		lastDesign.report = undefined;
		lastDesign.isLoading = false;
		invalidateQueries.mockClear();
		getRunReport.mockReset();
		getRun.mockReset();
		stopRun.mockClear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stays sending until the engine answers, across a switch away and back", async () => {
		let answer!: (r: StreamStartResult) => void;
		const deferred = () => new Promise<StreamStartResult>((r) => (answer = r));
		const { rerender } = render(renderFor("A", deferred));

		await act(async () => {
			void ctx().executeRequest();
		});
		rerender(renderFor("B", deferred));
		expect(ctx().isExecuting).toBe(false);
		rerender(renderFor("A", deferred));
		expect(ctx().isExecuting).toBe(true);

		await act(async () => {
			answer({ ok: true, runId: "run_1", eventsUrl: "/runs/run_1/events" });
		});
		expect(ctx().isExecuting).toBe(false);
		expect(ctx().isStreaming).toBe(true);
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
			useExecutionEventsStore
				.getState()
				.addEvents("run_1", [{ event: "token", data: "live" }]);
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
		// The cold-start restore reads this query, so a finished run must reach it.
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["runs", "last", "A"] });
	});

	it("draws the warnings on the stored trace when the stream ends, and not before (#3315)", async () => {
		const warning = { code: "cookie_not_sent", message: "The cookie 'session' was left out." };
		getRunReport.mockResolvedValue(reportWithEvents("stored body", [warning]));
		render(renderFor("A", started));
		await act(async () => {
			await ctx().executeRequest();
		});

		// Live: the `202` and the relay carry none, so there is nothing to draw.
		expect(ctx().response?.warnings).toBeUndefined();
		expect(document.body.textContent).not.toContain(warning.message);

		act(() => {
			useExecutionEventsStore.getState().endStream("run_1", "completed", 9);
		});

		// Mutation check: drop `...warningsFromTrace` from `responseFromRunResult`
		// and the events swap in but this never appears.
		expect(await screen.findByText(warning.message, { exact: false })).toBeDefined();
		expect(ctx().response?.warnings).toEqual([warning]);
		expect(ctx().response?.events).toEqual([{ event: "token", data: "stored" }]);
		const stored = useResponseStore.getState().getResponse("A") as ResponseState | null;
		expect(stored?.warnings).toEqual([warning]);
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
			useExecutionEventsStore
				.getState()
				.addEvents("run_1", [{ event: "token", data: "live" }]);
			useExecutionEventsStore.getState().endStream("run_1", "completed", 1);
		});

		await waitFor(() => expect(getRunReport).toHaveBeenCalled());
		expect(useExecutionEventsStore.getState().events).toHaveLength(1);
		expect(ctx().isStreaming).toBe(false);
	});

	it("drops the previous stream's stored response, so a switch back does not resurrect it", async () => {
		// The mount initialiser and the request-switch reset both read the store
		// back; clearing only the local copy lets the finished stream's rows
		// return on the next switch and suppress the live placeholder.
		const previous: ResponseState = {
			status: 200,
			statusText: "OK",
			headers: {},
			body: "OLD",
			size: 3,
			time: 5,
			events: [{ event: "token", data: "old" }],
			totalEvents: 1,
			streamEndReason: "completed",
		};
		useResponseStore.getState().setResponse("A", previous);

		const { rerender } = render(renderFor("A", started));
		expect(ctx().response?.body).toBe("OLD");

		await act(async () => {
			await ctx().executeRequest();
		});
		rerender(renderFor("B", started));
		rerender(renderFor("A", started));

		// Mutation check: drop the `clearResponse` call in the provider's stream
		// branch and A comes back showing "OLD" while its new stream is live.
		expect(ctx().response).toBeNull();
		expect(useResponseStore.getState().getResponse("A")).toBeNull();
		expect(ctx().isStreaming).toBe(true);
	});

	it("does not refill the cleared pane from the previous design run (#3421)", async () => {
		// A response adopted from the store is an answer to the backend restore,
		// so the Send that clears the pane leaves it empty. The handler starts no
		// stream, so the held-stream guard is not what keeps the pane empty here.
		const declined = async () => null;
		lastDesign.run = { id: "run_old" };
		lastDesign.report = reportWithEvents("OLD design run");
		useResponseStore.getState().setResponse("A", {
			status: 200,
			statusText: "OK",
			headers: {},
			body: "STORED",
			size: 6,
			time: 5,
		});

		render(renderFor("A", declined));
		expect(ctx().response?.body).toBe("STORED");

		await act(async () => {
			await ctx().executeRequest();
		});
		expect(ctx().response).toBeNull();
	});

	it("does not refill a request whose stored response was adopted on a switch (#3421)", async () => {
		const declined = async () => null;
		lastDesign.run = { id: "run_old" };
		lastDesign.report = reportWithEvents("OLD design run");
		useResponseStore.getState().setResponse("B", {
			status: 200,
			statusText: "OK",
			headers: {},
			body: "STORED B",
			size: 8,
			time: 5,
		});

		const { rerender } = render(renderFor("A", declined));
		// A had nothing stored, so the backend restore answered for it.
		expect(ctx().response?.body).toContain("OLD design run");
		rerender(renderFor("B", declined));
		expect(ctx().response?.body).toBe("STORED B");

		await act(async () => {
			await ctx().executeRequest();
		});
		expect(ctx().response).toBeNull();
	});

	it("does not fill the pane from a design run that loads while the 202 is pending (#3421)", async () => {
		// Nothing stored, so the restore is still waiting on the query when Send
		// clears the pane; the query then answers before the engine does.
		let answer!: (r: StreamStartResult) => void;
		const pending = () => new Promise<StreamStartResult>((r) => (answer = r));
		lastDesign.isLoading = true;
		const { rerender } = render(renderFor("A", pending));
		expect(ctx().response).toBeNull();

		await act(async () => {
			void ctx().executeRequest();
		});
		lastDesign.isLoading = false;
		lastDesign.run = { id: "run_old" };
		lastDesign.report = reportWithEvents("OLD design run");

		// Mutation check: drop `setRestoredFor(executingId)` from the provider's
		// stream branch and this render fills the pane with the old design run.
		rerender(renderFor("A", pending));
		expect(ctx().response).toBeNull();
		expect(ctx().isExecuting).toBe(true);

		await act(async () => {
			answer({ ok: true, runId: "run_1", eventsUrl: "/runs/run_1/events" });
		});
		expect(ctx().response).toBeNull();
		expect(ctx().isStreaming).toBe(true);
	});

	it("does not restore the last design run while the request holds a stream (#3421)", () => {
		lastDesign.run = { id: "run_old" };
		lastDesign.report = reportWithEvents("OLD design run");
		act(() => {
			useExecutionEventsStore.getState().startStream({
				requestId: "A",
				runId: "run_1",
				eventsUrl: "/runs/run_1/events",
			});
		});

		render(renderFor("A", started));

		expect(ctx().response).toBeNull();
	});

	it("follows only the newer of two quick stream sends (#3352)", async () => {
		const answers: Array<(r: StreamStartResult) => void> = [];
		const deferred = () => new Promise<StreamStartResult>((r) => answers.push(r));
		render(renderFor("A", deferred));

		await act(async () => {
			void ctx().executeRequest();
			void ctx().executeRequest();
		});
		await act(async () => {
			answers[1]({ ok: true, runId: "run_2", eventsUrl: "/runs/run_2/events" });
		});
		expect(useExecutionEventsStore.getState().runId).toBe("run_2");

		// Mutation check: drop the provider's `send.isCurrent()` test before
		// `startStream` and the older 202 takes the feed over from the newer run.
		await act(async () => {
			answers[0]({ ok: true, runId: "run_1", eventsUrl: "/runs/run_1/events" });
		});
		expect(useExecutionEventsStore.getState().runId).toBe("run_2");
		expect(ctx().isExecuting).toBe(false);
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

	describe("another request's stream taking the live feed over (#3352)", () => {
		const startedAs = (runId: string) => async (): Promise<StreamStartResult> => ({
			ok: true,
			runId,
			eventsUrl: `/runs/${runId}/events`,
		});
		/** Each replaced request's run, which is what the pane names. */
		const replaced = () =>
			Object.fromEntries(
				Object.entries(useExecutionEventsStore.getState().replacedFeeds).map(
					([requestId, feed]) => [requestId, feed.runId]
				)
			);

		it("records the run it replaced against the request that started it", async () => {
			const { rerender } = render(renderFor("B", startedAs("run_B")));
			await act(async () => {
				await ctx().executeRequest();
			});
			rerender(renderFor("A", startedAs("run_A")));

			// Mutation check: put back the plain `clear()` in the provider's
			// stream branch and B's run is dropped with no record.
			await act(async () => {
				await ctx().executeRequest();
			});
			expect(replaced()).toEqual({ B: "run_B" });
			expect(useExecutionEventsStore.getState().runId).toBe("run_A");
			// The replaced run is left to the engine, not stopped.
			expect(stopRun).not.toHaveBeenCalled();

			// A's own re-send replaces A's feed, not another request's.
			await act(async () => {
				await ctx().executeRequest();
			});
			expect(replaced()).toEqual({ B: "run_B" });
		});

		it.each<[string, () => Promise<StreamStartResult | null>]>([
			[
				"refuses the stream",
				async (): Promise<StreamStartResult> => ({
					ok: false,
					response: {
						status: 0,
						statusText: "Error",
						headers: {},
						body: "refused",
						size: 0,
						time: 0,
					},
				}),
			],
			["is cancelled before it answers", async (): Promise<StreamStartResult | null> => null],
			[
				"throws",
				async (): Promise<StreamStartResult> => {
					throw new Error("engine down");
				},
			],
		])("leaves the live feed with no note when the new stream %s", async (_name, failing) => {
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			const { rerender } = render(renderFor("B", startedAs("run_B")));
			await act(async () => {
				await ctx().executeRequest();
			});
			rerender(renderFor("A", failing));

			// Mutation check: record in `handOver` again and B's pane claims
			// a stream took its feed over although A's never opened.
			await act(async () => {
				await ctx().executeRequest();
			});
			expect(replaced()).toEqual({});
			// The old feed is still dropped, as before.
			expect(useExecutionEventsStore.getState().runId).toBeNull();
			logged.mockRestore();
		});

		it("forgets the record when that request streams again", async () => {
			const { rerender } = render(renderFor("B", startedAs("run_B")));
			await act(async () => {
				await ctx().executeRequest();
			});
			rerender(renderFor("A", startedAs("run_A")));
			await act(async () => {
				await ctx().executeRequest();
			});
			rerender(renderFor("B", startedAs("run_B2")));

			// Mutation check: drop the provider's `beginSend` call and B's
			// own new stream still carries the note about the old one.
			await act(async () => {
				await ctx().executeRequest();
			});
			expect(replaced()).toEqual({ A: "run_A" });
		});

		it("forgets the record when that request sends without a stream", async () => {
			useExecutionEventsStore.setState({
				replacedFeeds: { B: { runId: "run_B", sent: null, leftOut: [], finalized: false } },
			});
			const answered: ResponseState = {
				status: 200,
				statusText: "OK",
				headers: {},
				body: "",
				size: 0,
				time: 1,
			};
			render(
				<TestQueryClient>
					<RequestBuilderProvider
						initialRequest={{ id: "B", name: "B" } as Partial<RequestState>}
						onExecute={async () => answered}
						onExecuteStream={started}
					>
						<Capture />
					</RequestBuilderProvider>
				</TestQueryClient>
			);

			await act(async () => {
				await ctx().executeRequest();
			});
			expect(replaced()).toEqual({});
		});
	});

	describe("a stream that ends while another request is on screen (#3382)", () => {
		const startedAs = (runId: string) => async (): Promise<StreamStartResult> => ({
			ok: true,
			runId,
			eventsUrl: `/runs/${runId}/events`,
		});
		const bodyOf = (id: string) =>
			(useResponseStore.getState().getResponse(id) as ResponseState | null)?.body;
		const lastDesignInvalidated = (id: string) =>
			invalidateQueries.mock.calls.some(
				([filter]) =>
					JSON.stringify(filter) === JSON.stringify({ queryKey: ["runs", "last", id] })
			);

		it("stores the run under its own request, leaves the one on screen alone and tells the query", async () => {
			getRunReport.mockResolvedValue(reportWithEvents("A stored"));
			const bResponse: ResponseState = {
				status: 200,
				statusText: "OK",
				headers: {},
				body: "B own",
				size: 5,
				time: 1,
			};
			useResponseStore.getState().setResponse("B", bResponse);
			const { rerender } = render(renderFor("A", started));
			await act(async () => {
				await ctx().executeRequest();
			});
			rerender(renderFor("B", started));
			expect(ctx().response?.body).toBe("B own");

			// Mutation check: select the stream through the on-screen request again
			// (`s.requestId === requestId`) and this never runs for A.
			act(() => {
				useExecutionEventsStore.getState().endStream("run_1", "completed", 9);
			});
			await waitFor(() => expect(bodyOf("A")).toBe("A stored"));
			await waitFor(() => expect(lastDesignInvalidated("A")).toBe(true));
			expect(ctx().response?.body).toBe("B own");
			expect(bodyOf("B")).toBe("B own");

			// Back on A, the response is the stream's, fetched once.
			rerender(renderFor("A", started));
			expect(ctx().response?.body).toBe("A stored");
			expect(getRunReport).toHaveBeenCalledTimes(1);
		});

		it("still lands when another request's stream empties the store mid-fetch", async () => {
			let release!: (report: ReturnType<typeof reportWithEvents>) => void;
			getRunReport.mockReturnValue(new Promise((r) => (release = r)));
			const { rerender } = render(renderFor("A", startedAs("run_A")));
			await act(async () => {
				await ctx().executeRequest();
			});
			act(() => {
				useExecutionEventsStore.getState().endStream("run_A", "completed", 9);
			});
			await waitFor(() => expect(getRunReport).toHaveBeenCalledWith("run_A"));

			rerender(renderFor("B", startedAs("run_B")));
			await act(async () => {
				await ctx().executeRequest();
			});
			expect(useExecutionEventsStore.getState().runId).toBe("run_B");

			// Mutation check: return a cleanup that sets a `cancelled` flag from the
			// effect and the handOver above drops the report on the floor.
			await act(async () => {
				release(reportWithEvents("A stored"));
			});
			await waitFor(() => expect(bodyOf("A")).toBe("A stored"));
			expect(lastDesignInvalidated("A")).toBe(true);
			// B's own stream is untouched.
			expect(ctx().isStreaming).toBe(true);
			expect(bodyOf("B")).toBeUndefined();
		});

		it("does not write the ended run over a newer send of the same request", async () => {
			let release!: (report: ReturnType<typeof reportWithEvents>) => void;
			getRunReport.mockReturnValue(new Promise((r) => (release = r)));
			let next = "run_1";
			render(renderFor("A", async () => startedAs(next)()));
			await act(async () => {
				await ctx().executeRequest();
			});
			act(() => {
				useExecutionEventsStore.getState().endStream("run_1", "completed", 9);
			});
			await waitFor(() => expect(getRunReport).toHaveBeenCalledWith("run_1"));

			// A sends again and its stream has not opened yet: the store is empty,
			// so only the send itself says the ended run is no longer current.
			next = "run_2";
			await act(async () => {
				await ctx().executeRequest();
			});

			// Mutation check: drop the `sendCounts` comparison in
			// `finalizeStreamRun` and the old run's
			// report lands over the response the new send cleared.
			await act(async () => {
				release(reportWithEvents("old run"));
			});
			await waitFor(() => expect(lastDesignInvalidated("A")).toBe(true));
			expect(bodyOf("A")).toBeUndefined();
			expect(ctx().response).toBeNull();
		});

		it("lands a run whose feed another request took over, once the engine ends it", async () => {
			// The poll is the code's own delay, so the clock is the test's.
			vi.useFakeTimers();
			getRun
				.mockResolvedValueOnce({ id: "run_B", status: "running" })
				.mockResolvedValue({ id: "run_B", status: "completed" });
			getRunReport.mockResolvedValue(reportWithEvents("B stored"));
			const { rerender } = render(renderFor("B", startedAs("run_B")));
			await act(async () => {
				await ctx().executeRequest();
			});
			rerender(renderFor("A", startedAs("run_A")));
			await act(async () => {
				await ctx().executeRequest();
			});
			act(() => {
				useExecutionEventsStore
					.getState()
					.addEvents("run_A", [{ event: "token", data: "a" }]);
			});

			// Still running at the engine: watched, not finalized.
			await act(() => vi.advanceTimersByTimeAsync(0));
			expect(getRun).toHaveBeenCalledWith("run_B");
			expect(getRunReport).not.toHaveBeenCalled();

			// Mutation check: watch no replaced feed in `useStreamFinalization`
			// and B's run never reaches B's stored response.
			await act(() => vi.advanceTimersByTimeAsync(RUN_IN_PROGRESS_POLL_MS));
			await vi.waitFor(() => expect(bodyOf("B")).toBe("B stored"));
			expect(getRunReport).toHaveBeenCalledWith("run_B");
			expect(lastDesignInvalidated("B")).toBe(true);
			// Mutation check: drop `sent` from `displacedByHandOver` and B's Send
			// snapshot is lost at the hand-over.
			const storedB = useResponseStore.getState().getResponse("B") as ResponseState | null;
			expect(storedB?.sentRequest?.url).toBeDefined();
			// A's live feed is untouched, and so is the pane on screen.
			expect(useExecutionEventsStore.getState()).toMatchObject({
				requestId: "A",
				runId: "run_A",
				isStreaming: true,
			});
			expect(useExecutionEventsStore.getState().events).toEqual([
				{ event: "token", data: "a" },
			]);
			expect(ctx().response).toBeNull();
			expect(bodyOf("A")).toBeUndefined();
		});

		it("does not finalize again after the builder remounts", async () => {
			// `Shell.tsx` unmounts the builder on every tab that is not a request.
			getRunReport.mockResolvedValue(reportWithEvents("A stored"));
			const first = render(renderFor("A", started));
			await act(async () => {
				await ctx().executeRequest();
			});
			act(() => {
				useExecutionEventsStore.getState().endStream("run_1", "completed", 9);
			});
			await waitFor(() => expect(bodyOf("A")).toBe("A stored"));
			first.unmount();

			const newer: ResponseState = {
				status: 201,
				statusText: "Created",
				headers: {},
				body: "newer",
				size: 5,
				time: 1,
			};
			useResponseStore.getState().setResponse("A", newer);

			// Mutation check: drop the `finalized` test in `claimableRun` (the
			// marker a provider ref used to hold) and the remount fetches the
			// ended run again and writes it over the newer response.
			render(renderFor("A", started));
			await act(async () => {});
			expect(getRunReport).toHaveBeenCalledTimes(1);
			expect(bodyOf("A")).toBe("newer");
			expect(ctx().response?.body).toBe("newer");
		});

		it("fetches again on the next mount when the report could not be read", async () => {
			getRunReport
				.mockRejectedValueOnce(new Error("engine went away"))
				.mockResolvedValue(reportWithEvents("A stored"));
			const first = render(renderFor("A", started));
			await act(async () => {
				await ctx().executeRequest();
			});
			act(() => {
				useExecutionEventsStore.getState().endStream("run_1", "completed", 9);
			});
			// The invalidations fire either way.
			await waitFor(() => expect(lastDesignInvalidated("A")).toBe(true));
			expect(bodyOf("A")).toBeUndefined();
			first.unmount();

			// Mutation check: make `releaseFinalization` a no-op and the failed
			// fetch is the last one ever made for this run.
			render(renderFor("A", started));
			await waitFor(() => expect(bodyOf("A")).toBe("A stored"));
			expect(getRunReport).toHaveBeenCalledTimes(2);
			expect(ctx().response?.body).toBe("A stored");
		});

		it("is not done by the History run view's provider", async () => {
			// DesignRunView's shape: a detached copy with no id and no stream
			// handler, filed under its run id.
			getRun.mockResolvedValue({ id: "run_B", status: "completed" });
			getRunReport.mockResolvedValue(reportWithEvents("stored"));
			act(() => {
				const events = useExecutionEventsStore.getState();
				events.startStream({
					requestId: "B",
					runId: "run_B",
					eventsUrl: "/runs/run_B/events",
				});
				events.handOver("A");
				events.startStream({
					requestId: "A",
					runId: "run_A",
					eventsUrl: "/runs/run_A/events",
				});
				events.endStream("run_A", "completed", 1);
			});

			// Mutation check: enable `useStreamFinalization` unconditionally and
			// this provider fetches and invalidates for requests it never sent.
			render(
				<TestQueryClient>
					<RequestBuilderProvider
						initialRequest={{ id: null, name: "copy" } as Partial<RequestState>}
						memoryKey="run_history"
						collectionId={null}
						onExecute={async () => null}
					>
						<Capture />
					</RequestBuilderProvider>
				</TestQueryClient>
			);
			await act(async () => {});

			expect(getRunReport).not.toHaveBeenCalled();
			expect(getRun).not.toHaveBeenCalled();
			expect(invalidateQueries).not.toHaveBeenCalled();
			expect(useExecutionEventsStore.getState().finalized).toBe(false);
		});
	});

	describe("the elements the Send left out (#3066)", () => {
		const LEFT_OUT = [
			{
				element: { id: "el_1", kind: "assert.status", enabled: true, config: {} },
				needs: { missing: ["accepted codes or a range"], invalid: {} },
			},
		];
		const startedWithLeftOut = async (): Promise<StreamStartResult> => ({
			ok: true,
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
			leftOut: LEFT_OUT,
		});

		it("hands them to the store for the live pane", async () => {
			render(renderFor("A", startedWithLeftOut));

			await act(async () => {
				await ctx().executeRequest();
			});

			expect(useExecutionEventsStore.getState().leftOut).toEqual(LEFT_OUT);
		});

		it("puts them on the stored response that replaces the live one", async () => {
			getRunReport.mockResolvedValue(reportWithEvents("stored body"));
			render(renderFor("A", startedWithLeftOut));

			await act(async () => {
				await ctx().executeRequest();
			});
			act(() => {
				useExecutionEventsStore.getState().endStream("run_1", "completed", 9);
			});

			await waitFor(() => expect(ctx().response?.body).toBe("stored body"));
			expect(ctx().response?.leftOutElements).toEqual(LEFT_OUT);
			const stored = useResponseStore.getState().getResponse("A") as ResponseState | null;
			expect(stored?.leftOutElements).toEqual(LEFT_OUT);
		});

		it("leaves the stored response without the field when nothing was left out", async () => {
			getRunReport.mockResolvedValue(reportWithEvents("stored body"));
			render(renderFor("A", started));

			await act(async () => {
				await ctx().executeRequest();
			});
			act(() => {
				useExecutionEventsStore.getState().endStream("run_1", "completed", 9);
			});

			await waitFor(() => expect(ctx().response?.body).toBe("stored body"));
			expect(ctx().response).not.toHaveProperty("leftOutElements");
		});
	});
});
