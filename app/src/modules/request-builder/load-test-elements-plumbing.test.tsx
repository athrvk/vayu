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
 * `requestElements` and `elements` on the `startLoadTest` payload (issue
 * #1594) - both optional on `StartLoadTestRequest`, so nothing here fails a
 * type check if either is dropped from the `apiRequest` object literal in
 * `handleConfirmLoadTest`. Deleting the two lines that set them (`index.tsx`,
 * `requestElements,` and `elements: config.elements,`) left the rest of this
 * module's own suite green before this file existed - the exact silent
 * regression class `script-composition-plumbing.test.ts` guards on the
 * compose side, but nothing guarded on the `POST /runs` payload itself.
 *
 * Behavioural, not a scan: what matters is the resolved array and the chosen
 * override actually reaching the payload, not that some call mentions their
 * names.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { LoadTestConfig } from "@/types";
import type { RequestState } from "./types";

const composeRequest = vi.fn();
const executeRequest = vi.fn();
const startLoadTest = vi.fn();

const requestQuery = {
	data: {
		id: "req_1",
		collectionId: "col_1",
		name: "Get user",
		method: "GET",
		url: "https://api.test/u",
		params: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		elements: [],
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		verifySSL: true,
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
	useVariableResolver: () => ({ resolveObject: <T,>(value: T) => value }),
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
		return null;
	},
}));

const { default: RequestBuilder } = await import("./index");

const PRE_SCRIPT = { id: "el_pre", kind: "script.pre", enabled: true, config: { script: "1" } };

const REQUEST: RequestState = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get user",
	method: "GET",
	url: "https://api.test/u",
	params: [],
	headers: [],
	disabledDefaultHeaders: [],
	bodyMode: "none",
	body: "",
	formData: [],
	urlEncoded: [],
	auth: { mode: "none" },
	elements: [PRE_SCRIPT],
	followRedirects: true,
	maxRedirects: 10,
	httpVersion: "auto",
	verifySSL: true,
	stream: false,
};

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<RequestBuilder />, { wrapper });
}

/** The body of the one startLoadTest call this test made. */
function startedPayload(): Record<string, unknown> {
	expect(startLoadTest).toHaveBeenCalledTimes(1);
	return startLoadTest.mock.calls[0][0] as Record<string, unknown>;
}

async function startLoadRun(config: LoadTestConfig) {
	renderBuilder();
	await act(async () => {
		(providerProps.onStartLoadTest as (request: RequestState) => void)(REQUEST);
	});
	await act(async () => {
		await (dialogProps.onStart as (config: LoadTestConfig) => Promise<void>)(config);
	});
}

beforeEach(() => {
	composeRequest.mockReset().mockResolvedValue({
		method: "GET",
		url: "https://api.test/u",
		elements: [{ ...PRE_SCRIPT, origin: { kind: "request", id: "req_1" } }],
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
	useDashboardStore.getState().setStreaming(false);
});

const LOAD_CONFIG: LoadTestConfig = { mode: "constant_rps", duration_seconds: 10, rps: 5 };

describe("a load run sends the resolved chain as requestElements", () => {
	it("sends the elementsParts()-resolved chain under requestElements, not composed.elements", async () => {
		await startLoadRun(LOAD_CONFIG);

		const payload = startedPayload();
		expect(payload.requestElements).toEqual([
			{ ...PRE_SCRIPT, origin: { kind: "request", id: "req_1" } },
		]);
		// The composed payload's own `elements` (the resolved-chain shape
		// `POST /compose` answers under) must never survive under the run-level
		// `elements` key - that key is the timers/scripts override object, and
		// the two would collide if the spread's `elements` were left standing.
		expect(payload.elements).toBeUndefined();
	});

	it("sends the dialog's elements override under elements, distinct from requestElements", async () => {
		await startLoadRun({ ...LOAD_CONFIG, elements: { scripts: "allInline" } });

		const payload = startedPayload();
		expect(payload.elements).toEqual({ scripts: "allInline" });
		expect(payload.requestElements).toEqual([
			{ ...PRE_SCRIPT, origin: { kind: "request", id: "req_1" } },
		]);
	});
});
