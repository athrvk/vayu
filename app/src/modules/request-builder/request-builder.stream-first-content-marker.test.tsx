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
 * A request's first content marker through the builder's load, save, Send and
 * load-run hops (issue #3774).
 *
 * `PUT /requests/:id` keeps the stored marker on an absent key and clears it
 * on `null`, so an emptied field has to reach the wire as an explicit `null`.
 * Only a load run times a stream to the marker (a Send checks the field and
 * times nothing with it), so the load run states it beside the composed
 * payload, and only for a request that streams; the streaming Send never does.
 * Driven through the real component, so the seeding is in the path too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { LoadTestConfig } from "@/types";
import type { RequestState, MergeableRequestField } from "./types";

const updateRequest = vi.fn();
const executeStream = vi.fn();
const startLoadTest = vi.fn();
const MARKER = "content_block_delta";
const OPENAI_MARKER = '"delta":{"content":"';

/** What the request query hands back - the marker is the variable. */
let storedMarker: unknown = MARKER;

const requestQuery = {
	get data() {
		return {
			id: "req_1",
			collectionId: "col_1",
			name: "Chat",
			method: "POST",
			url: "https://api.test/chat",
			params: [],
			headers: [],
			body: { mode: "none" },
			auth: { mode: "none" },
			elements: [],
			followRedirects: true,
			maxRedirects: 10,
			timeout: null,
			httpVersion: "auto",
			verifySSL: true,
			stream: true,
			streamFirstContentMarker: storedMarker,
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
	useEngine: () => ({
		composeRequest: vi.fn().mockResolvedValue({ method: "POST", url: "https://api.test/chat" }),
		executeRequest: vi.fn(),
	}),
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) => value,
		resolveString: (value: string) => value,
	}),
}));

vi.mock("@/services", () => ({
	apiService: {
		startLoadTest: (...args: unknown[]) => startLoadTest(...args),
		executeStreamRequest: (...args: unknown[]) => executeStream(...args),
	},
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

/** The editor state the builder seeded, which is what the user then edits. */
function seededState(overrides: Partial<RequestState> = {}): RequestState {
	const initial = providerProps.initialRequest as Partial<RequestState>;
	return { ...(initial as RequestState), disabledDefaultHeaders: [], ...overrides };
}

async function save(state: RequestState, changedFields: Iterable<MergeableRequestField>) {
	await act(async () => {
		await (
			providerProps.onSave as (
				r: RequestState,
				changed: ReadonlySet<MergeableRequestField>
			) => Promise<void>
		)(state, new Set(changedFields));
	});
	return updateRequest.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
}

async function sendStream(state: RequestState) {
	await act(async () => {
		await (providerProps.onExecuteStream as (r: RequestState) => Promise<unknown>)(state);
	});
	return executeStream.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
}

async function startLoadRun(state: RequestState) {
	await act(async () => {
		(providerProps.onStartLoadTest as (request: RequestState) => void)(state);
	});
	await act(async () => {
		await (dialogProps.onStart as (config: LoadTestConfig) => Promise<void>)(LOAD_CONFIG);
	});
	return startLoadTest.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
}

beforeEach(() => {
	storedMarker = MARKER;
	updateRequest.mockReset().mockResolvedValue({});
	executeStream
		.mockReset()
		.mockResolvedValue({ runId: "run_1", eventsUrl: "/runs/run_1/events" });
	startLoadTest.mockReset().mockResolvedValue({ runId: "run_2" });
	providerProps = {};
	dialogProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.setState({ phase: { phase: "idle" } });
});

describe("loading a request's first content marker", () => {
	it("seeds the editor with the stored marker", () => {
		renderBuilder();
		expect(
			(providerProps.initialRequest as Partial<RequestState>).streamFirstContentMarker
		).toBe(MARKER);
	});

	it("seeds an empty field for a request that states none", () => {
		storedMarker = null;
		renderBuilder();
		expect(providerProps.initialRequest).toHaveProperty("streamFirstContentMarker", "");
	});
});

describe("saving a request's first content marker", () => {
	it("sends an explicit null when the field was emptied", async () => {
		renderBuilder();
		const patch = await save(seededState({ streamFirstContentMarker: "" }), [
			"streamFirstContentMarker",
		]);

		// An absent key is what the engine reads as "keep the stored marker".
		expect(patch).toHaveProperty("streamFirstContentMarker", null);
	});

	it("sends the marker as typed, spaces and all", async () => {
		renderBuilder();
		const patch = await save(seededState({ streamFirstContentMarker: ` ${OPENAI_MARKER}` }), [
			"streamFirstContentMarker",
		]);

		expect(patch).toHaveProperty("streamFirstContentMarker", ` ${OPENAI_MARKER}`);
	});

	it("leaves the key out of a save that did not touch it", async () => {
		renderBuilder();
		const patch = await save(seededState({ url: "https://api.test/v2" }), ["url"]);

		expect(patch).toHaveProperty("url", "https://api.test/v2");
		expect(patch).not.toHaveProperty("streamFirstContentMarker");
	});

	it("clears it beside the stream flag when Event stream goes off", async () => {
		renderBuilder();
		const patch = await save(seededState({ stream: false, streamFirstContentMarker: "" }), [
			"stream",
			"streamFirstContentMarker",
		]);

		expect(patch).toMatchObject({ stream: false, streamFirstContentMarker: null });
	});
});

describe("a load run's first content marker", () => {
	it("is stated beside the payload for a request that streams", async () => {
		renderBuilder();
		const payload = await startLoadRun(seededState());

		expect(payload).toHaveProperty("stream", true);
		expect(payload).toHaveProperty("streamFirstContentMarker", MARKER);
	});

	it("is stated byte for byte, never trimmed", async () => {
		renderBuilder();
		const payload = await startLoadRun(
			seededState({ streamFirstContentMarker: ` ${OPENAI_MARKER}` })
		);

		expect(payload).toHaveProperty("streamFirstContentMarker", ` ${OPENAI_MARKER}`);
	});

	it("is left out for an empty field", async () => {
		renderBuilder();
		const payload = await startLoadRun(seededState({ streamFirstContentMarker: "" }));

		expect(payload).toBeDefined();
		expect(payload).not.toHaveProperty("streamFirstContentMarker");
	});

	it("is left out for a request that does not stream, whatever the draft holds", async () => {
		renderBuilder();
		const payload = await startLoadRun(seededState({ stream: false }));

		expect(payload).toHaveProperty("stream", false);
		expect(payload).not.toHaveProperty("streamFirstContentMarker");
	});
});

describe("a streaming Send and the first content marker", () => {
	it("does not carry it: a Send checks the field and times nothing with it", async () => {
		renderBuilder();
		const payload = await sendStream(seededState());

		expect(payload).toBeDefined();
		expect(payload).not.toHaveProperty("streamFirstContentMarker");
	});
});
