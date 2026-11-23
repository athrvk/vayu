/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { createStableResolve } from "@/lib/dynamic-variable-cache";
import type { OAuth2Config, OAuth2ParamRow } from "@/types";

/*
 * One entry per config *field* - `<resolveKey>:clientId` and its siblings -
 * cached across the form's own unmount.
 *
 * The resolved config is not only a display: `TokenStatusRow` derives the
 * token cache key from it (`computeOAuth2CacheKey`) and queries on that string,
 * and the same object is what a Get Token actually posts. A `{{$guid}}` in the
 * access-token URL or the client id therefore did more than flicker - the
 * builder's Auth tab is not force-mounted (`RequestTabs/index.tsx`), so a look
 * at Headers and back rebuilt the form, resolved fresh, and pointed the status
 * row at a cache key nothing had ever fetched: a token that was on screen a
 * moment ago reading as "No token cached", with nothing edited. A memo alone
 * could not answer that, because it dies with the component.
 *
 * `resolveString` comes from the request builder's provider at the one host
 * that passes it, so it outlives the form and the entry is still valid on the
 * way back in. With no `resolveKey` the cache is bypassed entirely, which is
 * the collection auth editor's case: it passes no resolver either, so every
 * field is already its own literal text.
 */
const stableConfigField = createStableResolve();

/**
 * `rows` with every key and value resolved, each under a cache entry of its
 * own (`<list>.<index>.key`). A stored list is whatever JSON the engine
 * round-tripped, so a list that is not an array, a row that is not an object
 * and a member that is not a string are all left as they are.
 */
function resolveParamRows(
	list: string,
	rows: OAuth2ParamRow[] | undefined,
	resolveField: (field: string, text: string) => string
): OAuth2ParamRow[] | undefined {
	if (!Array.isArray(rows)) return rows;
	const resolveMember = (index: number, member: "key" | "value", row: OAuth2ParamRow) =>
		typeof row[member] === "string"
			? resolveField(`${list}.${index}.${member}`, row[member])
			: row[member];
	return rows.map((row, index) =>
		typeof row === "object" && row !== null
			? {
					...row,
					key: resolveMember(index, "key", row),
					value: resolveMember(index, "value", row),
				}
			: row
	);
}

/**
 * @p value with its `{{variables}}` resolved, as a token request posts it.
 * Every surface that acts on the token of a config the form edits resolves it
 * here with the same @p resolveKey, so it posts, and keys, what the form shows.
 */
export function resolveOAuth2Config(
	value: OAuth2Config,
	resolveString: ((value: string) => string) | undefined,
	resolveKey: string | undefined
): OAuth2Config {
	const resolve = resolveString ?? ((s: string) => s);
	const r = (field: string, s: string) =>
		resolveKey ? stableConfigField(`${resolveKey}:${field}`, s, resolve) : resolve(s);
	// An absent optional field stays absent: resolving it would turn every
	// `undefined` into `""`, and the cache key tells those two apart.
	const rz = (field: string, s?: string) => (s ? r(field, s) : s);
	// `privateKey` is not resolved: it is one reference the engine resolves
	// where the token is acquired, and the spread carries it through as written.
	return {
		...value,
		accessTokenUrl: r("accessTokenUrl", value.accessTokenUrl ?? ""),
		clientId: r("clientId", value.clientId ?? ""),
		clientSecret: rz("clientSecret", value.clientSecret),
		username: rz("username", value.username),
		password: rz("password", value.password),
		scope: rz("scope", value.scope),
		subject: rz("subject", value.subject),
		assertionAudience: rz("assertionAudience", value.assertionAudience),
		keyId: rz("keyId", value.keyId),
		assertionClaims: resolveParamRows("assertionClaims", value.assertionClaims, r),
		audience: rz("audience", value.audience),
		resource: rz("resource", value.resource),
		authorizationUrl: rz("authorizationUrl", value.authorizationUrl),
		refreshTokenUrl: rz("refreshTokenUrl", value.refreshTokenUrl),
		authorizationParams: resolveParamRows("authorizationParams", value.authorizationParams, r),
		tokenParams: resolveParamRows("tokenParams", value.tokenParams, r),
		refreshParams: resolveParamRows("refreshParams", value.refreshParams, r),
	};
}
