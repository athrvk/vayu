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
 * The row used to *disappear* while the config was incomplete - it returned a
 * bare sentence in place of the whole bordered box, so the primary action of the
 * OAuth 2.0 editor was absent exactly when a first-time user was looking for it,
 * and then appeared once two unrelated fields happened to be filled. It now
 * always renders and disables the button instead, so the affordance is visible
 * and the reason it cannot be used is stated next to it.
 *
 * Radix tooltips do not fire on a `disabled` button, so the reason has to live
 * in the row's own text - that is what these tests assert, not a title.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { ApiError } from "@/services/http-client";
import type { OAuth2Config } from "@/types";
import TokenStatusRow from "./TokenStatusRow";
import { NOTIFY_KINDS } from "@/services/notify";

const fetchMutation = { mutate: vi.fn(), isPending: false };
const clearMutation = { mutate: vi.fn(), isPending: false };
const statusQuery = { data: undefined as unknown };
const showToast = vi.fn();

vi.mock("@/queries/oauth", () => ({
	useOAuth2TokenStatusQuery: () => statusQuery,
	useFetchOAuth2TokenMutation: () => fetchMutation,
	useClearOAuth2TokenMutation: () => clearMutation,
}));

vi.mock("@/stores", () => ({
	useToastStore: (select: (state: { showToast: typeof showToast }) => unknown) =>
		select({ showToast }),
	// Read by `services/notify`, which this row calls on a completed sign-in.
	useClientSettingsStore: { getState: () => ({ systemNotifications: false }) },
}));

// The loopback flow puts the user in their browser by design, so its success is
// one they may not be looking at (#1358).
const authorize = vi.fn();
vi.mock("@/services/oauth/authorize", () => ({
	runInteractiveAuthorization: (...args: unknown[]) => authorize(...args) as unknown,
}));
const { mockNotifyPost } = vi.hoisted(() => ({ mockNotifyPost: vi.fn() }));
vi.mock("@/services/notify", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/services/notify")>()),
	systemNotify: { post: mockNotifyPost, availability: vi.fn() },
}));

function config(overrides: Partial<OAuth2Config> = {}): OAuth2Config {
	return {
		grantType: "client_credentials",
		accessTokenUrl: "",
		clientId: "",
		...overrides,
	};
}

function renderRow(cfg: OAuth2Config) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<TokenStatusRow resolvedConfig={cfg} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const getTokenButton = () => screen.getByRole("button", { name: /get token/i });

beforeEach(() => {
	fetchMutation.mutate.mockReset();
	clearMutation.mutate.mockReset();
	showToast.mockReset();
	authorize.mockReset();
	mockNotifyPost.mockReset();
	statusQuery.data = undefined;
});

describe("TokenStatusRow with an incomplete config", () => {
	it("still renders the Get Token button, disabled", () => {
		renderRow(config());

		expect(getTokenButton()).toBeDisabled();
	});

	it("names the missing fields exactly as their labels read", () => {
		// "Access Token URL" / "Client ID", not the spec's "token endpoint" and
		// not a paraphrase - the sentence has to point at controls on screen.
		renderRow(config());

		expect(screen.getByText(/Access Token URL and Client ID/)).toBeInTheDocument();
	});

	it("names only the field still missing once the other is filled", () => {
		renderRow(config({ accessTokenUrl: "https://idp.example.com/token" }));

		const text = screen.getByText(/to fetch a token/i).textContent ?? "";
		expect(text).toMatch(/Client ID/);
		expect(text).not.toMatch(/Access Token URL/);
	});

	it("requires the authorization URL for the interactive grant", () => {
		// The engine's authorize-start rejects without it, so a config that would
		// pass the token-cache key check is still not fetchable here.
		renderRow(
			config({
				grantType: "authorization_code",
				accessTokenUrl: "https://idp.example.com/token",
				clientId: "abc",
			})
		);

		expect(getTokenButton()).toBeDisabled();
		expect(screen.getByText(/Authorization URL/)).toBeInTheDocument();
	});

	it("still gives the reason when a stale token occupies the summary line", () => {
		// The cache key omits grantType, so a token fetched under Client
		// Credentials is still on screen after a switch to Authorization Code -
		// the summary line shows it, and the reason the button is dead has to
		// land somewhere else rather than nowhere.
		statusQuery.data = {
			found: true,
			expired: false,
			token: { accessToken: "ya29.abcdefghijkl", expiresAt: null },
		};

		renderRow(
			config({
				grantType: "authorization_code",
				accessTokenUrl: "https://idp.example.com/token",
				clientId: "abc",
			})
		);

		// The action reads "Renew" once a token is cached, not "Get Token".
		expect(screen.getByRole("button", { name: /renew/i })).toBeDisabled();
		expect(screen.getByText(/Authorization URL/)).toBeInTheDocument();
	});

	it("does not fetch when the button is activated anyway", () => {
		renderRow(config());

		fireEvent.click(getTokenButton());

		expect(fetchMutation.mutate).not.toHaveBeenCalled();
	});
});

