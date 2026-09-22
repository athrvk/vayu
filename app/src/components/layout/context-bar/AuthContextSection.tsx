/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which auth this request sends, and where it came from.
 *
 * The "where from" half is the point: a request set to Inherit sends whatever
 * the nearest configured ancestor holds, and the most common way to spend an
 * afternoon on a 401 is not knowing which ancestor that was. The walk is
 * `resolveAuthSource` - the same function the Auth tab's banner and both send
 * paths use, so this cannot claim one source while execution uses another.
 *
 * For OAuth 2.0 the section embeds `TokenStatusRow`, the same control the Auth
 * tab shows: whether a token is cached, whether it has expired, and the buttons
 * to fetch or clear it. A second copy of that row would be a second copy of the
 * cache-key derivation and the interactive-authorize flow, which is exactly the
 * trap the repo keeps hitting.
 */

import { useMemo } from "react";
import { useRequestQuery, useCollectionAncestors } from "@/queries";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import { resolveAuthSource } from "@/modules/request-builder/utils/auth-resolution";
import { AUTH_MODE_LABELS } from "@/constants/auth-modes";
import { TokenStatusRow } from "@/components/shared/OAuth2Form";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";
import type { OAuth2Config, RequestAuth } from "@/types";

export function AuthContextSection({ tab }: ContextBarSectionProps) {
	const { data: request, isLoading } = useRequestQuery(tab.entityId);
	const ancestors = useCollectionAncestors(request?.collectionId ?? null);
	const { resolveObject } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});

	const inherited = resolveAuthSource(ancestors);
	const own = request?.auth;

	/**
	 * The auth that will actually be sent, and the sentence explaining why.
	 *
	 * `inherit` is the only mode whose answer is not the request's own: it walks
	 * the chain, and an ancestor set to No Auth *terminates* that walk rather
	 * than being stepped over - a different answer from "nobody configured any",
	 * and one worth wording differently.
	 */
	const effective: { auth: RequestAuth | undefined; origin: string } = useMemo(() => {
		if (!own) return { auth: undefined, origin: "" };
		if (own.mode !== "inherit") return { auth: own, origin: "Set on this request" };
		if (inherited.source) {
			return {
				auth: inherited.source.auth,
				origin: `Inherited from ${inherited.source.name}`,
			};
		}
		if (inherited.blockedBy) {
			return {
				auth: { mode: "none" },
				origin: `${inherited.blockedBy.name} is set to No Auth, so nothing is inherited past it`,
			};
		}
		return { auth: { mode: "none" }, origin: "No ancestor collection defines auth" };
	}, [own, inherited.source, inherited.blockedBy]);

	/*
	 * Memoised on the config's *text*, not on its object identity.
	 *
	 * This used to resolve on every render, on the grounds that a new object
	 * identity only costs `TokenStatusRow` one cheap re-derivation of the string
	 * cache key it queries on. That holds for a `{{scope variable}}` and fails
	 * for a dynamic one: `{{$guid}}` in the access-token URL or the client id
	 * resolves to something new on every call (`lib/dynamic-variables.ts`'s own
	 * contract), so the *string* key changed too - a new query key every render,
	 * which is a refetch loop rather than a re-derivation, and it re-hid a
	 * revealed token each time round.
	 *
	 * Serialised rather than compared by identity because a resolved config is
	 * rebuilt whenever the ancestor walk re-runs, and `resolveObject` is in the
	 * deps because its identity is what changes on an environment switch or a
	 * variable edit - the events that *should* produce a new value.
	 *
	 * A `useMemo` and not `lib/dynamic-variable-cache.ts`'s module-scope cache,
	 * for the reason `useHostCookies` (see `relevance.ts`) keeps one: this
	 * component creates its own resolver, so a remount brings a fresh
	 * `resolveObject` that would miss that cache anyway.
	 */
	const configText =
		effective.auth?.mode === "oauth2" ? JSON.stringify(effective.auth.config) : null;
	const oauthConfig: OAuth2Config | null = useMemo(
		() =>
			configText === null
				? null
				: resolveObject<OAuth2Config>(JSON.parse(configText) as OAuth2Config),
		[configText, resolveObject]
	);

	if (isLoading) return <SectionLoading />;
	if (!request || !own) return <SectionEmpty>No request loaded</SectionEmpty>;

	const label = effective.auth ? AUTH_MODE_LABELS[effective.auth.mode] : AUTH_MODE_LABELS.none;

	return (
		<div className="space-y-2">
			<p className="text-xs text-foreground m-0">
				Sending <span className="font-semibold text-primary">{label}</span>
			</p>
			<p className="text-label text-muted-foreground m-0">{effective.origin}</p>
			{oauthConfig && <TokenStatusRow resolvedConfig={oauthConfig} />}
		</div>
	);
}
