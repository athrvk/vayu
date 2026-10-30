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
 * The Code section's snippet is composed from the body Send composes (#2638).
 *
 * Both paths are driven for real with one draft and one collection chain:
 * Send through the builder's `onExecute`, the Code section through
 * `composeForCode` reading the draft out of the `editorDraft` slot. Equal
 * compose bodies are the property; a field one of them adds or drops (a
 * hand-written copy, a different owner or collection) fails here. The bodies'
 * fields themselves are `compose-body.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore } from "@/stores";
import { useLiveCommandSurfaceStore } from "@/lib/commands/live-surfaces";
import type { Collection, ElementKindSchema } from "@/types";
import type { RequestState } from "./types";

const engineCompose = vi.fn();
const codeCompose = vi.fn();
const executeRequest = vi.fn();

/** A chain whose collection carries a script, so the elements walk is exercised. */
const CHAIN = [
	{
		id: "col_1",
		name: "Users",
		elements: [{ id: "el_1", kind: "script.pre", enabled: true, config: { code: "1" } }],
	},
] as unknown as Collection[];

/** The catalogue Send and the Code section both judge the draft's elements by. */
const KINDS = [
	{
		kind: "extract.json",
		version: 1,
		label: "Extract from JSON",
		description: "",
		category: "extract",
		hotPathClass: "declarative",
		collectionOnly: false,
		configSchema: { type: "object", required: ["variable"] },
		phases: [],
	},
] as ElementKindSchema[];

const requestQuery = {
	data: {
		id: "req_1",
		collectionId: "col_1",
		name: "Get user",
		method: "GET",
		url: "https://api.test/saved",
		params: [],
		headers: [],
		body: { mode: "none" },
		auth: { mode: "none" },
		elements: [],
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		verifySSL: true,
		disableCookies: false,
		disabledSystemHeaders: [],
		disableUrlEncoding: false,
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
		useCollectionAncestors: () => CHAIN,
		useElementKindsQuery: () => ({ data: KINDS }),
	};
});

vi.mock("@/hooks", () => ({
	useEngine: () => ({ composeRequest: engineCompose, executeRequest }),
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) => value,
		resolveString: (value: string) => value,
	}),
}));

vi.mock("@/services", () => ({
	apiService: { startLoadTest: vi.fn(), executeStreamRequest: vi.fn() },
	loadTestService: { startMonitoring: vi.fn() },
}));

vi.mock("@/services/api", () => ({
	apiService: { composeRequest: (...args: unknown[]) => codeCompose(...args) },
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
vi.mock("./components/EditorDraftSurface", () => ({ default: () => null }));
vi.mock("./components/LoadTestConfigDialog", () => ({ default: () => null }));

const { default: RequestBuilder } = await import("./index");
const { composeForCode } = await import("@/components/layout/context-bar/code-composition");

/** A draft ahead of the saved row: an edited URL, a header, a body and a script. */
const DRAFT: RequestState = {
	id: "req_1",
	collectionId: "col_1",
	name: "Get user",
	method: "POST",
	url: "https://api.test/edited/{{id}}",
	params: [],
	headers: [{ id: "h1", key: "X-Trace", value: "{{trace}}", enabled: true }],
	disabledDefaultHeaders: [],
	bodyMode: "json",
	body: '{"name":"ada"}',
	formData: [],
	urlEncoded: [],
	binaryFile: { src: "", unresolved: true },
	auth: { mode: "bearer", token: "{{token}}" },
	// The request's own element carries its owner's id into the body.
	elements: [
		{ id: "el_2", kind: "script.post", enabled: true, config: { code: "2" } },
	] as unknown as RequestState["elements"],
	followRedirects: false,
	maxRedirects: 3,
	timeout: null,
	httpVersion: "http2",
	verifySSL: false,
	disableCookies: false,
	disabledSystemHeaders: [],
	disableUrlEncoding: true,
	stream: false,
};

beforeEach(() => {
	engineCompose.mockReset().mockResolvedValue({ method: "POST", url: "https://api.test/x" });
	codeCompose.mockReset().mockResolvedValue({ method: "POST", url: "https://api.test/x" });
	executeRequest.mockReset().mockResolvedValue({ status: 200, body: "", bodyRaw: "" });
	providerProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useLiveCommandSurfaceStore.setState({ editorDraft: null });
});

/** Sends @p draft through the builder, then composes it for the Code section. */
async function sendAndCompose(draft: RequestState) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(<RequestBuilder />, { wrapper });
	const onExecute = providerProps.onExecute as (
		request: RequestState
	) => Promise<{ leftOutElements?: { element: { id: string } }[] } | null>;

	let response: Awaited<ReturnType<typeof onExecute>> = null;
	await act(async () => {
		response = await onExecute(draft);
	});
	useLiveCommandSurfaceStore.getState().registerSurface("editorDraft", {
		requestId: "req_1",
		read: () => ({ request: draft, ancestors: CHAIN, elementKinds: KINDS }),
	});
	await composeForCode("req_1", "env_1");

	expect(engineCompose).toHaveBeenCalledTimes(1);
	expect(codeCompose).toHaveBeenCalledTimes(1);
	return {
		response: response as Awaited<ReturnType<typeof onExecute>>,
		sendBody: engineCompose.mock.calls[0][0] as Record<string, unknown>,
		codeBody: codeCompose.mock.calls[0][0] as unknown,
	};
}

describe("the Code section composes what Send composes (#2638)", () => {
	it("hands POST /compose the same body for the same draft", async () => {
		const { sendBody, codeBody } = await sendAndCompose(DRAFT);

		// Guards the comparison itself: an inline body with the chain's script
		// and the request's own, stamped with its owner.
		expect(sendBody).toMatchObject({
			request: {
				url: DRAFT.url,
				elements: [
					{ id: "el_1" },
					{ id: "el_2", origin: { kind: "request", id: "req_1" } },
				],
			},
			collectionId: "col_1",
			environmentId: "env_1",
		});
		expect(codeBody).toEqual(sendBody);
	});
});

describe("Send leaves out the draft's disabled and incomplete elements (#3066)", () => {
	const UNFINISHED = [
		{ id: "el_2", kind: "script.post", enabled: true, config: { code: "2" } },
		// The operand rule: no accepted codes or range.
		{ id: "el_assert", kind: "assert.status", enabled: true, config: {} },
		// The catalogue's required key.
		{ id: "el_extract", kind: "extract.json", enabled: true, config: {} },
		{ id: "el_off", kind: "script.post", enabled: false, config: { code: "3" } },
	] as unknown as RequestState["elements"];
	const DRAFT_WITH_UNFINISHED: RequestState = { ...DRAFT, elements: UNFINISHED };

	it("sends the request without them, and the Code section composes the same", async () => {
		const { sendBody, codeBody } = await sendAndCompose(DRAFT_WITH_UNFINISHED);

		const sentIds = (sendBody.request as { elements: { id: string }[] }).elements.map(
			(e) => e.id
		);
		expect(sentIds).toEqual(["el_1", "el_2"]);
		expect(codeBody).toEqual(sendBody);
	});

	it("hands the incomplete ones back with the response, and not the switched-off one", async () => {
		const { response } = await sendAndCompose(DRAFT_WITH_UNFINISHED);

		expect(response?.leftOutElements?.map((l) => l.element.id)).toEqual([
			"el_assert",
			"el_extract",
		]);
	});

	it("carries no left-out list on a send that left nothing out", async () => {
		const { response } = await sendAndCompose(DRAFT);

		expect(response).not.toHaveProperty("leftOutElements");
	});
});
