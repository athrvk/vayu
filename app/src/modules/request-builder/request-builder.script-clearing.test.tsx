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
 *
 * Updated for issue #1436: the payload now carries only the fields the draft
 * has *touched* since its last known-good value, so `save()` below takes the
 * touched set the real provider would have computed, and an untouched script
 * is asserted absent from the patch rather than "sent unchanged" - there is no
 * more "unchanged" to resend once a field nobody edited is never in the
 * payload at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { RequestState, MergeableRequestField } from "./types";

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
		const patch = await save(seededState({ preRequestScript: "", testScript: "" }), [
			"preRequestScript",
			"testScript",
		]);

		// `toHaveProperty` is the assertion that matters: an absent key is what
		// the engine reads as "keep the stored script".
		expect(patch).toHaveProperty("preRequestScript", "");
		expect(patch).toHaveProperty("postRequestScript", "");
	});

	it("clears one script without touching the other", async () => {
		renderBuilder();
		const patch = await save(seededState({ testScript: "" }), ["testScript"]);

		expect(patch).toHaveProperty("postRequestScript", "");
		// Untouched, so it is not in the payload at all any more (issue #1436) -
		// the engine's merge-patch already leaves an absent key alone, which is
		// the correct "not sent" for a field nobody edited.
		expect(patch).not.toHaveProperty("preRequestScript");
	});

	it("still refuses to send a blank name, which is a different rule", async () => {
		renderBuilder();
		const patch = await save(seededState({ name: "   ", testScript: "" }), [
			"name",
			"testScript",
		]);

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

	it("sends a touched script even when its value already matches what's stored", async () => {
		// Touching a field is "the user edited this control", not "the value
		// changed" - `setRequest`/`updateField` mark a field touched on every
		// call, so a field edited back to its starting value is still sent.
		storedScripts = {};
		renderBuilder();
		const patch = await save(seededState(), ["preRequestScript", "testScript"]);

		expect(patch).toHaveProperty("preRequestScript", "");
		expect(patch).toHaveProperty("postRequestScript", "");
	});
});

describe("a script the user kept", () => {
	it("is never resent when nothing about it was touched", async () => {
		// Before issue #1436's partial save, every save carried the whole
		// record, so an untouched script "rode along" unchanged. Now there is no
		// more riding along: a save carries only what changed, so editing the
		// URL alone must not also resend scripts nobody edited.
		renderBuilder();
		const patch = await save(seededState({ url: "https://api.test/v2" }), ["url"]);

		expect(patch).toHaveProperty("url", "https://api.test/v2");
		expect(patch).not.toHaveProperty("preRequestScript");
		expect(patch).not.toHaveProperty("postRequestScript");
	});
});
