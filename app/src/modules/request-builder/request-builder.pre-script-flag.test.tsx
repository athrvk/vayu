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
 * The engine's `runsPreRequestScript` (#2741) reaches the builder's provider
 * from the request the builder fetched, and is never written back: it is
 * derived on read, so the PUT merge-patch carries it for no field.
 *
 * Mutation check: delete the `runsPreRequestScript={fetchedRequest?...}` prop
 * in `index.tsx` and the "reaches the provider" cases fail; add the flag to the
 * `initialRequest` it builds and the "seeded editor state" case fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { RequestState, MergeableRequestField } from "./types";

const updateRequest = vi.fn();

/** What the detail query answers - `undefined` is a row that carries no flag. */
let storedFlag: boolean | undefined;

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
			httpVersion: "auto",
			verifySSL: true,
			stream: false,
			...(storedFlag === undefined ? {} : { runsPreRequestScript: storedFlag }),
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

beforeEach(() => {
	storedFlag = undefined;
	updateRequest.mockReset().mockResolvedValue({});
	providerProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.getState().setStreaming(false);
});

describe("the flag the builder fetched", () => {
	it.each([[true], [false]])("reaches the provider as %s", (flag) => {
		storedFlag = flag;
		renderBuilder();
		expect(providerProps.runsPreRequestScript).toBe(flag);
	});

	it("reaches the provider as absent for a row that carries none", () => {
		renderBuilder();
		expect(providerProps.runsPreRequestScript).toBeUndefined();
	});

	it("is not part of the seeded editor state, so it can never be saved", async () => {
		storedFlag = true;
		renderBuilder();
		const initial = providerProps.initialRequest as Partial<RequestState>;
		expect(initial).not.toHaveProperty("runsPreRequestScript");

		const everything = [
			"name",
			"description",
			"method",
			"url",
			"params",
			"headers",
			"body",
			"auth",
			"elements",
			"stream",
		] as MergeableRequestField[];
		await act(async () => {
			await (
				providerProps.onSave as (
					r: RequestState,
					changed: ReadonlySet<MergeableRequestField>
				) => Promise<void>
			)({ ...(initial as RequestState), disabledDefaultHeaders: [] }, new Set(everything));
		});
		expect(updateRequest.mock.calls[0]?.[0]).not.toHaveProperty("runsPreRequestScript");
	});
});
