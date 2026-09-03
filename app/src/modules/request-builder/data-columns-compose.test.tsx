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
 * `dataColumns` on `POST /compose` (issue #1007) - sent by the two builder
 * flows that will actually bind a row, and by neither of them otherwise.
 *
 * Postman binds a dataset's columns to *bare* names, so an imported collection
 * writes `{{username}}` where Vayu's reserved namespace writes
 * `{{data.username}}`. The renderer composes before it executes and before it
 * starts a load run, so composition is the one place that can resolve such a
 * name from a same-named environment variable and send the value the row
 * existed to replace - which is why the names travel with the compose call
 * rather than only with the row.
 *
 * Behavioural, not a scan: the field is conditional, and the condition ("a row
 * will be bound") is the whole of what can regress. `compose-plumbing.test.ts`
 * keeps guarding that these are still the only two compose sites.
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
		url: "https://api.test/u/{{username}}",
		params: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		preRequestScript: "",
		postRequestScript: "",
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

/** The builder's own children render Monaco and the response tree; the props
    they are handed are the whole question here. */
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
	name: "Get user",
	method: "GET",
	url: "https://api.test/u/{{username}}",
	params: [],
	headers: [],
	bodyMode: "none",
	body: "",
	formData: [],
	urlEncoded: [],
	auth: { mode: "none" },
	preRequestScript: "",
	testScript: "",
	followRedirects: true,
	maxRedirects: 10,
	httpVersion: "auto",
	verifySSL: true,
	stream: false,
};

const LOAD_CONFIG: LoadTestConfig = { mode: "constant_rps", duration_seconds: 10, rps: 5 };

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<RequestBuilder />, { wrapper });
}

/** The body of the one compose call this test made. */
function composedBody(): Record<string, unknown> {
	expect(composeRequest).toHaveBeenCalledTimes(1);
	return composeRequest.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
	composeRequest.mockReset().mockResolvedValue({ method: "GET", url: "https://api.test/u/ada" });
	executeRequest.mockReset().mockResolvedValue({ status: 200, body: "", bodyRaw: "" });
	startLoadTest.mockReset().mockResolvedValue({ runId: "run_1" });
	providerProps = {};
	dialogProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	// A started run leaves the dashboard streaming, and the builder refuses to
	// open the dialog while one is - so a load-run case would otherwise pass or
	// fail depending on which case ran before it.
	useDashboardStore.getState().setStreaming(false);
});

describe("a Send that binds one row", () => {
	it("tells compose the row's column names", async () => {
		renderBuilder();
		const onExecute = providerProps.onExecute as (
			request: RequestState,
			row?: Record<string, unknown>
		) => Promise<unknown>;

		await act(async () => {
			await onExecute(REQUEST, { username: "ada", region: "eu" });
		});

		expect(composedBody().dataColumns).toEqual(["username", "region"]);
	});

	it("sends no column names for an ordinary Send", async () => {
		renderBuilder();
		const onExecute = providerProps.onExecute as (
			request: RequestState,
			row?: Record<string, unknown>
		) => Promise<unknown>;

		await act(async () => {
			await onExecute(REQUEST);
		});

		// Absent, not `[]`: the engine reads an absent field as "no dataset" and
		// composes exactly as it always has.
		expect(composedBody()).not.toHaveProperty("dataColumns");
	});

	it("does not defer dynamic variables - a Send composes once and sends once", async () => {
		renderBuilder();
		const onExecute = providerProps.onExecute as (
			request: RequestState,
			row?: Record<string, unknown>
		) => Promise<unknown>;

		await act(async () => {
			await onExecute(REQUEST);
		});

		// Absent, not `false`: an ordinary Send must keep resolving the
		// `{{$guid}}` family at composition (issue #995).
		expect(composedBody()).not.toHaveProperty("deferDynamicVariables");
	});
});

describe("a load run started with a data file", () => {
	async function startLoadRun(config: LoadTestConfig) {
		renderBuilder();
		await act(async () => {
			(providerProps.onStartLoadTest as (request: RequestState) => void)(REQUEST);
		});
		await act(async () => {
			await (dialogProps.onStart as (config: LoadTestConfig) => Promise<void>)(config);
		});
	}

	it("tells compose the picked file's column names", async () => {
		await startLoadRun({
			...LOAD_CONFIG,
			data: [{ username: "ada" }, { username: "grace" }],
			dataColumns: ["username"],
		});

		expect(composedBody().dataColumns).toEqual(["username"]);
	});

	it("sends no column names when no file was picked", async () => {
		await startLoadRun(LOAD_CONFIG);

		expect(composedBody()).not.toHaveProperty("dataColumns");
	});

	it("defers the {{$guid}} family to per-iteration generation (issue #995)", async () => {
		await startLoadRun(LOAD_CONFIG);

		// A load run repeats this composed payload once per iteration, per
		// virtual user, so the generator family must not be resolved here -
		// every case in this describe block starts a run, so this holds
		// regardless of whether a data file was picked.
		expect(composedBody().deferDynamicVariables).toBe(true);
	});
});