describe("TokenStatusRow with a complete config", () => {
	const complete = config({
		accessTokenUrl: "https://idp.example.com/token",
		clientId: "abc",
	});

	it("enables the Get Token button", () => {
		renderRow(complete);

		expect(getTokenButton()).toBeEnabled();
	});

	it("says no token is cached rather than listing missing fields", () => {
		renderRow(complete);

		expect(screen.getByText(/No token cached/i)).toBeInTheDocument();
		expect(screen.queryByText(/to fetch a token/i)).not.toBeInTheDocument();
	});

	it("fetches on click", () => {
		renderRow(complete);

		fireEvent.click(getTokenButton());

		expect(fetchMutation.mutate).toHaveBeenCalledTimes(1);
	});

	it("relabels the engine's field names in the failure toast", () => {
		// A URL the engine rejects gets past this gate on purpose - the gate is
		// presence-only. What the user must not read back is `accessTokenUrl`,
		// which names nothing on their screen.
		fetchMutation.mutate.mockImplementation(
			(_vars: unknown, opts?: { onError?: (e: unknown) => void }) => {
				opts?.onError?.(
					new ApiError(
						400,
						"oauth2_invalid_config",
						"accessTokenUrl must be an http(s) URL"
					)
				);
			}
		);

		renderRow(config({ accessTokenUrl: "idp.example.com/token", clientId: "abc" }));
		fireEvent.click(getTokenButton());

		expect(showToast).toHaveBeenCalledWith("Access Token URL must be an http(s) URL", "error");
	});

	it("tells the user their sign-in landed, since the browser had them", async () => {
		authorize.mockResolvedValue(undefined);

		renderRow(
			config({
				grantType: "authorization_code",
				authorizationUrl: "https://idp.example.com/authorize",
				accessTokenUrl: "https://idp.example.com/token",
				clientId: "abc",
			})
		);
		fireEvent.click(getTokenButton());

		// Beside the toast, never instead of it: a user who stayed in Vayu sees
		// the toast, and the notification is suppressed for them in main.
		await waitFor(() => expect(showToast).toHaveBeenCalledWith("Authorized", "success"));
		expect(mockNotifyPost).toHaveBeenCalledWith({
			kind: NOTIFY_KINDS.signedIn,
			title: "Signed in",
			body: "Back to Vayu to continue.",
		});
	});

	it("says nothing to the OS when the sign-in failed", async () => {
		authorize.mockRejectedValue(new Error("state mismatch"));

		renderRow(
			config({
				grantType: "authorization_code",
				authorizationUrl: "https://idp.example.com/authorize",
				accessTokenUrl: "https://idp.example.com/token",
				clientId: "abc",
			})
		);
		fireEvent.click(getTokenButton());

		await waitFor(() => expect(showToast).toHaveBeenCalled());
		expect(mockNotifyPost).not.toHaveBeenCalled();
	});
});
