/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import type { OAuth2TokenStatusResponse } from "@/types";
import { lapseInstant, tokenPhase } from "./token-phase";

const NOW = Date.UTC(2026, 0, 1);

function cached(expiresAt: number | null, expired = false): OAuth2TokenStatusResponse {
	return {
		found: true,
		expired,
		token: {
			cacheKey: "k",
			accessToken: "ya29.abcdefghijkl",
			tokenType: "Bearer",
			expiresIn: 60,
			createdAt: NOW - 1000,
			expiresAt,
			hasRefreshToken: false,
		},
	};
}

describe("tokenPhase", () => {
	it.each([
		["nothing asked yet", undefined],
		["no token cached", { found: false } satisfies OAuth2TokenStatusResponse],
	])("is the fetch state for %s", (_name, status) => {
		expect(tokenPhase(status, NOW)).toEqual({
			dotClass: "bg-muted-foreground/40",
			actionLabel: "Get token",
			renews: false,
			expiry: null,
		});
	});

	it("is current before the expiry", () => {
		expect(tokenPhase(cached(NOW + 1), NOW)).toEqual({
			dotClass: "bg-status-success",
			actionLabel: "Renew",
			renews: true,
			expiry: { word: "expires", at: NOW + 1 },
		});
	});

	it("has lapsed at the expiry instant itself, though the engine's flag has not caught up", () => {
		expect(tokenPhase(cached(NOW), NOW)).toEqual({
			dotClass: "bg-warning",
			actionLabel: "Refresh",
			renews: false,
			expiry: { word: "expired", at: NOW },
		});
	});

	it("has lapsed on the engine's flag alone, though the clock says there is time", () => {
		const phase = tokenPhase(cached(NOW + 60_000, true), NOW);

		expect(phase.actionLabel).toBe("Refresh");
		expect(phase.dotClass).toBe("bg-warning");
		expect(phase.expiry).toEqual({ word: "expired", at: NOW + 60_000 });
	});

	it("leaves a token with no expiry to the flag", () => {
		expect(tokenPhase(cached(null), NOW).expiry).toEqual({ word: "does not expire", at: null });
		expect(tokenPhase(cached(null, true), NOW).expiry).toEqual({ word: "expired", at: null });
		expect(tokenPhase(cached(null), NOW).actionLabel).toBe("Renew");
		expect(tokenPhase(cached(null, true), NOW).actionLabel).toBe("Refresh");
	});
});

describe("lapseInstant", () => {
	it("is the expiry of a token that is still good", () => {
		expect(lapseInstant(cached(NOW + 5))).toBe(NOW + 5);
	});

	it.each([
		["no answer", undefined],
		["no token", { found: false } satisfies OAuth2TokenStatusResponse],
		["a token the engine already calls expired", cached(NOW + 5, true)],
		["a token that never expires", cached(null)],
	])("is null for %s", (_name, status) => {
		expect(lapseInstant(status)).toBeNull();
	});
});
