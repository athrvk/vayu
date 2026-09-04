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
 * Deleting a script has to reach the engine as a value (issue #1381).
 *
 * `PUT /requests/:id` is a merge patch: a key that is present is written, and a
 * key that is *absent* leaves the stored value alone. `JSON.stringify` drops a
 * key whose value is `undefined`, so the save payload's
 * `request.preRequestScript || undefined` turned the one state that means
 * "cleared" into the one wire shape that means "keep what you have". Emptying a
 * Tests script saved nothing, the mutation succeeded, the Dock said "Saved",
 * and the old script was back on the next open.
 *
 * The two script fields were the only ones in that payload written this way.
 * `name` looks similar and is not: it is omitted deliberately when blank,
 * because a nameless request is unusable everywhere it is listed - that
 * distinction is `save-request-name.test.ts`, and the cases here must not
 * disturb it.
 *
 * The save is driven through the real component rather than through the
 * payload builder alone, so the load-side seeding is in the path too: an
 * `undefined` arriving from the wire type and spreading over
 * `createDefaultRequestState()` would put the same hole back from the other
 * end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { RequestState } from "./types";

const updateRequest = vi.fn();

const STORED_PRE = "pm.environment.set('t', Date.now());";
const STORED_POST = "pm.test('ok', () => pm.response.to.have.status(200));";

/** What the request query hands back - the two script keys are the variable. */
let storedScripts: { preRequestScript?: string; postRequestScript?: string } = {
	preRequestScript: STORED_PRE,
	postRequestScript: STORED_POST,
};

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
			...storedScripts,
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

async function save(state: RequestState) {
	await act(async () => {
		await (providerProps.onSave as (r: RequestState) => Promise<void>)(state);
	});
	return updateRequest.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
	storedScripts = { preRequestScript: STORED_PRE, postRequestScript: STORED_POST };
	updateRequest.mockReset().mockResolvedValue({});
	providerProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.getState().setStreaming(false);
});

describe("clearing a script", () => {
	it("sends the empty string rather than dropping the key", async () => {
		renderBuilder();
		const patch = await save(seededState({ preRequestScript: "", testScript: "" }));

		// `toHaveProperty` is the assertion that matters: an absent key is what
		// the engine reads as "keep the stored script".
		expect(patch).toHaveProperty("preRequestScript", "");
		expect(patch).toHaveProperty("postRequestScript", "");
	});

	it("clears one script without touching the other", async () => {
		renderBuilder();
		const patch = await save(seededState({ testScript: "" }));

		expect(patch).toHaveProperty("postRequestScript", "");
		expect(patch).toHaveProperty("preRequestScript", STORED_PRE);
	});

	it("still refuses to send a blank name, which is a different rule", async () => {
		renderBuilder();
		const patch = await save(seededState({ name: "   ", testScript: "" }));

		expect(patch).not.toHaveProperty("name");
		expect(patch).toHaveProperty("postRequestScript", "");
	});
});

describe("a stored request that never had a script", () => {
	it("seeds the editor with strings, not undefined", async () => {
		// The wire type marks both optional, and spreading an `undefined` over
		// `createDefaultRequestState()` replaces the `""` default with it - which
		// would drop the key again on the first save.
		storedScripts = {};
		renderBuilder();

		const initial = providerProps.initialRequest as Partial<RequestState>;
		expect(initial.preRequestScript).toBe("");
		expect(initial.testScript).toBe("");
	});

	it("sends both keys anyway, so the first clear after one is written lands", async () => {
		storedScripts = {};
		renderBuilder();
		const patch = await save(seededState());

		expect(patch).toHaveProperty("preRequestScript", "");
		expect(patch).toHaveProperty("postRequestScript", "");
	});
});

describe("a script the user kept", () => {
	it("rides the save unchanged", async () => {
		renderBuilder();
		const patch = await save(seededState());

		expect(patch).toHaveProperty("preRequestScript", STORED_PRE);
		expect(patch).toHaveProperty("postRequestScript", STORED_POST);
	});
});
