/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which endpoints the GraphQL body may introspect without being asked. Introspection composes the
 * request with the user's variables and auth and sends it, so doing it on its own for any URL that
 * reaches the screen (one from an imported file included) is contact the user never chose. So the
 * automatic path only reaches an origin the user has already contacted: pressed Send or Load test
 * on a request to it (`hooks/useEngine.ts`), or loaded its schema by hand (`schema-cache.ts`). The
 * list lives in the persisted client settings, so it outlasts the session.
 *
 * Judged on the **composed** URL, the one the request would actually go to: the text in the URL bar
 * can be `{{baseUrl}}/graphql`, whose host is whatever the environment says it is.
 */

import { useClientSettingsStore } from "@/stores/client-settings-store";

/**
 * The origin (scheme, host, port) a URL contacts, or null when it names none: unparseable, a scheme
 * the engine does not send over, or a host still holding a `{{variable}}`, which the URL parser
 * accepts as a hostname but names no machine.
 */
export function endpointOrigin(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return /[{}]/.test(parsed.host) ? null : parsed.origin;
	} catch {
		return null;
	}
}

export function isEndpointApproved(url: string): boolean {
	const origin = endpointOrigin(url);
	return origin !== null && useClientSettingsStore.getState().approvedEndpoints.includes(origin);
}

/** Record that the user has chosen to contact this URL's origin. */
export function approveEndpoint(url: string): void {
	const origin = endpointOrigin(url);
	if (origin) useClientSettingsStore.getState().approveEndpoint(origin);
}
