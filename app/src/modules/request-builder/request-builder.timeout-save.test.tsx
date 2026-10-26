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
 * A request's own timeout through the builder's load and save hops (issue
 * #2937).
 *
 * `PUT /requests/:id` is a merge patch where an absent key keeps the stored
 * value and `null` resets it to the `defaultTimeout` setting. A cleared field
 * is `null` in editor state, so `buildUpdatePayload` must write the key as an
 * explicit `null`: dropping it (the `undefined` an unguarded `?? undefined`
 * would give) turns "back to the default" into "keep what you have", and the
 * override the user just removed comes back on the next load.
 *
 * Driven through the real component, as `request-builder.script-clearing.test.tsx`
 * is, so the load-side seeding is in the path too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { RequestState, MergeableRequestField } from "./types";

const updateRequest = vi.fn();
const STORED_TIMEOUT = 1500;
const NEW_TIMEOUT = 9000;

/** What the request query hands back - `timeout` is the variable. */
let storedTimeout: unknown = STORED_TIMEOUT;

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
			body: { mode: "none" },
			auth: { mode: "none" },
			elements: [],
			followRedirects: true,
			maxRedirects: 10,
			timeout: storedTimeout,
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
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) => value,
		resolveString: (value: string) => value,
	}),
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
	storedTimeout = STORED_TIMEOUT;
	updateRequest.mockReset().mockResolvedValue({});
	providerProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.getState().setStreaming(false);
});

describe("loading a request's own timeout", () => {
	it("seeds the editor with the stored number", () => {
		renderBuilder();
		expect((providerProps.initialRequest as Partial<RequestState>).timeout).toBe(
			STORED_TIMEOUT
		);
	});

	it("seeds null for a request that states none, never a default", () => {
		storedTimeout = null;
		renderBuilder();
		const initial = providerProps.initialRequest as Partial<RequestState>;
		expect(initial).toHaveProperty("timeout", null);
	});
});

describe("saving a request's own timeout", () => {
	it("sends an explicit null when the field was cleared", async () => {
		renderBuilder();
		const patch = await save(seededState({ timeout: null }), ["timeout"]);

		// `toHaveProperty` is the assertion that matters: an absent key is what
		// the engine reads as "keep the stored timeout".
		expect(patch).toHaveProperty("timeout", null);
	});

	it("sends the number the user typed", async () => {
		renderBuilder();
		const patch = await save(seededState({ timeout: NEW_TIMEOUT }), ["timeout"]);
		expect(patch).toHaveProperty("timeout", NEW_TIMEOUT);
	});

	it("leaves the key out of a save that did not touch it", async () => {
		renderBuilder();
		const patch = await save(seededState({ url: "https://api.test/v2" }), ["url"]);

		expect(patch).toHaveProperty("url", "https://api.test/v2");
		expect(patch).not.toHaveProperty("timeout");
	});
});
