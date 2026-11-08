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
 * The builder's half of "one load run owns the live stream" (#3351): Load test
 * asks `canStartLoadRun` before the dialog opens and again before `POST /runs`,
 * and a refusal opens the running run and names it. The gate's own answers are
 * `stores/run-gate.test.ts`; this pins that the builder asks it, at both
 * points, and never starts an engine run past a refusal.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
	isDashboardRunLive,
	useTabsStore,
	useSessionStore,
	useDashboardStore,
	useScenarioRunStore,
	useToastStore,
} from "@/stores";
import type { LoadTestConfig } from "@/types";
import type { RequestState } from "./types";

const LOAD_CONFIG: LoadTestConfig = { mode: "constant_rps", duration_seconds: 10, rps: 5 };

const composeRequest = vi.fn();
const executeRequest = vi.fn();
const startLoadTest = vi.fn();

const requestQuery = {
	data: {
		id: "req_1",
		collectionId: "col_1",
		name: "List pets",
		method: "GET",
		url: "https://api.test/pets",
		params: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		elements: [],
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		verifySSL: true,
		disableCookies: false,
		disabledSystemHeaders: [],
		disableUrlEncoding: false,
		stream: false,
	} as unknown,
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
	apiService: { startLoadTest, executeStreamRequest: vi.fn() },
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
		return <div data-testid="load-test-dialog" />;
	},
}));

const { default: RequestBuilder } = await import("./index");

const REQUEST: RequestState = {
	id: "req_1",
	collectionId: "col_1",
	name: "List pets",
	method: "GET",
	url: "https://api.test/pets",
	params: [],
	headers: [],
	disabledDefaultHeaders: [],
	bodyMode: "none",
	body: "",
	formData: [],
	urlEncoded: [],
	binaryFile: { src: "", unresolved: true },
	auth: { mode: "none" },
	elements: [],
	followRedirects: true,
	maxRedirects: 10,
	timeout: null,
	httpVersion: "auto",
	verifySSL: true,
	disableCookies: false,
	disabledSystemHeaders: [],
	disableUrlEncoding: false,
	stream: false,
};

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<RequestBuilder />, { wrapper });
}

/** Press Load test: the builder's own entry point, before any dialog. */
async function pressLoadTest() {
	await act(async () => {
		(providerProps.onStartLoadTest as (request: RequestState) => void)(REQUEST);
	});
}

/** Press Start in the dialog the press above opened. */
async function confirmLoadTest() {
	await act(async () => {
		await (dialogProps.onStart as (config: LoadTestConfig) => Promise<void>)(LOAD_CONFIG);
	});
}

function activeTab() {
	const { openTabs, activeTabId } = useTabsStore.getState();
	return openTabs.find((tab) => tab.id === activeTabId);
}

beforeEach(() => {
	composeRequest.mockReset().mockResolvedValue({
		method: "GET",
		url: "https://api.test/pets",
	});
	executeRequest.mockReset().mockResolvedValue({ status: 200, body: "", bodyRaw: "" });
	startLoadTest.mockReset().mockResolvedValue({ runId: "run_1" });
	providerProps = {};
	dialogProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.setState({ currentRunId: null, phase: { phase: "idle" }, requestInfo: null });
	useScenarioRunStore.setState({ runId: null, isStreaming: false });
	useToastStore.setState({ toasts: [] });
});

function lastToast() {
	const { toasts } = useToastStore.getState();
	return toasts[toasts.length - 1];
}

describe("Load test while another run holds the live stream", () => {
	/*
	 * A lost stream is live: the engine still runs the load test, so the
	 * dashboard's pill says Running (`DashboardHeader.status.test.tsx`) and
	 * this guard must agree. Mutation check: test `phase === "streaming"` in
	 * the gate instead of `isDashboardRunLive` and this case opens the dialog.
	 */
	it("refuses beside a load run whose stream was lost, as the pill says Running", async () => {
		useDashboardStore
			.getState()
			.startRun("run_live", {}, { method: "POST", url: "https://api.test/orders" });
		useDashboardStore.getState().streamLost("run_live", "socket closed");
		expect(isDashboardRunLive(useDashboardStore.getState().phase)).toBe(true);
		renderBuilder();

		await pressLoadTest();

		expect(screen.queryByTestId("load-test-dialog")).toBeNull();
		expect(lastToast()).toMatchObject({
			message: "A load test of POST https://api.test/orders is already running.",
			variant: "warning",
		});
		expect(activeTab()).toMatchObject({ type: "dashboard" });
	});

	// Mutation check: drop the scenario branch from the gate and the dialog
	// opens, and Start would take the one stream client from the collection run.
	it("refuses beside a streaming collection run and opens that run's tab", async () => {
		useScenarioRunStore.getState().startRun("coll_live");
		renderBuilder();

		await pressLoadTest();

		expect(screen.queryByTestId("load-test-dialog")).toBeNull();
		expect(lastToast()?.message).toBe("A collection run is already running.");
		expect(activeTab()).toMatchObject({ type: "run", entityId: "coll_live" });
	});

	// Mutation check: drop the check at the top of `handleConfirmLoadTest` and
	// the agent's run is replaced by this one, silently.
	it("refuses at Start for a run that began while the dialog was open", async () => {
		renderBuilder();
		await pressLoadTest();
		expect(screen.getByTestId("load-test-dialog")).toBeTruthy();

		act(() => useDashboardStore.getState().startRun("run_agent"));
		await confirmLoadTest();

		expect(startLoadTest).not.toHaveBeenCalled();
		expect(useDashboardStore.getState().currentRunId).toBe("run_agent");
		expect(screen.queryByTestId("load-test-dialog")).toBeNull();
		expect(lastToast()?.message).toBe("A load test is already running.");
	});

	it("starts when nothing is live", async () => {
		renderBuilder();

		await pressLoadTest();
		await confirmLoadTest();

		expect(startLoadTest).toHaveBeenCalledTimes(1);
		expect(useDashboardStore.getState().currentRunId).toBe("run_1");
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});
});
