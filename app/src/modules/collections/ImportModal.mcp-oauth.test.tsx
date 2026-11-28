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
 * The MCP server tab's OAuth sign-in (#3983): Connect signs in through the shared flow, sends the
 * token the engine cached as the route's bearer token, and previews a root that holds the sign-in's
 * config and no token. The browser step is `authorize.test.ts`'s; it is stubbed here at
 * `runInteractiveAuthorization`, and the engine's answers at `apiService`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { OAuth2AuthorizeResolved, OAuth2Config, OAuth2TokenResponse } from "@/types";
import type { InteractiveAuthResult } from "@/services/oauth/authorize";

const applied = vi.hoisted(() => ({ mutate: vi.fn() }));
const signIn = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({ mutateAsync: applied.mutate, isPending: false }),
}));

vi.mock("@/services/oauth/authorize", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/oauth/authorize")>()),
	runInteractiveAuthorization: signIn.run,
}));

import { useImportModalStore, useToastStore } from "@/stores";
import { oauthSignin, useOAuthSigninStore } from "@/stores/oauth-signin-store";
import { apiService } from "@/services/api";
import { InteractiveAuthError } from "@/services/oauth/authorize";
import {
	SERVER,
	connectButton,
	lastPayload,
	openMcpTab,
	serverTree,
	tokenInput,
	typeUrl,
	urlInput,
} from "./import-mcp-tab.testkit";

/** What the engine's discovery found for `SERVER`, as the authorize start answers it. */
const RESOLVED: OAuth2AuthorizeResolved = {
	authorizationUrl: "https://auth.example.com/authorize",
	accessTokenUrl: "https://auth.example.com/token",
	clientId: "registered-client",
	resource: SERVER,
	scope: "tools:read",
	issuer: "https://auth.example.com",
};

const ACCESS_TOKEN = "oauth-access-token";

function cachedToken(): OAuth2TokenResponse {
	return {
		cacheKey: "key",
		accessToken: ACCESS_TOKEN,
		tokenType: "Bearer",
		expiresIn: 3600,
		createdAt: 0,
		expiresAt: 3_600_000,
		hasRefreshToken: true,
	};
}

function oauthChoice(): HTMLButtonElement {
	return screen.getByRole("radio", { name: "OAuth sign-in" }) as HTMLButtonElement;
}

function chooseOAuth() {
	fireEvent.click(oauthChoice());
}

/** The sign-in a test settles by hand, with the signal the dialog handed it. */
function pendingSignIn() {
	let resolve!: (value: InteractiveAuthResult) => void;
	let reject!: (reason: unknown) => void;
	signIn.run.mockImplementation(
		() =>
			new Promise<InteractiveAuthResult>((res, rej) => {
				resolve = res;
				reject = rej;
			})
	);
	return {
		resolve: (v: InteractiveAuthResult) => resolve(v),
		reject: (e: unknown) => reject(e),
		signal: () => signIn.run.mock.calls[0][1] as AbortSignal,
	};
}

