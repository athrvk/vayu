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
 * What the builder tells the load test dialog about its target (#2117).
 *
 * The dialog names the host and decides its off-network advisory from the URL
 * it is handed, so that URL has to be the variable-resolved one: a request
 * written as `{{baseUrl}}/pets` reaching the dialog as written would read as an
 * unknown host however the environment is set. The dialog's own rendering is
 * `LoadTestConfigDialog.test.tsx`; this pins the wiring between the two.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { VARIABLE_PATTERN } from "@/constants/variables";
import { useTabsStore, useSessionStore, useDashboardStore } from "@/stores";
import type { RequestState } from "./types";

/** The active environment, as the resolver mock reads it. */
let variables: Record<string, string> = {};

const composeRequest = vi.fn();
const executeRequest = vi.fn();
const startLoadTest = vi.fn();

const requestQuery = {
	data: {
		id: "req_1",
		collectionId: "col_1",
		name: "List pets",
		method: "GET",
		url: "https://api.test/pets",
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
		useCollectionAncestors: () => [],
	};
});

vi.mock("@/hooks", () => ({
	useEngine: () => ({ composeRequest, executeRequest }),
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) => value,
		// The environment's answer: a name with a value is replaced, one without
		// stays a token, exactly as the real resolver leaves it.
		resolveString: (value: string) =>
			value.replace(VARIABLE_PATTERN, (token, name: string) => variables[name] ?? token),
	}),
}));

vi.mock("@/services", () => ({
	apiService: { startLoadTest, executeStreamRequest: vi.fn() },
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

const REQUEST: RequestState = {
	id: "req_1",
	collectionId: "col_1",
	name: "List pets",
	method: "GET",
	url: "https://api.test/pets",
	params: [],
	headers: [],
	disabledDefaultHeaders: [],
	bodyMode: "none",
	body: "",
	formData: [],
	urlEncoded: [],
	binaryFile: { src: "", unresolved: true },
	auth: { mode: "none" },
	elements: [],
	followRedirects: true,
	maxRedirects: 10,
	timeout: null,
	httpVersion: "auto",
	verifySSL: true,
	disableCookies: false,
	disabledSystemHeaders: [],
	disableUrlEncoding: false,
	stream: false,
};

function renderBuilder() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(<RequestBuilder />, { wrapper });
}

const WITH_VARIABLE: RequestState = {
	...REQUEST,
	method: "POST",
	url: "{{baseUrl}}/pets",
};

async function openLoadDialog(request: RequestState) {
	renderBuilder();
	await act(async () => {
		(providerProps.onStartLoadTest as (request: RequestState) => void)(request);
	});
}

beforeEach(() => {
	variables = {};
	providerProps = {};
	dialogProps = {};
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
	useDashboardStore.getState().setStreaming(false);
});

describe("the load test dialog's target", () => {
	it("is the request's method and its URL with the environment's variables resolved", async () => {
		variables = { baseUrl: "https://api.example.com" };
		await openLoadDialog(WITH_VARIABLE);

		expect(dialogProps.method).toBe("POST");
		expect(dialogProps.url).toBe("https://api.example.com/pets");
	});

	it("keeps a variable the environment has no value for as a token", async () => {
		await openLoadDialog(WITH_VARIABLE);

		expect(dialogProps.url).toBe("{{baseUrl}}/pets");
	});

	it("follows the draft, not the stored row", async () => {
		variables = { baseUrl: "http://localhost:3000" };
		await openLoadDialog({ ...WITH_VARIABLE, url: "{{baseUrl}}/draft-edit" });

		expect(dialogProps.url).toBe("http://localhost:3000/draft-edit");
	});
});
