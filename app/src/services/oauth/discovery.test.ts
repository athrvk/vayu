/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Discovery is a fill step (#3766): the engine fills what the config left
 * blank, and the app writes exactly that back, so a typed member is never
 * overwritten and the stored config ends up keying the token the engine cached.
 */

import { describe, it, expect } from "vitest";
import type { OAuth2AuthorizeResolved, OAuth2Config } from "@/types";
import { computeOAuth2CacheKey } from "./cache-key";
import {
	awaitsDiscovery,
	clearDiscovered,
	discoveredValues,
	discoveryOn,
	oauth2SignInKey,
	withDiscoveredValues,
} from "./discovery";

const BLANK: OAuth2Config = {
	grantType: "authorization_code",
	discoverUrl: "https://mcp.example.com/mcp",
	accessTokenUrl: "",
	clientId: "",
};

const RESOLVED: OAuth2AuthorizeResolved = {
	authorizationUrl: "https://auth.example.com/authorize",
	accessTokenUrl: "https://auth.example.com/token",
	clientId: "registered",
	resource: "https://mcp.example.com/mcp",
	scope: "mcp:read",
	issuer: "https://auth.example.com",
};

describe("discoveredValues", () => {
	it("is every member the engine filled into a blank config, and never the issuer", () => {
		expect(discoveredValues(BLANK, RESOLVED)).toEqual({
			authorizationUrl: RESOLVED.authorizationUrl,
			accessTokenUrl: RESOLVED.accessTokenUrl,
			clientId: "registered",
			resource: RESOLVED.resource,
			scope: "mcp:read",
		});
	});

	it("leaves out a member the config typed, which the engine used as it was", () => {
		const typed = { ...BLANK, clientId: "pre-registered", scope: "mcp:write" };
		const values = discoveredValues(typed, {
			...RESOLVED,
			clientId: "pre-registered",
			scope: "mcp:write",
		});

		expect(values).not.toHaveProperty("clientId");
		expect(values).not.toHaveProperty("scope");
		expect(values.accessTokenUrl).toBe(RESOLVED.accessTokenUrl);
	});

	it("treats a URL member of whitespace alone as blank, as the engine's url_field does", () => {
		const values = discoveredValues({ ...BLANK, accessTokenUrl: " \t" }, RESOLVED);

		expect(values.accessTokenUrl).toBe(RESOLVED.accessTokenUrl);
	});

	it("leaves out a scope discovery did not choose", () => {
		expect(discoveredValues(BLANK, { ...RESOLVED, scope: "" })).not.toHaveProperty("scope");
	});
});

describe("withDiscoveredValues", () => {
	it("writes the values and names them, so the stored config keys the engine's token", () => {
		const written = withDiscoveredValues(BLANK, discoveredValues(BLANK, RESOLVED));

		expect(written.discoveredFields).toEqual([
			"authorizationUrl",
			"accessTokenUrl",
			"clientId",
			"resource",
			"scope",
		]);
		expect(computeOAuth2CacheKey(written)).toBe(
			computeOAuth2CacheKey({
				...BLANK,
				accessTokenUrl: RESOLVED.accessTokenUrl,
				clientId: RESOLVED.clientId,
			})
		);
		expect(written.discoverUrl).toBe(BLANK.discoverUrl);
	});

	it("keeps the names an earlier sign-in wrote", () => {
		const earlier = { ...BLANK, scope: "a", discoveredFields: ["scope" as const] };

		const written = withDiscoveredValues(earlier, { clientId: "c" });

		expect(written.discoveredFields).toEqual(["clientId", "scope"]);
	});

	it("is the same config when there is nothing to write", () => {
		expect(withDiscoveredValues(BLANK, {})).toBe(BLANK);
	});
});

describe("clearDiscovered", () => {
	it("clears what discovery wrote and keeps what was typed", () => {
		const config: OAuth2Config = {
			...BLANK,
			authorizationUrl: RESOLVED.authorizationUrl,
			accessTokenUrl: RESOLVED.accessTokenUrl,
			clientId: "registered",
			scope: "typed",
			discoveredFields: ["authorizationUrl", "accessTokenUrl", "clientId"],
		};

		const cleared = clearDiscovered(config);

		expect(cleared).toEqual({
			grantType: "authorization_code",
			discoverUrl: BLANK.discoverUrl,
			accessTokenUrl: "",
			clientId: "",
			scope: "typed",
		});
	});
});

describe("awaitsDiscovery and oauth2SignInKey", () => {
	it("awaits discovery while discovery is on and the config has no cache key", () => {
		expect(awaitsDiscovery(BLANK)).toBe(true);
		expect(oauth2SignInKey(BLANK)).toBe("discover:https://mcp.example.com/mcp");
	});

	it("does not once a sign-in has filled the config, which then signs in by its cache key", () => {
		const filled = withDiscoveredValues(BLANK, discoveredValues(BLANK, RESOLVED));

		expect(awaitsDiscovery(filled)).toBe(false);
		expect(oauth2SignInKey(filled)).toBe(computeOAuth2CacheKey(filled));
	});

	it("ignores a discoverUrl on a grant that never signs in", () => {
		const config = { ...BLANK, grantType: "client_credentials" as const };

		expect(discoveryOn(config)).toBe(false);
		expect(awaitsDiscovery(config)).toBe(false);
		expect(oauth2SignInKey(config)).toBeNull();
	});

	it("has no sign-in key for a config with discovery off and nothing to key", () => {
		const { discoverUrl: _off, ...config } = BLANK;

		expect(oauth2SignInKey(config)).toBeNull();
	});
});
