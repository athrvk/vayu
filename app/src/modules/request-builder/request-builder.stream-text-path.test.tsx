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
 * A request's stream text path through the builder's load, save and streaming
 * Send hops (issue #3773).
 *
 * `PUT /requests/:id` keeps the stored path on an absent key and clears it on
 * `null`, so a field the user emptied has to reach the wire as an explicit
 * `null`. A Send is the other half: the inline compose carries no path, so the
 * streaming execute must state it, and only for a request that streams.
 * Driven through the real component, as the timeout test is, so the seeding is
 * in the path too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { RequestState, MergeableRequestField } from "./types";

const updateRequest = vi.fn();
const executeStream = vi.fn();
const OPENAI = "$.choices[0].delta.content";
const ANTHROPIC = "$.delta.text";

/** What the request query hands back - `streamTextPath` is the variable. */
let storedPath: unknown = OPENAI;

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
			streamTextPath: storedPath,
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
	useEngine: () => ({ composeRequest: vi.fn().mockResolvedValue({}), executeRequest: vi.fn() }),
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) => value,
		resolveString: (value: string) => value,
	}),
}));

vi.mock("@/services", () => ({
	apiService: {
		startLoadTest: vi.fn(),
		executeStreamRequest: (...args: unknown[]) => executeStream(...args),
	},
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

beforeEach(() => {
	storedPath = OPENAI;
	updateRequest.mockReset().mockResolvedValue({});
	executeStream
		.mockReset()
		.mockResolvedValue({ runId: "run_1", eventsUrl: "/runs/run_1/events" });
	providerProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.setState({ phase: { phase: "idle" } });
});

describe("loading a request's stream text path", () => {
	it("seeds the editor with the stored path", () => {
		renderBuilder();
		expect((providerProps.initialRequest as Partial<RequestState>).streamTextPath).toBe(OPENAI);
	});

	it("seeds an empty field for a request that states none", () => {
		storedPath = null;
		renderBuilder();
		expect(providerProps.initialRequest).toHaveProperty("streamTextPath", "");
	});
});

describe("saving a request's stream text path", () => {
	it("sends an explicit null when the field was emptied", async () => {
		renderBuilder();
		const patch = await save(seededState({ streamTextPath: "" }), ["streamTextPath"]);

		// An absent key is what the engine reads as "keep the stored path".
		expect(patch).toHaveProperty("streamTextPath", null);
	});

	it("sends a blank field as null too, and the path as typed trimmed", async () => {
		renderBuilder();
		expect(
			await save(seededState({ streamTextPath: "   " }), ["streamTextPath"])
		).toHaveProperty("streamTextPath", null);
		updateRequest.mockClear();
		expect(
			await save(seededState({ streamTextPath: ` ${ANTHROPIC} ` }), ["streamTextPath"])
		).toHaveProperty("streamTextPath", ANTHROPIC);
	});

	it("leaves the key out of a save that did not touch it", async () => {
		renderBuilder();
		const patch = await save(seededState({ url: "https://api.test/v2" }), ["url"]);

		expect(patch).toHaveProperty("url", "https://api.test/v2");
		expect(patch).not.toHaveProperty("streamTextPath");
	});
});

describe("sending a streaming request's text path", () => {
	it("states the path on the execute, which the inline compose cannot carry", async () => {
		renderBuilder();
		const payload = await sendStream(seededState());
		expect(payload).toHaveProperty("streamTextPath", OPENAI);
	});

	it("states none for an empty field", async () => {
		renderBuilder();
		const payload = await sendStream(seededState({ streamTextPath: "" }));
		expect(payload).toBeDefined();
		expect(payload).not.toHaveProperty("streamTextPath");
	});

	it("shows the engine's refusal of a bad path in the pane, as it does any other 400", async () => {
		// A path outside the JSONPath subset is the engine's to refuse, with a
		// message naming the field; the Send reads it back as a response to
		// render rather than a silent stream that never opens.
		const refusal = "'streamTextPath' is not in the supported JSONPath subset: a filter";
		executeStream.mockRejectedValue(new Error(refusal));
		renderBuilder();

		const started = (await act(async () =>
			(providerProps.onExecuteStream as (r: RequestState) => Promise<unknown>)(
				seededState({ streamTextPath: "$..[?(@.a)]" })
			)
		)) as { ok: boolean; response?: { body: string; status: number } };

		expect(started.ok).toBe(false);
		expect(started.response).toMatchObject({ status: 0, body: refusal });
	});
});
