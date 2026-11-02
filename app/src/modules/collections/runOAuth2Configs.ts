/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which OAuth 2.0 tokens does a collection run send? (issue #3199)
 *
 * A collection load run plans each step's token separately, but the engine keeps
 * one credential per token cache key, however many steps send it - so the run's
 * token question has one answer per *distinct* key, not per request. This is the
 * collecting half of `OAuth2LoadTestGuard` for a run: it walks the requests the
 * run sends, resolves each one's effective auth (an `inherit` through its
 * collection chain, a `noauth` ancestor stopping the walk), variable-resolves
 * the OAuth 2.0 config it lands on, and keeps the first config seen per key.
 *
 * Variables resolve through the scopes of the request's *own* collection chain,
 * globals and the active environment, from stored values only - the stored
 * values are what a load run acquires its token from (#2742). That is the
 * hook's resolution (`useVariableResolver`) without the hook, because a hook
 * cannot be called once per collection in a loop.
 */

import { effectiveOAuth2Config } from "@/modules/request-builder/utils/auth-resolution";
import { computeOAuth2CacheKey } from "@/services/oauth/cache-key";
import {
	buildVariableValues,
	resolveStringsDeep,
	resolveTemplate,
	type StoredVariableBag,
} from "@/lib/variable-resolution";
import type { Collection, OAuth2Config, Request } from "@/types";
import { walkAncestors } from "./tree-utils";

/** One distinct token the run sends: its cache key and a config that yields it. */
export interface RunOAuth2Config {
	key: string;
	config: OAuth2Config;
}

/** The stored requests of one collection the run sends. */
export interface RunRequestGroup {
	collectionId: string;
	requests: readonly Pick<Request, "auth">[];
}

/** The two scopes that do not depend on which collection a request is in. */
export interface RunVariableScopes {
	globals?: StoredVariableBag;
	environment?: StoredVariableBag;
}

/**
 * The distinct OAuth 2.0 configs @p groups' requests send, in first-seen order.
 *
 * A config the engine cannot key (no token URL or client id once resolved) is
 * left out: the guard has nothing to look up for it, and it renders nothing.
 */
export function distinctRunOAuth2Configs(
	groups: readonly RunRequestGroup[],
	collections: readonly Collection[],
	scopes: RunVariableScopes
): RunOAuth2Config[] {
	const byKey = new Map<string, OAuth2Config>();
	for (const { collectionId, requests } of groups) {
		// One walk and one lookup per collection: every request in it inherits
		// down the same chain and resolves against the same scopes.
		const ancestors = walkAncestors(collectionId, collections as Collection[]);
		const values = buildVariableValues({
			globals: scopes.globals,
			chain: ancestors.map((collection) => collection.variables as StoredVariableBag),
			environment: scopes.environment,
		});
		const resolveString = (input: string) => resolveTemplate(input, (name) => values.get(name));
		// An inherited config is the same object for every request that inherits
		// it, so it is resolved once rather than once per request.
		const seen = new Set<OAuth2Config>();
		for (const { auth } of requests) {
			const raw = effectiveOAuth2Config(auth, ancestors);
			if (raw === null || seen.has(raw)) continue;
			seen.add(raw);
			const config = resolveStringsDeep(raw, resolveString);
			if (!config.accessTokenUrl || !config.clientId) continue;
			const key = computeOAuth2CacheKey(config);
			if (!byKey.has(key)) byKey.set(key, config);
		}
	}
	return [...byKey].map(([key, config]) => ({ key, config }));
}
