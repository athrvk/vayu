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
 * The builder stops writing Vayu's headers, and starts refusing them (#1229).
 *
 * Two halves, and each is a defect that shipped:
 *
 * - **The save no longer launders the old rows back in.** The renderer used to
 *   inject `X-Request-ID` and `X-Vayu-Version` at send time *and* re-impose
 *   `User-Agent` / `X-Vayu-Version` / `X-Request-ID` on load, so opening a
 *   request saved by an older build and letting autosave fire wrote them
 *   straight back. The strip is on the load side now (`toHeaderItems`); the
 *   save is clean because state is. Delete that strip and the first case here
 *   fails, which is the point of driving the save through the real component
 *   rather than the two helpers on their own.
 * - **The opt-out reaches the wire.** A tick in the Headers tab is worth
 *   nothing if the field is dropped between editor state and `POST /execute`,
 *   `POST /execute` (stream) or `POST /runs`. All three carry it, and none
 *   carries it when nothing is switched off.
 *
 * Never sent and never stored are different claims: the send cases assert the
 * *absence* of the field, not an empty array.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { KeyValueEntry, LoadTestConfig } from "@/types";
import type { RequestState } from "./types";

const composeRequest = vi.fn();
const executeRequest = vi.fn();
const executeStreamRequest = vi.fn();
const startLoadTest = vi.fn();
const updateRequest = vi.fn();

/** A UUID of the exact shape the old renderer generated per send. */
const GENERATED_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const BROWSER_AGENT = "Mozilla/5.0 (X11; Linux x86_64)";

/** A request stored by a pre-#1229 build, with two lookalikes beside the rows it wrote. */
const STORED_HEADERS: KeyValueEntry[] = [
	{ key: "Accept", value: "application/json", enabled: true },
	{ key: "User-Agent", value: "Vayu/0.9.0", enabled: true },
	{ key: "X-Vayu-Version", value: "0.9.0", enabled: true },
	{ key: "X-Request-ID", value: GENERATED_ID, enabled: true },
];

let storedHeaders: KeyValueEntry[] = STORED_HEADERS;

const requestQuery = {
	get data() {
		return {
			id: "req_1",
			collectionId: "col_1",
			name: "Get user",
			method: "GET",
			url: "https://api.test/u",
			params: [],
			headers: storedHeaders,
			body: { mode: "none" },
			auth: { mode: "none" },
			preRequestScript: "",
			postRequestScript: "",
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
		useUpdateRequestMutation: () => ({ mutateAsync: updateRequest, mutate: vi.fn() }),
		useCollectionAncestors: () => [],
	};
});

vi.mock("@/hooks", () => ({
	useEngine: () => ({ composeRequest, executeRequest }),
	useVariableResolver: () => ({ resolveObject: <T,>(value: T) => value }),
}));

vi.mock("@/services", () => ({
	apiService: { startLoadTest, executeStreamRequest },
	loadTestService: { startMonitoring: vi.fn() },
}));

let providerProps: Record<string, unknown> = {};
let dialogProps: Record<string, unknown> = {};

vi.mock("./context", () => ({
	RequestBuilderProvider: (props: Record<string, unknown>) => {
		providerProps = props;
		return null;
	},
}));
vi.mock("./components/RequestBuilderLayout", () => ({ default: () => null }));
vi.mock("./components/LoadTestCommandSurface", () => ({ default: () => null }));
vi.mock("./components/SendRequestCommandSurface", () => ({ default: () => null }));
vi.mock("./components/LoadTestConfigDialog", () => ({
	default: (props: Record<string, unknown>) => {
		dialogProps = props;
		return null;
	},
}));

const { default: RequestBuilder } = await import("./index");

const LOAD_CONFIG: LoadTestConfig = { mode: "constant_rps", duration_seconds: 10, rps: 5 };

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(<RequestBuilder />, { wrapper });
}

/**
 * The editor state the builder seeded from the stored request, which is what
 * the user would then save or send. Taken from the provider's own prop rather
 * than rebuilt here, so the load-time strip is genuinely in the path.
 */
function seededState(overrides: Partial<RequestState> = {}): RequestState {
	const initial = providerProps.initialRequest as Partial<RequestState>;
	return { ...(initial as RequestState), disabledDefaultHeaders: [], ...overrides };
}

beforeEach(() => {
	storedHeaders = STORED_HEADERS;
	composeRequest.mockReset().mockResolvedValue({ method: "GET", url: "https://api.test/u" });
	executeRequest.mockReset().mockResolvedValue({ status: 200, body: "", bodyRaw: "" });
	executeStreamRequest
		.mockReset()
		.mockResolvedValue({ runId: "run_1", eventsUrl: "/runs/run_1/events" });
	startLoadTest.mockReset().mockResolvedValue({ runId: "run_1" });
	updateRequest.mockReset().mockResolvedValue({});
	providerProps = {};
	dialogProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.getState().setStreaming(false);
});

