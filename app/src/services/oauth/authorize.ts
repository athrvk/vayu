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

const TIMED_OUT_MESSAGE = "Couldn't finish authorization in time.";

/**
 * How long past the engine's `expiresAt` this side keeps waiting. The engine
 * owns the deadline and answers a poll after it with `failed` "Authorization
 * timed out", and the embedded window closes itself at it with the same words;
 * both are specific errors that only arrive if this ceiling is the later of the
 * two. It covers an engine or IPC call that never answers at all.
 */
export const EXPIRY_GRACE_MS = 10 * 1000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject with `message` if `promise` has not settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new InteractiveAuthError(message)), ms);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new InteractiveAuthError(String(error)));
			}
		);
	});
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
	// NaN compares false against everything, so a missing expiry would poll forever.
	if (!Number.isFinite(started.expiresAt)) {
		throw new InteractiveAuthError(
			"Couldn't start authorization - Vayu's engine sent no expiry."
		);
	}
	const remainingMs = started.expiresAt - Date.now();

	if (useEmbedded) {
		if (remainingMs <= 0) throw new InteractiveAuthError(TIMED_OUT_MESSAGE);
		const result = await withDeadline(
			api.oauthOpenWindow({
				authorizeUrl: started.authorizeUrl,
				redirectUri: started.redirectUri,
				timeoutMs: remainingMs,
				partition: `oauth:${computeOAuth2CacheKey(config)}`,
			}),
			remainingMs + EXPIRY_GRACE_MS,
			TIMED_OUT_MESSAGE
		);
		if ("error" in result) {
			throw new InteractiveAuthError(result.error);
		}
		const status = await apiService.completeOAuth2Authorize(
			started.attemptId,
			result.callbackUrl
		);
		if (status.state !== "completed") {
			throw new InteractiveAuthError(status.error || "Couldn't complete authorization.");
		}
		return status.cacheKey ?? computeOAuth2CacheKey(config);
	}

	// Loopback: open the system browser and poll the engine's listener result.
	await api.openExternalUrl(started.authorizeUrl);

	const deadline = started.expiresAt + EXPIRY_GRACE_MS;
	for (;;) {
		if (Date.now() > deadline) {
			throw new InteractiveAuthError(TIMED_OUT_MESSAGE);
		}
		await delay(POLL_INTERVAL_MS);
		const status = await apiService.getOAuth2AuthorizeStatus(started.attemptId);
		if (status.state === "completed") {
			return status.cacheKey ?? computeOAuth2CacheKey(config);
		}
		if (status.state === "failed") {
			throw new InteractiveAuthError(status.error || "Couldn't complete authorization.");
		}
		if (status.state === "not_found") {
			throw new InteractiveAuthError(
				"Couldn't complete authorization - the attempt expired."
			);
		}
	}
}