describe("ImportModal MCP server tab: OAuth sign-in", () => {
	let importMcp: ReturnType<typeof vi.spyOn>;
	let fetchToken: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.restoreAllMocks();
		signIn.run.mockReset();
		signIn.run.mockResolvedValue({ cacheKey: "key", resolved: RESOLVED });
		applied.mutate.mockReset();
		applied.mutate.mockResolvedValue({
			idMap: { c1: "col_1" },
			rootIds: { c1: "col_1" },
			environmentIds: {},
		});
		vi.stubGlobal("electronAPI", { openExternalUrl: vi.fn(), log: vi.fn() });
		importMcp = vi
			.spyOn(apiService, "importMcp")
			.mockResolvedValue(serverTree({ withToken: true }));
		fetchToken = vi.spyOn(apiService, "fetchOAuth2Token").mockResolvedValue(cachedToken());
		vi.spyOn(apiService, "importMcpDiff").mockResolvedValue({ matches: [] });
		useToastStore.setState({ toasts: [] });
		useImportModalStore.setState({ isOpen: true });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("signs in to the server's URL with discovery, and posts the cached token as the bearer auth", async () => {
		openMcpTab();
		typeUrl(`  ${SERVER}  `);
		fireEvent.change(tokenInput(), { target: { value: "typed-static-token" } });
		chooseOAuth();
		fireEvent.click(connectButton());

		await waitFor(() => expect(importMcp).toHaveBeenCalledTimes(1));
		const [sent, signal] = signIn.run.mock.calls[0] as [OAuth2Config, AbortSignal];
		expect(sent).toMatchObject({ grantType: "authorization_code", discoverUrl: SERVER });
		expect(signal).toBeInstanceOf(AbortSignal);
		// The token is asked for under the config the sign-in filled, which is what it keyed.
		expect(fetchToken).toHaveBeenCalledWith({
			config: expect.objectContaining({
				accessTokenUrl: RESOLVED.accessTokenUrl,
				clientId: RESOLVED.clientId,
				discoverUrl: SERVER,
			}),
		});
		expect(lastPayload(importMcp)).toEqual({
			url: SERVER,
			auth: { mode: "bearer", token: ACCESS_TOKEN },
			include: { tools: true, resources: false, prompts: false },
		});
	});

	it("previews and applies a root on the signed-in config, holding no token", async () => {
		openMcpTab();
		typeUrl();
		chooseOAuth();
		fireEvent.click(connectButton());
		await screen.findByText("search_docs");

		// The token variable went with the bearer root, and its line with it.
		expect(screen.queryByText(/set the mcpToken variable/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /^Import →$/ }));

		await waitFor(() => expect(applied.mutate).toHaveBeenCalledTimes(1));
		const tree = applied.mutate.mock.calls[0][0].result;
		const [root] = tree.collections;
		expect(root.auth).toEqual({
			mode: "oauth2",
			config: expect.objectContaining({
				grantType: "authorization_code",
				discoverUrl: SERVER,
				authorizationUrl: RESOLVED.authorizationUrl,
				accessTokenUrl: RESOLVED.accessTokenUrl,
				clientId: RESOLVED.clientId,
				resource: RESOLVED.resource,
				scope: RESOLVED.scope,
				discoveredFields: [
					"authorizationUrl",
					"accessTokenUrl",
					"clientId",
					"resource",
					"scope",
				],
			}),
		});
		expect(root.variables).not.toHaveProperty("mcpToken");
		expect(JSON.stringify(tree)).not.toContain(ACCESS_TOKEN);
	});

	it("names the sign-in while it waits on the browser, then the connect", async () => {
		const pending = pendingSignIn();
		openMcpTab();
		typeUrl();
		chooseOAuth();
		fireEvent.click(connectButton());

		expect(await screen.findByText("Signing in to the server")).toBeInTheDocument();
		expect(useOAuthSigninStore.getState().active.size).toBe(1);

		pending.resolve({ cacheKey: "key", resolved: RESOLVED });
		expect(await screen.findByText("search_docs")).toBeInTheDocument();
		expect(useOAuthSigninStore.getState().active.size).toBe(0);
	});

	it("keeps what was typed and shows the sign-in's error, connecting to nothing", async () => {
		signIn.run.mockRejectedValue(new InteractiveAuthError("access_denied: the user said no"));
		openMcpTab();
		typeUrl();
		chooseOAuth();
		fireEvent.click(connectButton());

		expect(await screen.findByText(/access_denied: the user said no/)).toBeInTheDocument();
		expect(importMcp).not.toHaveBeenCalled();
		expect(urlInput().value).toBe(SERVER);
		expect(oauthChoice()).toHaveAttribute("data-state", "on");
		expect(connectButton()).toBeEnabled();
	});

	it("shows the engine's refusal of the token the same way", async () => {
		fetchToken.mockRejectedValue(new Error("OAuth 2.0 authorization required"));
		openMcpTab();
		typeUrl();
		chooseOAuth();
		fireEvent.click(connectButton());

		expect(await screen.findByText(/authorization required/)).toBeInTheDocument();
		expect(importMcp).not.toHaveBeenCalled();
	});

	it("cancels the sign-in when the dialog closes, and reports nothing", async () => {
		const pending = pendingSignIn();
		openMcpTab();
		typeUrl();
		chooseOAuth();
		fireEvent.click(connectButton());
		await waitFor(() => expect(signIn.run).toHaveBeenCalledTimes(1));

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		await waitFor(() => expect(useImportModalStore.getState().isOpen).toBe(false));

		expect(pending.signal().aborted).toBe(true);
		expect(useOAuthSigninStore.getState().active.size).toBe(0);
		pending.reject(new InteractiveAuthError("Sign-in cancelled."));
		useImportModalStore.setState({ isOpen: true });
		await screen.findByLabelText("Server URL");
		expect(screen.queryByText(/cancelled/)).toBeNull();
		expect(importMcp).not.toHaveBeenCalled();
	});

	it("starts no second sign-in to a server another surface is signing in to", async () => {
		const elsewhere = oauthSignin.begin(`discover:${SERVER}`);
		openMcpTab();
		typeUrl();
		chooseOAuth();
		fireEvent.click(connectButton());

		expect(await screen.findByText(/already running/)).toBeInTheDocument();
		expect(signIn.run).not.toHaveBeenCalled();
		if (elsewhere) oauthSignin.end(`discover:${SERVER}`, elsewhere);
	});

	it("sends a static token unchanged when the token is chosen", async () => {
		openMcpTab();
		typeUrl();
		fireEvent.change(tokenInput(), { target: { value: "s3cret" } });
		fireEvent.click(connectButton());

		await waitFor(() => expect(importMcp).toHaveBeenCalledTimes(1));
		expect(signIn.run).not.toHaveBeenCalled();
		expect(lastPayload(importMcp).auth).toEqual({ mode: "bearer", token: "s3cret" });
	});

	describe("is a desktop feature", () => {
		it("is offered where the desktop bridge is", () => {
			openMcpTab();

			expect(oauthChoice()).toBeEnabled();
		});

		it("is off without the bridge, and says why", async () => {
			vi.stubGlobal("electronAPI", undefined);
			openMcpTab();

			expect(oauthChoice()).toBeDisabled();
			const hint = oauthChoice().closest('[data-slot="disabled-hint"]') as HTMLElement;
			fireEvent.focus(hint);
			expect(
				(await screen.findAllByText("OAuth sign-in needs the Vayu desktop app.")).length
			).toBeGreaterThan(0);
		});
	});
});