describe("saving a request loaded from rows an older build wrote", () => {
	async function save(state: RequestState) {
		await act(async () => {
			await (providerProps.onSave as (r: RequestState) => Promise<void>)(state);
		});
		return updateRequest.mock.calls[0][0] as Record<string, unknown>;
	}

	it("writes none of them back", async () => {
		renderBuilder();
		const patch = await save(seededState());

		const keys = (patch.headers as KeyValueEntry[]).map((h) => h.key);
		expect(keys).toEqual(["Accept"]);
	});

	it("keeps the headers that only look like them", async () => {
		// The narrow half of the rule: a browser User-Agent and a correlation id
		// someone typed are the user's, and a testing tool that ate them would
		// be worse than the bug this fixes.
		storedHeaders = [
			{ key: "User-Agent", value: BROWSER_AGENT, enabled: true },
			{ key: "X-Request-ID", value: "order-42", enabled: true },
		];
		renderBuilder();
		const patch = await save(seededState());

		const written = new Map((patch.headers as KeyValueEntry[]).map((h) => [h.key, h.value]));
		expect(written.get("User-Agent")).toBe(BROWSER_AGENT);
		expect(written.get("X-Request-ID")).toBe("order-42");
	});

	it("never persists the per-send opt-outs", async () => {
		renderBuilder();
		const patch = await save(seededState({ disabledDefaultHeaders: ["User-Agent"] }));

		expect(patch).not.toHaveProperty("disabledDefaultHeaders");
	});
});

describe("the opt-out on the wire", () => {
	it("rides the buffered send", async () => {
		renderBuilder();
		const onExecute = providerProps.onExecute as (r: RequestState) => Promise<unknown>;

		await act(async () => {
			await onExecute(seededState({ disabledDefaultHeaders: ["User-Agent"] }));
		});

		expect(executeRequest.mock.calls[0][0].disabledDefaultHeaders).toEqual(["User-Agent"]);
	});

	it("rides the stream, which must send what the buffered send sends", async () => {
		renderBuilder();
		const onStream = providerProps.onExecuteStream as (r: RequestState) => Promise<unknown>;

		await act(async () => {
			await onStream(seededState({ disabledDefaultHeaders: ["Accept-Encoding"] }));
		});

		expect(executeStreamRequest.mock.calls[0][0].disabledDefaultHeaders).toEqual([
			"Accept-Encoding",
		]);
	});

	it("rides the load run, which would otherwise measure a different request", async () => {
		renderBuilder();
		await act(async () => {
			(providerProps.onStartLoadTest as (r: RequestState) => void)(
				seededState({ disabledDefaultHeaders: ["Accept-Encoding", "User-Agent"] })
			);
		});
		await act(async () => {
			await (dialogProps.onStart as (c: LoadTestConfig) => Promise<void>)(LOAD_CONFIG);
		});

		expect(startLoadTest.mock.calls[0][0].disabledDefaultHeaders).toEqual([
			"Accept-Encoding",
			"User-Agent",
		]);
	});

	it("is absent from all three when nothing is switched off", async () => {
		// Absent, not `[]`: a send refusing nothing is the payload sent before
		// the field existed.
		renderBuilder();
		const state = seededState();

		await act(async () => {
			await (providerProps.onExecute as (r: RequestState) => Promise<unknown>)(state);
			await (providerProps.onExecuteStream as (r: RequestState) => Promise<unknown>)(state);
			(providerProps.onStartLoadTest as (r: RequestState) => void)(state);
		});
		await act(async () => {
			await (dialogProps.onStart as (c: LoadTestConfig) => Promise<void>)(LOAD_CONFIG);
		});

		expect(executeRequest.mock.calls[0][0]).not.toHaveProperty("disabledDefaultHeaders");
		expect(executeStreamRequest.mock.calls[0][0]).not.toHaveProperty("disabledDefaultHeaders");
		expect(startLoadTest.mock.calls[0][0]).not.toHaveProperty("disabledDefaultHeaders");
	});

	it("puts no Vayu header on the composed request either", async () => {
		// The send-time injection is gone too, not only the stored copy: the
		// engine adds these on every path now, so a client adding its own would
		// be the disagreement #1229 removes.
		renderBuilder();

		await act(async () => {
			await (providerProps.onExecute as (r: RequestState) => Promise<unknown>)(seededState());
		});

		const headers = (composeRequest.mock.calls[0][0] as { request: { headers: object } })
			.request.headers;
		expect(Object.keys(headers)).toEqual(["Accept"]);
	});
});
