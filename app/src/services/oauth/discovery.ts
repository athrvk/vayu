/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The app's half of a config discovered from an MCP server URL (#3766).
 *
 * Discovery is a **fill** step. The engine runs it at an authorize start and
 * fills only the members the config leaves blank (`fill_blank`,
 * `engine/src/http/routes/oauth_authorize.cpp`); the app writes what it filled
 * into the stored config once the sign-in succeeds. From then on the config
 * holds ordinary endpoints and a client id, so the cache key, a refresh and a
 * run read it like any other config and need no discovery. `discoveredFields`
 * records which members were written, so the form can show them as found
 * rather than typed and Discover again can clear exactly those.
 */

import type { OAuth2AuthorizeResolved, OAuth2Config, OAuth2DiscoveredField } from "@/types";
import { oauth2TokenKey, urlText } from "./cache-key";

export const DISCOVERED_FIELDS: readonly OAuth2DiscoveredField[] = [
	"authorizationUrl",
	"accessTokenUrl",
	"clientId",
	"resource",
	"scope",
];

/** Discovery is switched on: an authorization_code grant with a `discoverUrl`, typed or not. */
export function discoveryOn(config: OAuth2Config): boolean {
	return config.grantType === "authorization_code" && config.discoverUrl !== undefined;
}

/**
 * Discovery is on and the config cannot be keyed yet: what only a sign-in can
 * fill is still blank. Such a config has no cached token and cannot be run
 * headless; every token surface reads it as "sign in first".
 */
export function awaitsDiscovery(config: OAuth2Config): boolean {
	return discoveryOn(config) && oauth2TokenKey(config) === null;
}

/**
 * What a sign-in for @p config runs under (`oauth-signin-store`): its cache
 * key, or for a config awaiting discovery a key naming the server, so two rows
 * for one such config share its sign-in too. Null when the config can neither
 * be keyed nor discovered.
 */
export function oauth2SignInKey(config: OAuth2Config): string | null {
	const key = oauth2TokenKey(config);
	if (key !== null) return key;
	return awaitsDiscovery(config) ? `discover:${urlText(config.discoverUrl)}` : null;
}

/**
 * Blank as the engine reads it: a member it fills through `url_field` is
 * trimmed of ASCII whitespace; `clientId` is registered for only when empty.
 */
function blankForDiscovery(config: OAuth2Config, field: OAuth2DiscoveredField): boolean {
	const value = config[field];
	if (field === "clientId") return !value;
	return urlText(value) === "";
}

/**
 * The members the engine's discovery filled into @p sent, the config the start
 * posted: each `resolved` member that is not empty where @p sent was blank.
 * A typed member is the config's own and is never in it.
 */
export function discoveredValues(
	sent: OAuth2Config,
	resolved: OAuth2AuthorizeResolved
): Partial<Record<OAuth2DiscoveredField, string>> {
	const filled: Partial<Record<OAuth2DiscoveredField, string>> = {};
	for (const field of DISCOVERED_FIELDS) {
		const found = resolved[field];
		if (typeof found === "string" && found !== "" && blankForDiscovery(sent, field)) {
			filled[field] = found;
		}
	}
	return filled;
}

/**
 * @p config with @p values written in and named in `discoveredFields`. The same
 * object when there is nothing to write, so a caller can skip the save.
 */
export function withDiscoveredValues(
	config: OAuth2Config,
	values: Partial<Record<OAuth2DiscoveredField, string>>
): OAuth2Config {
	const written = DISCOVERED_FIELDS.filter((field) => values[field] !== undefined);
	if (written.length === 0) return config;
	const named = new Set([...(config.discoveredFields ?? []), ...written]);
	return {
		...config,
		...values,
		discoveredFields: DISCOVERED_FIELDS.filter((field) => named.has(field)),
	};
}

/**
 * @p config without what discovery wrote, so the next sign-in discovers (and,
 * with no client id, registers) again. A typed member stays.
 */
export function clearDiscovered(config: OAuth2Config): OAuth2Config {
	const { discoveredFields, ...rest } = config;
	const cleared: OAuth2Config = { ...rest };
	for (const field of discoveredFields ?? []) {
		if (field === "accessTokenUrl" || field === "clientId") cleared[field] = "";
		else delete cleared[field];
	}
	return cleared;
}
