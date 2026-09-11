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
 * `requestName` on the load test dialog's compose call.
 *
 * Send's own compose call (`composeForSend`) has carried `execIdentity`
 * (`{ requestName }`) since issue #300, for the script sandbox's `pm.info`.
 * The load test dialog composes separately (`handleConfirmLoadTest`,
 * `index.tsx`) and was the one caller that never spread it in - so a load
 * run's `config_snapshot` carried no name for the engine's `build_run_summary`
 * to read, even though the exact same helper was one import away. Behavioural,
 * like `load-test-elements-plumbing.test.tsx`: what matters is the field
 * reaching the compose call, not that some line mentions its name.
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
	auth: { mode: "none" },
	elements: [],
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

async function startLoadRun(request: RequestState, config: LoadTestConfig) {
	renderBuilder();
	await act(async () => {
		(providerProps.onStartLoadTest as (request: RequestState) => void)(request);
	});
	await act(async () => {
		await (dialogProps.onStart as (config: LoadTestConfig) => Promise<void>)(config);
	});
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
	useDashboardStore.getState().setStreaming(false);
});

const LOAD_CONFIG: LoadTestConfig = { mode: "constant_rps", duration_seconds: 10, rps: 5 };

describe("the load test dialog's compose call carries the request's name", () => {
	it("sends the editor's current name under request.requestName", async () => {
		await startLoadRun(REQUEST, LOAD_CONFIG);

		expect(composeRequest).toHaveBeenCalledTimes(1);
		const composeArg = composeRequest.mock.calls[0][0] as { request: Record<string, unknown> };
		expect(composeArg.request.requestName).toBe("List pets");
	});

	it("omits it for an unnamed request rather than sending an empty string", async () => {
		await startLoadRun({ ...REQUEST, name: "" }, LOAD_CONFIG);

		const composeArg = composeRequest.mock.calls[0][0] as { request: Record<string, unknown> };
		expect(composeArg.request.requestName).toBeUndefined();
	});
});
