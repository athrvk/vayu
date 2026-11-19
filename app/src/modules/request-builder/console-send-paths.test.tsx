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
 * Both Send completions append to the session Console (#3634), and the same
 * exchange gives the same rows whichever completion reports it: the buffered
 * Send's `/execute` answer (`handleExecute`) and a stream's stored run
 * (`finalizeStreamRun`). A field one path writes and the other does not is
 * this codebase's most repeated defect, so the two are compared, not just each
 * checked.
 *
 * Mutation check: remove the `appendSendToConsole` call from `handleExecute`
 * and "the buffered Send appends its rows" fails; remove the one in
 * `finalizeStreamRun` and "a finished stream appends its rows" fails; move it
 * below the `overtaken` test and "appends a stream a newer Send overtook"
 * fails.
 *
 * Mutation check for the dialled URL (#3650): have `handleExecute` read
 * `composed.url` / `composed.method` again and "lists the URL the script
 * retargeted the send to" fails; drop the `??` fallback and "falls back to the
 * composed request" fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore, useConsoleStore } from "@/stores";
import { useExecutionEventsStore } from "@/stores/execution-events-store";
import type { RunReport, SanityResult } from "@/types";
import type { RequestState, ResponseState } from "./types";

const composeRequest = vi.fn();
const executeRequest = vi.fn();
const getRunReport = vi.fn();

const requestQuery = {
	get data() {
		return {
			id: "req_1",
			collectionId: "col_1",
			name: "Get token",
			method: "POST",
			url: "https://api.test/token",
			params: [],
			headers: [],
			body: { mode: "json", content: '{"a":1}' },
			auth: { mode: "none" },
			elements: [],
			followRedirects: true,
			maxRedirects: 10,
			httpVersion: "auto",
			verifySSL: true,
			stream: false,
		} as unknown;
	},
	isLoading: false,
	isError: false,
	error: null as unknown,
	refetch: vi.fn(),
};

vi.mock("@/queries", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/queries")>();
	return {
		...actual,
		useRequestQuery: () => requestQuery,
		useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn() }),
		useCollectionAncestors: () => [],
	};
});

vi.mock("@/hooks", () => ({
	useEngine: () => ({ composeRequest, executeRequest }),
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) => value,
		resolveString: (value: string) => value,
	}),
}));

vi.mock("@/services", () => ({
	apiService: { getRunReport, startLoadTest: vi.fn(), executeStreamRequest: vi.fn() },
	loadTestService: { startMonitoring: vi.fn() },
}));

let providerProps: Record<string, unknown> = {};

vi.mock("./context", () => ({
	RequestBuilderProvider: (props: Record<string, unknown>) => {
		providerProps = props;
		return null;
	},
}));
vi.mock("./components/RequestBuilderLayout", () => ({ default: () => null }));
vi.mock("./components/LoadTestCommandSurface", () => ({ default: () => null }));
vi.mock("./components/SendRequestCommandSurface", () => ({ default: () => null }));
vi.mock("./components/LoadTestConfigDialog", () => ({ default: () => null }));

const { default: RequestBuilder } = await import("./index");
const { finalizeStreamRun } = await import("./context/stream-finalization");
const { responseFromExecuteResult } = await import("./utils/execute-mapping");

/** One exchange, as both completions see it. */
const METHOD = "POST";
const URL = "https://u:pw@api.test/token?access_token=AT";
const RAW_REQUEST =
	"POST /token?access_token=AT HTTP/1.1\r\nHost: api.test\r\nX-Tenant-Key: K\r\n\r\n" + '{"a":1}';
const REQUEST_HEADERS = { "X-Tenant-Key": "K", "Content-Type": "application/json" };
const RESPONSE_HEADERS = { "content-type": "application/json", "set-cookie": "sid=1" };
const BODY = '{"token":"issued"}';
const PHASES = { dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 20, downloadMs: 4 };
const PROVENANCE = { authHeaders: ["X-Tenant-Key"], authQueryParam: "access_token" };

const executeAnswer = {
	method: METHOD,
	url: URL,
	status: 200,
	statusText: "OK",
	headers: RESPONSE_HEADERS,
	requestHeaders: REQUEST_HEADERS,
	rawRequest: RAW_REQUEST,
	body: null,
	bodyRaw: BODY,
	bodySize: BODY.length,
	timing: { totalMs: 30, ...PHASES },
	...PROVENANCE,
} as unknown as SanityResult;

const storedReport = {
	results: [
		{
			timestamp: 1_700_000_000_000,
			statusCode: 200,
			statusText: "OK",
			latencyMs: 30,
			trace: {
				...PHASES,
				request: {
					method: METHOD,
					url: URL,
					headers: REQUEST_HEADERS,
					rawRequest: RAW_REQUEST,
					...PROVENANCE,
				},
				response: { headers: RESPONSE_HEADERS, body: BODY, bodyBytes: BODY.length },
			},
		},
	],
} as unknown as RunReport;

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(<RequestBuilder />, { wrapper });
}

