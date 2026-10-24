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
 * What the builder hands the load dialog about a script-set OAuth 2.0 name
 * (#2742). The dialog's own suite takes `oauth2DeferredNames` as given; nothing
 * else proves the builder derives it from the config *as written* (the
 * `oauth2Config` it also passes is already resolved, so a name with a stored
 * value is gone from it), through the request's inherited auth too, and asks
 * `/compose` only when there is a `{{token}}` to ask about.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTabsStore, useSessionStore } from "@/stores";
import type { Collection, OAuth2Config } from "@/types";
import type { RequestState } from "./types";

let ancestors: Collection[] = [];
/** What the engine's composition says a pre-request script sets. */
let engineDeferred: readonly string[] = [];
const useDeferredVariables = vi.fn((_requestId: string, _enabled: boolean) => engineDeferred);

vi.mock("@/components/layout/context-bar/code-composition", () => ({
	useDeferredVariables: (requestId: string, enabled: boolean) =>
		useDeferredVariables(requestId, enabled),
}));

vi.mock("@/queries", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/queries")>();
	return {
		...actual,
		useRequestQuery: () => ({
			data: {
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
				disableCookies: false,
				disabledSystemHeaders: [],
				disableUrlEncoding: false,
				stream: false,
			},
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		}),
		useUpdateRequestMutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn() }),
		useCollectionAncestors: () => ancestors,
	};
});

/** The preview resolver swaps a stored value in, so the token is gone from its output. */
vi.mock("@/hooks", () => ({
	useEngine: () => ({ composeRequest: vi.fn(), executeRequest: vi.fn() }),
	useVariableResolver: () => ({
		resolveObject: <T,>(value: T) =>
			JSON.parse(JSON.stringify(value).split("{{clientId}}").join("stored-id")) as T,
		resolveString: (value: string) => value,
	}),
}));

vi.mock("@/services", () => ({
	apiService: { startLoadTest: vi.fn(), executeStreamRequest: vi.fn() },
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

const OAUTH2: OAuth2Config = {
	grantType: "client_credentials",
	accessTokenUrl: "https://auth.example.com/token",
	clientId: "{{clientId}}",
	scope: "{{scope}}",
};

function requestWith(auth: RequestState["auth"]): RequestState {
	return {
		id: "req_1",
		collectionId: "col_1",
		name: "Get user",
		method: "GET",
		url: "https://api.test/u",
		params: [],
		headers: [],
		disabledDefaultHeaders: [],
		bodyMode: "none",
		body: "",
		formData: [],
		urlEncoded: [],
		binaryFile: { src: "", unresolved: true },
		auth,
		elements: [],
		followRedirects: true,
		maxRedirects: 10,
		httpVersion: "auto",
		verifySSL: true,
		disableCookies: false,
		disabledSystemHeaders: [],
		disableUrlEncoding: false,
		stream: false,
	};
}

function collectionWith(auth: Collection["auth"]): Collection {
	return {
		id: "col_1",
		name: "Root",
		description: "",
		order: 0,
		variables: {},
		auth,
		elements: [],
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

async function openLoadDialog(auth: RequestState["auth"]) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	render(<RequestBuilder />, { wrapper });
	await act(async () => {
		(providerProps.onStartLoadTest as (request: RequestState) => void)(requestWith(auth));
	});
}

beforeEach(() => {
	providerProps = {};
	dialogProps = {};
	ancestors = [];
	engineDeferred = [];
	useDeferredVariables.mockClear();
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1", title: "Req" } as never],
		activeTabId: "t1",
	});
	useSessionStore.setState({ activeEnvironmentId: "env_1" });
});

describe("the load dialog's OAuth 2.0 deferred names", () => {
	it("names the engine's deferred names the as-written config uses, though the resolved one lost one", async () => {
		engineDeferred = ["clientId", "scope", "unrelatedToken"];
		await openLoadDialog({ mode: "oauth2", config: OAUTH2 });

		expect(dialogProps.oauth2DeferredNames).toEqual(["clientId", "scope"]);
		// The preview resolved `{{clientId}}` to its stored value, so it is the raw
		// config that names it.
		expect((dialogProps.oauth2Config as OAuth2Config).clientId).toBe("stored-id");
	});

	it("reads an inherited collection's config the same way", async () => {
		ancestors = [collectionWith({ mode: "oauth2", config: OAUTH2 })];
		engineDeferred = ["scope"];
		await openLoadDialog({ mode: "inherit" });

		expect(dialogProps.oauth2DeferredNames).toEqual(["scope"]);
	});

	it("names nothing for a request whose effective auth is not OAuth 2.0", async () => {
		engineDeferred = ["clientId"];
		await openLoadDialog({ mode: "bearer", token: "{{clientId}}" });

		expect(dialogProps.oauth2DeferredNames).toEqual([]);
		expect(dialogProps.oauth2Config).toBeUndefined();
	});

	it("asks the engine's composition while the config holds a token", async () => {
		await openLoadDialog({ mode: "oauth2", config: OAUTH2 });

		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", true);
	});

	it("costs no composition for a config with no token in it", async () => {
		await openLoadDialog({
			mode: "oauth2",
			config: { ...OAUTH2, clientId: "id", scope: "read" },
		});

		expect(useDeferredVariables).toHaveBeenLastCalledWith("req_1", false);
	});
});
