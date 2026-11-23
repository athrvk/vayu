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
 * A 403 `insufficient_scope` names the scopes it needs and offers one person's
 * re-authorization with them added (#3766). The classification is the engine's
 * (`POST /oauth2/step-up`, stubbed here), and the pane never retries by itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/queries/keys";
import type { OAuth2Config, RequestAuth } from "@/types";
import type { ResponseState } from "../../types";

vi.mock("@/components/ui/code-editor", () => ({
	CodeEditor: () => <div data-testid="code-editor" />,
}));

const classify = vi.fn();
vi.mock("@/services/api", () => ({
	apiService: { classifyOAuth2StepUp: (...a: unknown[]) => classify(...a) as unknown },
}));

const authorize = vi.fn();
vi.mock("@/services/oauth/authorize", () => ({
	runInteractiveAuthorization: (...a: unknown[]) => authorize(...a) as unknown,
}));
vi.mock("@/services/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/notify")>()),
	systemNotify: { post: vi.fn(), availability: vi.fn() },
}));

const updateField = vi.fn();
const builder = vi.hoisted(() => ({
	response: null as ResponseState | null,
	auth: { mode: "none" } as RequestAuth,
}));
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => ({
		response: builder.response,
		isExecuting: false,
		request: { id: "req_1", auth: builder.auth },
		updateField,
		resolveString: (s: string) => s,
	}),
}));

const { default: ResponseViewer } = await import("./index");

const CONFIG: OAuth2Config = {
	grantType: "authorization_code",
	authorizationUrl: "https://auth.example.com/authorize",
	accessTokenUrl: "https://auth.example.com/token",
	clientId: "cid",
	scope: "mcp:read",
};
const CHALLENGE = 'Bearer error="insufficient_scope", scope="mcp:write"';
const STEP_UP = {
	stepUp: true,
	error: "insufficient_scope",
	requiredScopes: ["mcp:write"],
	scope: "mcp:read mcp:write",
	description: "",
};

function renderWith(
	response: Partial<ResponseState>,
	auth: RequestAuth,
	seed?: (client: QueryClient) => void
) {
	builder.auth = auth;
	builder.response = {
		status: 403,
		statusText: "Forbidden",
		headers: { "www-authenticate": CHALLENGE },
		body: "",
		size: 0,
		time: 5,
		...response,
	};
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	seed?.(client);
	render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ResponseViewer />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const reauthorize = () => screen.queryByRole("button", { name: "Re-authorize" });

beforeEach(() => {
	classify.mockReset();
	authorize.mockReset();
	updateField.mockReset();
});

describe("a 403 the engine classifies as a step-up", () => {
	it("asks the engine with the challenge and the scope already requested", async () => {
		classify.mockResolvedValue(STEP_UP);
		renderWith({}, { mode: "oauth2", config: CONFIG });

		expect(await screen.findByText("More scope needed")).toBeInTheDocument();
		expect(classify).toHaveBeenCalledWith({ wwwAuthenticate: [CHALLENGE], scope: "mcp:read" });
		expect(screen.getByText("mcp:write")).toBeInTheDocument();
	});

	it("re-authorizes with the union of scopes and stores it in the request's config", async () => {
		classify.mockResolvedValue(STEP_UP);
		authorize.mockResolvedValue({ cacheKey: "k" });
		renderWith({}, { mode: "oauth2", config: CONFIG });

		fireEvent.click(await screen.findByRole("button", { name: "Re-authorize" }));

		await waitFor(() => expect(updateField).toHaveBeenCalledTimes(1));
		expect(authorize).toHaveBeenCalledWith(
			{ ...CONFIG, scope: "mcp:read mcp:write" },
			expect.any(AbortSignal)
		);
		expect(updateField).toHaveBeenCalledWith("auth", {
			mode: "oauth2",
			config: { ...CONFIG, scope: "mcp:read mcp:write" },
		});
	});

	it("stores nothing when the sign-in fails", async () => {
		classify.mockResolvedValue(STEP_UP);
		authorize.mockRejectedValue(new Error("access_denied"));
		renderWith({}, { mode: "oauth2", config: CONFIG });

		fireEvent.click(await screen.findByRole("button", { name: "Re-authorize" }));

		await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(reauthorize()).toBeEnabled());
		expect(updateField).not.toHaveBeenCalled();
	});

	it("names the scopes without a sign-in for a grant that has none", async () => {
		classify.mockResolvedValue(STEP_UP);
		renderWith({}, { mode: "oauth2", config: { ...CONFIG, grantType: "client_credentials" } });

		expect(await screen.findByText("More scope needed")).toBeInTheDocument();
		expect(reauthorize()).toBeNull();
	});
});

describe("a response that is not a step-up", () => {
	it("shows nothing when the engine reads another error", () => {
		// The engine's answer is already cached, so the first render is the
		// settled one: there is no landing to wait for.
		renderWith({}, { mode: "oauth2", config: CONFIG }, (client) =>
			client.setQueryData(queryKeys.oauth.stepUp([CHALLENGE], "mcp:read"), {
				stepUp: false,
				error: "invalid_token",
				requiredScopes: [],
				scope: "",
				description: "",
			})
		);

		expect(screen.queryByText("More scope needed")).toBeNull();
		expect(classify).not.toHaveBeenCalled();
	});

	it.each([
		["a 401", { status: 401 }],
		["a 403 with no challenge", { headers: {} }],
	])("does not ask the engine about %s", (_case, response) => {
		renderWith(response, { mode: "oauth2", config: CONFIG });

		expect(classify).not.toHaveBeenCalled();
		expect(screen.queryByText("More scope needed")).toBeNull();
	});

	it("does not ask about a request whose own auth is not OAuth 2.0", () => {
		renderWith({}, { mode: "inherit" });

		expect(classify).not.toHaveBeenCalled();
	});
});
