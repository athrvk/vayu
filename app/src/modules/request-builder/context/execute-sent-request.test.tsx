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
 * A response carries the request as it was at Send (issue #1763).
 *
 * Save-as-example forwards `response.sentRequest` so a Postman export writes
 * the request that produced the response. The snapshot is only worth that if
 * it is taken at the press of Send: a user who edits the URL while the
 * response is in flight - or while reading it - must still save the request
 * that ran. Both send paths are pinned, because each attaches it differently:
 *
 * - **Buffered.** The snapshot is merged into the `/execute` result as it
 *   lands.
 * - **Stream.** The response only exists once the run is stored, so the
 *   snapshot waits, keyed by the run it belongs to, for the stream-end swap -
 *   and is never attached to the report of a different run.
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
	useVariableWriter: () => ({ updateVariable: vi.fn(), writableScopes: [] }),
	useSaveManager: () => ({ forceSave: vi.fn(), status: "idle", isSaving: false }),
}));

vi.mock("@/lib/query-client", () => ({ queryClient: { invalidateQueries: vi.fn() } }));

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
	queryKeys: {
		runs: { lists: () => ["runs"], recentDesign: (id: string) => ["runs", "recent", id] },
	},
}));

const getRunReport = vi.fn();
vi.mock("@/services", () => ({ apiService: { getRunReport, stopRun: vi.fn() } }));

// The relay is driven by hand below; the hook only owns the socket, and jsdom
// has no `EventSource`.
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

const URL_A = "{{baseUrl}}/users/:id";
const URL_B = "https://edited.example.test/other";

function response(tag: string): ResponseState {
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

/** An onExecute whose promise the test resolves by hand. */
function deferredExecute() {
	let resolve!: (r: ResponseState | null) => void;
	const fn = vi.fn(() => new Promise<ResponseState | null>((r) => (resolve = r)));
	return { fn, resolve: (r: ResponseState | null) => resolve(r) };
}

function reportFor(runId: string) {
	return {
		results: [
			{
				timestamp: 1_750_000_000_000,
				statusCode: 200,
				statusText: "OK",
				latencyMs: 5,
				trace: {
					request: { method: "GET", url: `https://api.example.test/${runId}` },
					response: { headers: {}, body: runId },
					events: { items: [], totalEvents: 0, endReason: "completed" as const },
				},
			},
		],
	};
}

describe("a response carries the request as it was at Send", () => {
	beforeEach(() => {
		useResponseStore.getState().clearAll();
		useExecutionEventsStore.getState().clear();
		getRunReport.mockReset();
	});

	it("buffered: keeps the URL that was sent, not the one edited while in flight", async () => {
		const exec = deferredExecute();
		render(
			<RequestBuilderProvider
				initialRequest={
					{
						id: "A",
						name: "A",
						method: "POST",
						url: URL_A,
					} as Partial<RequestState>
				}
				onExecute={exec.fn}
			>
				<Capture />
			</RequestBuilderProvider>
		);

		await act(async () => {
			void ctx().executeRequest();
		});
		act(() => {
			ctx().updateField("url", URL_B);
		});
		await act(async () => {
			exec.resolve(response("ANSWER"));
		});
		await waitFor(() => expect(ctx().response?.body).toBe("ANSWER"));

		expect(ctx().request.url).toBe(URL_B);
		expect(ctx().response?.sentRequest).toMatchObject({
			method: "POST",
			url: URL_A,
			body: { mode: "none" },
		});
		// The durable copy too: returning to the request later still saves
		// the request that ran.
		const stored = useResponseStore.getState().getResponse("A") as ResponseState | null;
		expect(stored?.sentRequest?.url).toBe(URL_A);
	});

	it("buffered: an unsaved request takes no snapshot, having nowhere to save one", async () => {
		const exec = deferredExecute();
		render(
			<RequestBuilderProvider
				initialRequest={{ name: "draft", url: URL_A } as Partial<RequestState>}
				onExecute={exec.fn}
			>
				<Capture />
			</RequestBuilderProvider>
		);

		await act(async () => {
			void ctx().executeRequest();
		});
		await act(async () => {
			exec.resolve(response("ANSWER"));
		});
		await waitFor(() => expect(ctx().response?.body).toBe("ANSWER"));
		expect(ctx().response?.sentRequest).toBeUndefined();
	});

	it("stream: attaches the Send snapshot to the stored run when the stream ends", async () => {
		getRunReport.mockResolvedValue(reportFor("run_1"));
		const onExecuteStream = vi.fn(async (): Promise<StreamStartResult> => ({
			ok: true,
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		}));
		render(
			<RequestBuilderProvider
				initialRequest={
					{ id: "A", name: "A", url: URL_A, stream: true } as Partial<RequestState>
				}
				onExecute={async () => null}
				onExecuteStream={onExecuteStream}
			>
				<Capture />
			</RequestBuilderProvider>
		);

		await act(async () => {
			await ctx().executeRequest();
		});
		act(() => {
			ctx().updateField("url", URL_B);
		});
		act(() => {
			useExecutionEventsStore.getState().endStream("run_1", "completed", 0);
		});

		await waitFor(() => expect(ctx().response?.body).toBe("run_1"));
		expect(ctx().response?.sentRequest?.url).toBe(URL_A);
		const stored = useResponseStore.getState().getResponse("A") as ResponseState | null;
		expect(stored?.sentRequest?.url).toBe(URL_A);
	});

	it("stream: never attaches the snapshot to a different run's response", async () => {
		getRunReport.mockResolvedValue(reportFor("run_other"));
		const onExecuteStream = vi.fn(async (): Promise<StreamStartResult> => ({
			ok: true,
			runId: "run_1",
			eventsUrl: "/runs/run_1/events",
		}));
		render(
			<RequestBuilderProvider
				initialRequest={
					{ id: "A", name: "A", url: URL_A, stream: true } as Partial<RequestState>
				}
				onExecute={async () => null}
				onExecuteStream={onExecuteStream}
			>
				<Capture />
			</RequestBuilderProvider>
		);

		await act(async () => {
			await ctx().executeRequest();
		});
		// Another run takes over the store for this request - the snapshot
		// taken for run_1 describes a request that did not produce it.
		act(() => {
			useExecutionEventsStore.getState().startStream({
				requestId: "A",
				runId: "run_other",
				eventsUrl: "/runs/run_other/events",
			});
		});
		act(() => {
			useExecutionEventsStore.getState().endStream("run_other", "completed", 0);
		});

		await waitFor(() => expect(ctx().response?.body).toBe("run_other"));
		expect(ctx().response?.sentRequest).toBeUndefined();
	});
});
