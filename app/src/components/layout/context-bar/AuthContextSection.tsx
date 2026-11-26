/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which auth this request sends, and where it came from. The "where from" half is the point: a
 * request set to Inherit sends whatever the nearest configured ancestor holds, and not knowing
 * which ancestor is the usual way to spend an afternoon on a 401. The walk is `resolveAuthSource`,
 * the function the Auth tab's banner and both send paths use, so this cannot claim one source while
 * execution uses another.
 *
 * For OAuth 2.0 it embeds `TokenStatusRow`, the Auth tab's own control: whether a token is cached,
 * whether it has expired, and the buttons to fetch or clear it. A second copy of that row would be
 * a second copy of the cache-key derivation and the interactive-authorize flow.
 */

import { useMemo } from "react";
import { useRequestQuery, useCollectionAncestors } from "@/queries";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import { resolveAuthSource } from "@/modules/request-builder/utils/auth-resolution";
import { useOAuth2DeferredNames } from "@/modules/request-builder/hooks/useOAuth2DeferredNames";
import { AUTH_MODE_LABELS, isEngineExecutableAuthMode } from "@/constants/auth-modes";
import { TokenStatusRow } from "@/components/shared/OAuth2Form";
import { keepSigningKeyReference } from "@/services/oauth/signing-key";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";
import type { OAuth2Config, RequestAuth } from "@/types";

/**
 * The engine's `trimmed_credential`: only spaces and tabs, so a value of just a
 * newline is still something the engine sends.
 */
const trimCredential = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, "");

/**
 * Why a bearer token or API key is a no-op, judged on the value the send will carry. The engine
 * writes no header for an empty token or a nameless key and says so in `authNotice`, after the
 * send; this is the same verdict from the stored configuration before there is one, so a variable a
 * script sets at send time is outside it ("as configured"). Null when a credential would go out
 * (#3203).
 */
function emptyCredentialReason(
	auth: RequestAuth | undefined,
	resolve: <T>(value: T) => T
): string | null {
	if (auth?.mode === "bearer") {
		return trimCredential(resolve(auth.token)) === "" ? "empty, nothing sent" : null;
	}
	if (auth?.mode === "apikey") {
		return trimCredential(resolve(auth.key)) === "" ? "no name, nothing sent" : null;
	}
	return null;
}

export function AuthContextSection({ tab }: ContextBarSectionProps) {
	const { data: request, isLoading } = useRequestQuery(tab.entityId);
	const ancestors = useCollectionAncestors(request?.collectionId ?? null);
	const { resolveObject } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});

	const inherited = resolveAuthSource(ancestors);
	const own = request?.auth;

	/**
	 * The auth that will be sent, and the sentence explaining why. `inherit` is the only mode whose
	 * answer is not the request's own: it walks the chain, and an ancestor set to No Auth
	 * *terminates* the walk rather than being stepped over, an answer worded apart from "nobody
	 * configured any".
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
				origin: `${inherited.blockedBy.name} is set to No auth, so nothing is inherited past it`,
			};
		}
		return { auth: { mode: "none" }, origin: "No ancestor collection defines auth" };
	}, [own, inherited.source, inherited.blockedBy]);

	/*
	 * Memoised on the config's *text*, not its object identity. A `{{$guid}}` in the access-token
	 * URL or the client id resolves to something new on every call (`lib/dynamic-variables.ts`'s
	 * contract), so resolving per render gives `TokenStatusRow` a new string cache key each time: a
	 * refetch loop that also re-hides a revealed token.
	 *
	 * Serialised rather than compared by identity because a resolved config is rebuilt whenever the
	 * ancestor walk re-runs; `resolveObject` is in the deps because its identity changes on an
	 * environment switch or a variable edit, the events that *should* produce a new value. A
	 * `useMemo`, not `lib/dynamic-variable-cache.ts`'s module-scope cache, for the reason
	 * `useHostCookies` (see `relevance.ts`) keeps one: this component creates its own resolver, so
	 * a remount brings a fresh `resolveObject` that would miss that cache anyway.
	 */
	const configText =
		effective.auth?.mode === "oauth2" ? JSON.stringify(effective.auth.config) : null;
	const oauthConfig: OAuth2Config | null = useMemo(() => {
		if (configText === null) return null;
		const raw = JSON.parse(configText) as OAuth2Config;
		// The signing key stays the reference as written: the engine resolves it.
		return keepSigningKeyReference(resolveObject<OAuth2Config>(raw), raw);
	}, [configText, resolveObject]);

	const deferredNames = useOAuth2DeferredNames(
		tab.entityId ?? "",
		effective.auth?.mode === "oauth2" ? effective.auth.config : null
	);

	if (isLoading) return <SectionLoading />;
	if (!request || !own) return <SectionEmpty>No request loaded</SectionEmpty>;

	const mode = effective.auth?.mode ?? "none";
	const label = AUTH_MODE_LABELS[mode];
	const emptyReason = emptyCredentialReason(effective.auth, resolveObject);

	return (
		<div className="space-y-2">
			<p className="text-xs text-foreground m-0">
				{emptyReason ? (
					<>
						<span className="font-semibold text-primary">{label}</span> - {emptyReason}{" "}
						(as configured)
					</>
				) : isEngineExecutableAuthMode(mode) ? (
					<>
						Sending <span className="font-semibold text-primary">{label}</span>
					</>
				) : (
					<>
						<span className="font-semibold text-primary">{label}</span> - not sent by
						Vayu
					</>
				)}
			</p>
			<p className="text-label text-muted-foreground m-0">{effective.origin}</p>
			{oauthConfig && (
				<TokenStatusRow
					resolvedConfig={oauthConfig}
					deferredNames={deferredNames}
					collectionId={request.collectionId}
				/>
			)}
		</div>
	);
}
