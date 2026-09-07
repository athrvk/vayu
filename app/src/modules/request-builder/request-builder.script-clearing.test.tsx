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
 * Deleting a script has to reach the engine as a value (issue #1381), and
 * after issue #1512 a script is a `script.pre` / `script.post` element in
 * `request.elements` rather than its own field.
 *
 * `PUT /requests/:id` is a merge patch: a key that is present is written, and a
 * key that is *absent* leaves the stored value alone. `JSON.stringify` drops a
 * key whose value is `undefined`, so a payload built as
 * `request.elements.length ? request.elements : undefined` would turn the one
 * state that means "cleared down to nothing" into the one wire shape that
 * means "keep what you have". Emptying the Elements tab down to `[]` has to
 * save `elements: []`, not omit the key - `buildUpdatePayload` in
 * `./index.tsx` sends the whole list whenever `elements` is in the touched
 * set, empty array included, which is exactly what these cases pin.
 *
 * The save is driven through the real component rather than through the
 * payload builder alone, so the load-side seeding is in the path too.
 *
 * Since issue #1436: the payload carries only the fields the draft has
 * *touched* since its last known-good value, so `save()` below takes the
 * touched set the real provider would have computed, and an untouched
 * `elements` list is asserted absent from the patch rather than "sent
 * unchanged" - there is no more "unchanged" to resend once a field nobody
 * edited is never in the payload at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { ElementDef } from "@/types";
import type { RequestState, MergeableRequestField } from "./types";

const updateRequest = vi.fn();

/** One enabled `script.pre` / `script.post` element holding `script`. */
function scriptElement(kind: "script.pre" | "script.post", script: string): ElementDef {
	return { id: `el_${kind}`, kind, enabled: true, config: { script } };
}

const STORED_PRE = scriptElement("script.pre", "pm.environment.set('t', Date.now());");
const STORED_POST = scriptElement(
	"script.post",
	"pm.test('ok', () => pm.response.to.have.status(200));"
);

/** What the request query hands back - `elements` is the variable. */
let storedElements: ElementDef[] = [STORED_PRE, STORED_POST];

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
			elements: storedElements,
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
	storedElements = [STORED_PRE, STORED_POST];
	updateRequest.mockReset().mockResolvedValue({});
	providerProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.getState().setStreaming(false);
});

describe("clearing every element", () => {
	it("sends the empty array rather than dropping the key", async () => {
		renderBuilder();
		const patch = await save(seededState({ elements: [] }), ["elements"]);

		// `toHaveProperty` is the assertion that matters: an absent key is what
		// the engine reads as "keep the stored elements".
		expect(patch).toHaveProperty("elements");
		expect(patch?.elements).toEqual([]);
	});

	it("still refuses to send a blank name, which is a different rule", async () => {
		renderBuilder();
		const patch = await save(seededState({ name: "   ", elements: [] }), ["name", "elements"]);

		expect(patch).not.toHaveProperty("name");
		expect(patch?.elements).toEqual([]);
	});
});

describe("removing just one element", () => {
	it("sends the reduced array, keeping the element that was not removed", async () => {
		renderBuilder();
		// The sole `script.pre` element deleted from the list; `script.post`
		// untouched - both live in the one `elements` field, so removing one
		// still touches (and resends) the whole array, minus that entry.
		const patch = await save(seededState({ elements: [STORED_POST] }), ["elements"]);

		expect(patch?.elements).toEqual([STORED_POST]);
	});
});

describe("a stored request that never had an element", () => {
	it("seeds the editor with an empty array, not undefined", async () => {
		storedElements = [];
		renderBuilder();

		const initial = providerProps.initialRequest as Partial<RequestState>;
		expect(initial.elements).toEqual([]);
	});

	it("sends a touched, empty list even when it already matches what's stored", async () => {
		// Touching a field is "the user edited this control", not "the value
		// changed" - `setRequest`/`updateField` mark a field touched on every
		// call, so a field edited back to its starting value is still sent.
		storedElements = [];
		renderBuilder();
		const patch = await save(seededState(), ["elements"]);

		expect(patch).toHaveProperty("elements");
		expect(patch?.elements).toEqual([]);
	});
});

describe("elements the user kept", () => {
	it("is never resent when nothing about it was touched", async () => {
		// Before issue #1436's partial save, every save carried the whole
		// record, so untouched elements "rode along" unchanged. Now there is no
		// more riding along: a save carries only what changed, so editing the
		// URL alone must not also resend elements nobody edited.
		renderBuilder();
		const patch = await save(seededState({ url: "https://api.test/v2" }), ["url"]);

		expect(patch).toHaveProperty("url", "https://api.test/v2");
		expect(patch).not.toHaveProperty("elements");
	});
});
