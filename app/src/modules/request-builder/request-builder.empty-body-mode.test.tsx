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
 * Clearing a content-based body must keep its mode (issue #1490).
 *
 * `toBodyPayload` used to test `request.bodyMode !== "none" && request.body`:
 * an empty string is falsy, so a JSON/text/XML/GraphQL/JSON-RPC body with no
 * content collapsed to `{ mode: "none" }` on save. The mode selector then read
 * JSON until the next reload (the in-memory draft still said "json"), and
 * after a reload it read None, with the mode's auto-written `Content-Type`
 * header left behind - a stored shape that contradicts what the user picked.
 *
 * The fix tests the mode alone and sends the empty string as `content` rather
 * than dropping it, which is what the reverse read (seeding `bodyMode` from
 * `body.mode` on load) already expects.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { RequestState, MergeableRequestField } from "./types";

const updateRequest = vi.fn();

const requestQuery = {
	get data() {
		return {
			id: "req_1",
			collectionId: "col_1",
			name: "Get user",
			method: "GET",
			url: "https://api.test/u",
			params: [],
			headers: [],
			body: { mode: "json", content: '{"a":1}' },
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
	useEngine: () => ({ composeRequest: vi.fn(), executeRequest: vi.fn() }),
	useVariableResolver: () => ({ resolveObject: <T,>(value: T) => value }),
}));

vi.mock("@/services", () => ({
	apiService: { startLoadTest: vi.fn(), executeStreamRequest: vi.fn() },
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

beforeEach(() => {
	updateRequest.mockReset().mockResolvedValue({});
	providerProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.getState().setStreaming(false);
});

describe("emptying a content-based body", () => {
	it("keeps the mode and sends an empty content string", async () => {
		renderBuilder();
		const patch = await save(seededState({ bodyMode: "json", body: "" }), ["body"]);

		expect(patch?.body).toEqual({ mode: "json", content: "" });
		expect(patch).toHaveProperty("bodyType", "json");
	});

	it("still collapses to none when the mode itself is switched to None", async () => {
		renderBuilder();
		const patch = await save(seededState({ bodyMode: "none", body: "" }), ["bodyMode", "body"]);

		expect(patch?.body).toEqual({ mode: "none" });
		expect(patch).toHaveProperty("bodyType", "none");
	});

	it("a body untouched since the last save is never resent", async () => {
		renderBuilder();
		const patch = await save(seededState({ url: "https://api.test/v2" }), ["url"]);

		expect(patch).toHaveProperty("url", "https://api.test/v2");
		expect(patch).not.toHaveProperty("body");
		expect(patch).not.toHaveProperty("bodyType");
	});
});
