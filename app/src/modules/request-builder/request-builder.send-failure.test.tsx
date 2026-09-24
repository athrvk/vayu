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
 * Which failure a send that never reached `/execute` reports.
 *
 * Compose runs before the send, so an engine that is down throws there first -
 * a plain `Error` from the fetch. That is Vayu's own failure and the response
 * pane has an `ENGINE_ERROR` message written for it; hard-coding
 * `INTERNAL_ERROR` showed the generic "Couldn't send the request" instead
 * (docs/ux-writing.md, "Errors have three sources"). An `ApiError` from the
 * engine keeps the code the engine gave it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useToastStore } from "@/stores";
import { ApiError } from "@/services/http-client";
import type { LoadTestConfig } from "@/types";
import type { RequestState, ResponseState, StreamStartResult } from "./types";

const composeRequest = vi.fn();
const executeRequest = vi.fn();
const executeStreamRequest = vi.fn();
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
	useCopy: () => vi.fn(),
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

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(<RequestBuilder />, { wrapper });
}

function seededState(): RequestState {
	return { ...(providerProps.initialRequest as RequestState), disabledDefaultHeaders: [] };
}

async function send(): Promise<ResponseState> {
	let result: ResponseState | null = null;
	await act(async () => {
		result = await (
			providerProps.onExecute as (r: RequestState) => Promise<ResponseState | null>
		)(seededState());
	});
	return result as unknown as ResponseState;
}

async function stream(): Promise<StreamStartResult> {
	let result: StreamStartResult | null = null;
	await act(async () => {
		result = await (
			providerProps.onExecuteStream as (r: RequestState) => Promise<StreamStartResult | null>
		)(seededState());
	});
	return result as unknown as StreamStartResult;
}

beforeEach(() => {
	composeRequest.mockReset();
	executeRequest.mockReset();
	executeStreamRequest.mockReset();
	startLoadTest.mockReset();
	providerProps = {};
	dialogProps = {};
	useToastStore.setState({ toasts: [] });
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a send the engine never answered", () => {
	it("reports the engine, not a generic internal error, on the buffered send", async () => {
		composeRequest.mockRejectedValue(new Error("Couldn't reach the engine (Failed to fetch)."));
		renderBuilder();

		const response = await send();

		expect(response.errorCode).toBe("ENGINE_ERROR");
		expect(executeRequest).not.toHaveBeenCalled();
	});

	it("reports the engine on the stream too", async () => {
		composeRequest.mockRejectedValue(new Error("Couldn't reach the engine (Failed to fetch)."));
		renderBuilder();

		const result = await stream();

		expect(result.ok).toBe(false);
		expect(!result.ok && result.response.errorCode).toBe("ENGINE_ERROR");
	});

	it("keeps the code the engine gave an ApiError", async () => {
		composeRequest.mockRejectedValue(new ApiError(400, "VARIABLE_UNRESOLVED", "Bad variable"));
		renderBuilder();

		expect((await send()).errorCode).toBe("VARIABLE_UNRESOLVED");
		expect((await stream()) as { response: ResponseState }).toMatchObject({
			response: { errorCode: "VARIABLE_UNRESOLVED" },
		});
	});
});

describe("a load test that doesn't start", () => {
	it("says what failed before the engine's own words", async () => {
		composeRequest.mockResolvedValue({ method: "GET", url: "https://api.test/u" });
		startLoadTest.mockRejectedValue(new Error("port in use"));
		renderBuilder();

		await act(async () => {
			(providerProps.onStartLoadTest as (r: RequestState) => void)(seededState());
		});
		await act(async () => {
			await (dialogProps.onStart as (c: LoadTestConfig) => Promise<void>)({
				mode: "constant_rps",
				duration_seconds: 10,
				rps: 5,
			});
		});

		expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
			"Couldn't start the load test - port in use",
		]);
	});
});
