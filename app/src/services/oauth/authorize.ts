/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Drives the interactive Authorization Code flow from the renderer. The engine
 * owns PKCE/state/exchange; this module coordinates the browser step:
 *
 *   loopback (default): start → open system browser → poll engine for completion
 *   embedded:           start → open hardened window → hand callback URL to engine
 */

import { apiService } from "@/services/api";
import { computeOAuth2CacheKey } from "./cache-key";
import type { OAuth2Config } from "@/types";

export class InteractiveAuthError extends Error {}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the interactive flow for a *resolved* OAuth2Config (variables already
 * substituted). Resolves with the cache key on success; throws on failure or
 * when the desktop bridge is unavailable.
 */
export async function runInteractiveAuthorization(config: OAuth2Config): Promise<string> {
	const api = window.electronAPI;
	if (!api) {
		throw new InteractiveAuthError(
			"Interactive OAuth 2.0 sign-in requires the Vayu desktop app."
		);
	}

	const useEmbedded = config.useEmbeddedBrowser === true;
	const started = await apiService.startOAuth2Authorize({
		config,
		mode: useEmbedded ? "embedded" : "loopback",
	});

	if (useEmbedded) {
		const result = await api.oauthOpenWindow({
			authorizeUrl: started.authorizeUrl,
			redirectUri: started.redirectUri,
			partition: `oauth:${computeOAuth2CacheKey(config)}`,
		});
		if ("error" in result) {
			throw new InteractiveAuthError(result.error);
		}
		const status = await apiService.completeOAuth2Authorize(
			started.attemptId,
			result.callbackUrl
		);
		if (status.state !== "completed") {
			throw new InteractiveAuthError(status.error || "Authorization failed");
		}
		return status.cacheKey ?? computeOAuth2CacheKey(config);
	}

	// Loopback: open the system browser and poll the engine's listener result.
	await api.oauthOpenExternal(started.authorizeUrl);

	const deadline = Date.now() + POLL_TIMEOUT_MS;
	for (;;) {
		if (Date.now() > deadline) {
			throw new InteractiveAuthError("Authorization timed out");
		}
		await delay(POLL_INTERVAL_MS);
		const status = await apiService.getOAuth2AuthorizeStatus(started.attemptId);
		if (status.state === "completed") {
			return status.cacheKey ?? computeOAuth2CacheKey(config);
		}
		if (status.state === "failed") {
			throw new InteractiveAuthError(status.error || "Authorization failed");
		}
		if (status.state === "not_found") {
			throw new InteractiveAuthError("Authorization attempt expired");
		}
	}
}
