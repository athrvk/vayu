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
 * A Send that leaves out an unfinished element says so (#3066).
 *
 * The request goes out without the draft's unconfigured `assert.status` (so
 * the engine has no inline element to refuse), and every answer the builder
 * gives back - the buffered response, the stream's start, and either one's
 * failure - names the element, for the response pane to draw as not run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useToastStore } from "@/stores";
import type { ElementDef } from "@/types";
import type { RequestState, ResponseState, StreamStartResult } from "./types";

const composeRequest = vi.fn();
const executeRequest = vi.fn();
const executeStreamRequest = vi.fn();

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
		useElementKindsQuery: () => ({ data: [] }),
	};
});

vi.mock("@/hooks", () => ({
	useEngine: () => ({ composeRequest, executeRequest }),
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) => value,
		resolveString: (value: string) => value,
	}),
	useCopy: () => vi.fn(),
}));

vi.mock("@/services", () => ({
	apiService: { startLoadTest: vi.fn(), executeStreamRequest },
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

/** An assert just added: no accepted codes and no range, which the engine refuses. */
const UNCONFIGURED: ElementDef = {
	id: "el_assert",
	kind: "assert.status",
	enabled: true,
	config: {},
};
const CONFIGURED: ElementDef = {
	id: "el_ok",
	kind: "assert.status",
	enabled: true,
	config: { in: [200] },
};

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(<RequestBuilder />, { wrapper });
}

function draft(elements: ElementDef[]): RequestState {
	return {
		...(providerProps.initialRequest as RequestState),
		disabledDefaultHeaders: [],
		elements,
	};
}

async function send(elements: ElementDef[]): Promise<ResponseState> {
	let result: ResponseState | null = null;
	await act(async () => {
		result = await (
			providerProps.onExecute as (r: RequestState) => Promise<ResponseState | null>
		)(draft(elements));
	});
	return result as unknown as ResponseState;
}

async function stream(elements: ElementDef[]): Promise<StreamStartResult> {
	let result: StreamStartResult | null = null;
	await act(async () => {
		result = await (
			providerProps.onExecuteStream as (r: RequestState) => Promise<StreamStartResult | null>
		)(draft(elements));
	});
	return result as unknown as StreamStartResult;
}

const leftOutIds = (list: { element: { id: string } }[] | undefined) =>
	list?.map((l) => l.element.id);

const sentElementIds = () =>
	(
		composeRequest.mock.calls[0][0] as { request: { elements?: { id: string }[] } }
	).request.elements?.map((e) => e.id);

beforeEach(() => {
	composeRequest.mockReset().mockResolvedValue({ method: "GET", url: "https://api.test/u" });
	executeRequest.mockReset().mockResolvedValue({ status: 200, body: "", bodyRaw: "" });
	executeStreamRequest
		.mockReset()
		.mockResolvedValue({ runId: "run_1", eventsUrl: "/runs/run_1/events" });
	providerProps = {};
	useToastStore.setState({ toasts: [] });
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a buffered Send with an unconfigured assert", () => {
	it("sends without it and hands it back for the response to show as not run", async () => {
		renderBuilder();

		const response = await send([UNCONFIGURED, CONFIGURED]);

		// The unconfigured assert is not in the payload, so `/execute` has no
		// element to answer 400 for; the configured one still runs.
		expect(sentElementIds()).toEqual(["el_ok"]);
		expect(executeRequest).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
		expect(response.errorCode).toBeUndefined();
		expect(leftOutIds(response.leftOutElements)).toEqual(["el_assert"]);
		expect(response.leftOutElements?.[0].needs.missing).toEqual(["accepted codes or a range"]);
	});

	it("carries nothing when every element is configured", async () => {
		renderBuilder();

		expect(await send([CONFIGURED])).not.toHaveProperty("leftOutElements");
	});

	it("still names it when composing fails", async () => {
		composeRequest.mockRejectedValue(new Error("Couldn't reach the engine (Failed to fetch)."));
		renderBuilder();

		const response = await send([UNCONFIGURED]);

		expect(response.status).toBe(0);
		expect(response.errorCode).toBe("ENGINE_ERROR");
		expect(leftOutIds(response.leftOutElements)).toEqual(["el_assert"]);
	});

	it("still names it when the engine refuses the execute", async () => {
		executeRequest.mockRejectedValue(new Error("boom"));
		renderBuilder();

		const response = await send([UNCONFIGURED]);

		expect(response.status).toBe(0);
		expect(leftOutIds(response.leftOutElements)).toEqual(["el_assert"]);
	});
});

describe("a streaming Send with an unconfigured assert", () => {
	it("starts without it and hands it back with the run", async () => {
		renderBuilder();

		const result = await stream([UNCONFIGURED, CONFIGURED]);

		expect(sentElementIds()).toEqual(["el_ok"]);
		expect(result.ok).toBe(true);
		expect(result.ok && leftOutIds(result.leftOut)).toEqual(["el_assert"]);
	});

	it("hands back an empty list when it left nothing out", async () => {
		renderBuilder();

		const result = await stream([CONFIGURED]);

		expect(result.ok && result.leftOut).toEqual([]);
	});

	it("still names it on the failed start's response", async () => {
		composeRequest.mockRejectedValue(new Error("Couldn't reach the engine (Failed to fetch)."));
		renderBuilder();

		const result = await stream([UNCONFIGURED]);

		expect(result.ok).toBe(false);
		expect(!result.ok && leftOutIds(result.response.leftOutElements)).toEqual(["el_assert"]);
	});
});