async function sendBuffered() {
	renderBuilder();
	const initial = providerProps.initialRequest as RequestState;
	await act(async () => {
		await (providerProps.onExecute as (r: RequestState) => Promise<ResponseState | null>)({
			...initial,
			disabledDefaultHeaders: [],
		});
	});
}

/** The store as a finished stream of `req_1` leaves it, ready to be claimed once. */
function streamEnded(runId: string) {
	useExecutionEventsStore.setState({
		runId,
		requestId: "req_1",
		endReason: "completed",
		finalized: false,
		sendCounts: { req_1: 1 },
	});
}

/** The rows without what the ring stamps and what only a stream learns. */
const comparable = () =>
	useConsoleStore.getState().rows.map((row) => {
		const { id: _id, at: _at, ...rest } = row;
		if (rest.kind !== "send") return rest;
		const { runId: _runId, ...withoutRun } = rest;
		return withoutRun;
	});

beforeEach(() => {
	composeRequest.mockReset().mockResolvedValue({ method: METHOD, url: URL, headers: [] });
	executeRequest.mockReset().mockResolvedValue(executeAnswer);
	getRunReport.mockReset().mockResolvedValue(storedReport);
	providerProps = {};
	useConsoleStore.getState().clear();
	useExecutionEventsStore.getState().clear();
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.setState({ phase: { phase: "idle" } });
});

describe("the session Console's two send paths", () => {
	it("the buffered Send appends its rows, masked", async () => {
		await sendBuffered();

		const rows = useConsoleStore.getState().rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "send",
			method: "POST",
			url: "https://u@api.test/token?access_token=<redacted>",
			status: 200,
			timeMs: 30,
			sizeBytes: BODY.length,
			requestId: "req_1",
		});
		expect(rows[0]).not.toHaveProperty("runId");
	});

	it("lists the method and URL the script retargeted the send to, masked", async () => {
		executeRequest.mockResolvedValue({
			...executeAnswer,
			method: "PUT",
			url: "https://u:pw@moved.test/v2?access_token=AT&page=2",
		});

		await sendBuffered();

		const rows = useConsoleStore.getState().rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "send",
			method: "PUT",
			url: "https://u@moved.test/v2?access_token=<redacted>&page=2",
		});
	});

	it("falls back to the composed request when the answer carries no method or URL", async () => {
		executeRequest.mockResolvedValue({ ...executeAnswer, method: undefined, url: undefined });

		await sendBuffered();

		expect(useConsoleStore.getState().rows[0]).toMatchObject({
			kind: "send",
			method: "POST",
			url: "https://u@api.test/token?access_token=<redacted>",
		});
	});

	it("a Send that gets no answer is still listed, with its error", async () => {
		executeRequest.mockReset().mockRejectedValue(new Error("engine is down"));

		await sendBuffered();

		const rows = useConsoleStore.getState().rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "send",
			status: 0,
			errorCode: "ENGINE_ERROR",
			errorMessage: "engine is down",
		});
	});

	it("a finished stream appends its rows, under its run", async () => {
		streamEnded("run_1");
		await finalizeStreamRun("run_1", vi.fn());

		const rows = useConsoleStore.getState().rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "send", runId: "run_1", requestId: "req_1" });
	});

	it("the same exchange gives the same rows on both paths", async () => {
		await sendBuffered();
		const buffered = comparable();

		useConsoleStore.getState().clear();
		streamEnded("run_1");
		await finalizeStreamRun("run_1", vi.fn());

		expect(buffered).toHaveLength(1);
		expect(comparable()).toEqual(buffered);
	});

	it("appends a stream a newer Send overtook, and lands nothing", async () => {
		streamEnded("run_1");
		getRunReport.mockImplementation(async () => {
			useExecutionEventsStore.setState({ sendCounts: { req_1: 2 } });
			return storedReport;
		});
		const land = vi.fn();
		await finalizeStreamRun("run_1", land);

		expect(land).not.toHaveBeenCalled();
		expect(useConsoleStore.getState().rows).toHaveLength(1);
	});

	it("appends one stream once, however often it is finalized", async () => {
		streamEnded("run_1");
		await finalizeStreamRun("run_1", vi.fn());
		await finalizeStreamRun("run_1", vi.fn());

		expect(useConsoleStore.getState().rows).toHaveLength(1);
	});

	it("mapping an answer alone appends nothing, so a History replay is not listed", () => {
		responseFromExecuteResult(executeAnswer);
		expect(useConsoleStore.getState().rows).toEqual([]);
	});
});
