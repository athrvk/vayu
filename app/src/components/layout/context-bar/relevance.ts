/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What each request-tab section has to say about the request in front of it.
 *
 * The bar used to decide what to draw from the tab alone, so a plain REST
 * request opened seven sections of which three existed only to say they did not
 * apply ("This request does not send a GraphQL body", "No cookies held for this
 * host", "This request has not been sent yet"). `useRelevance` is the answer to
 * the data-level question `appliesTo` structurally cannot ask - see `types.ts`
 * for the contract and `registry.ts` for why it is a second function rather than
 * a wider `appliesTo`.
 *
 * One module rather than a hook beside each section, for two reasons. The lint
 * rule that keeps a `.tsx` exporting components and nothing else would scatter
 * them into a file each anyway; and the GraphQL one *must* live away from its
 * section, because `registry.ts` names it eagerly and importing it from
 * `GraphQLSection.tsx` would drag the ~320KB `graphql` package into the startup
 * chunk that #1146 took it out of. Collected here, the bar's whole
 * quiet-versus-loud policy reads in one screen.
 *
 * The derivations a section shares with its own relevance (`useRequestVariables`,
 * `useHostCookies`) live here too, and the section imports them back: one answer
 * to "what does this request reference" and "which host is this", not two that
 * can disagree.
 */

import { useMemo } from "react";
import { useRequestQuery, useCollectionAncestors, useRecentDesignRunsQuery } from "@/queries";
import { useCookiesQuery } from "@/queries/cookies";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import { useSessionStore } from "@/stores";
import { resolveEffectiveAuth } from "@/modules/request-builder/utils/auth-resolution";
import { referencedVariableNames } from "@/lib/request-references";
import { cookieMatchesHost, hostOf } from "./cookie-host";
import type { Tab } from "@/stores";
import type { ResolvedVariable } from "@/types";
import type { SectionRelevance } from "./types";

/* ── Variables ───────────────────────────────────────────────────────────── */

/**
 * What this request references, what resolves it, and what else is in scope.
 *
 * Memoized because the relevance hook runs whenever the bar is open, expanded or
 * not, and `getAllVariables` copies the whole resolved map: without this the
 * reference walk and the copy would run on every render of the bar rather than
 * when their inputs change. Its three inputs are all stable references
 * (`useCollectionAncestors` memoizes, the resolver's getters are `useCallback`),
 * so the memo actually holds.
 *
 * `null` while the request has not arrived - the caller decides whether that is
 * a loading line or a "wait and see".
 */
export function useRequestVariables(tab: Tab) {
	const { data: request } = useRequestQuery(tab.entityId);
	const ancestors = useCollectionAncestors(request?.collectionId ?? null);
	const { getVariable, getAllVariables } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});

	return useMemo(() => {
		if (!request) return null;

		// The auth the request *sends* - `inherit` walked - so a `{{token}}` in an
		// inherited credential counts as a reference.
		const references = referencedVariableNames({
			url: request.url ?? "",
			params: request.params ?? [],
			headers: request.headers ?? [],
			body: request.body ?? { mode: "none" },
			preRequestScript: request.preRequestScript ?? "",
			postRequestScript: request.postRequestScript ?? "",
			resolvedAuth: resolveEffectiveAuth(request.auth ?? { mode: "none" }, ancestors),
		});

		const classified = references.map((name) => ({ name, resolved: getVariable(name) }));
		const resolvedRefs = classified.filter(
			(r): r is { name: string; resolved: ResolvedVariable } => r.resolved !== null
		);
		const undefinedRefs = classified.filter((r) => r.resolved === null).map((r) => r.name);

		// The disclosure is "everything else in scope": the full resolved set minus
		// the referenced names already shown above it, so a name is never listed
		// twice.
		const shownAtTop = new Set(resolvedRefs.map((r) => r.name));
		const rest = Object.entries(getAllVariables()).filter(([name]) => !shownAtTop.has(name));

		return { references, resolvedRefs, undefinedRefs, rest };
	}, [request, ancestors, getVariable, getAllVariables]);
}

/**
 * Quiet only when the request references nothing *and* nothing is in scope - the
 * "No variables in scope" body, which was a section explaining that it had no
 * reason to be there. A request that references none while the workspace defines
 * some still has content: the disclosure over everything in scope is the
 * quick-edit path, and a dimmed header would take it away.
 */
export function useVariablesRelevance(tab: Tab): SectionRelevance {
	const derived = useRequestVariables(tab);
	if (!derived) return "content";
	return derived.references.length === 0 && derived.rest.length === 0
		? { empty: "none" }
		: "content";
}

/* ── Cookies ─────────────────────────────────────────────────────────────── */

/**
 * The host this request resolves to, and the jar entries that match it.
 *
 * The host is a resolved template, not `request.url`, which is the part worth
 * having in one place: a second copy of that resolution would be a second answer
 * to "which host is this" for the two halves of one section to disagree about.
 */
export function useHostCookies(tab: Tab) {
	const { data: request } = useRequestQuery(tab.entityId);
	const { resolveString } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const { data, isLoading } = useCookiesQuery();

	const host = request ? hostOf(resolveString(request.url)) : null;
	const scope = data?.scopes.find((s) => (s.environmentId ?? null) === activeEnvironmentId);
	const matches = host ? (scope?.cookies ?? []).filter((c) => cookieMatchesHost(c, host)) : [];

	return { isLoading, host, matches, activeEnvironmentId };
}

/**
 * No host yet is `"hidden"`: a URL still being typed has nothing to hold cookies
 * for, and "This request has no host yet" was a header explaining its own
 * irrelevance. A host with an empty jar is the state worth a word, because "no
 * cookies are riding along" is an answer to a question people ask.
 */
export function useCookiesRelevance(tab: Tab): SectionRelevance {
	const { isLoading, host, matches } = useHostCookies(tab);
	if (isLoading) return "content";
	if (!host) return "hidden";
	return matches.length === 0 ? { empty: "none" } : "content";
}

/* ── GraphQL ─────────────────────────────────────────────────────────────── */

/**
 * Unknown means `"hidden"` here, against the standing rule in `types.ts` that a
 * hook says `"content"` until it knows.
 *
 * The flicker that rule prevents would cost a 320KB chunk download here, and a
 * section that appears once the request lands reads better than one that appears
 * and then leaves. The section is `lazy` for the same reason, and the two now
 * agree: a REST tab never requests the chunk at all, where it used to arrive the
 * moment the expanded section mounted to say the request was not GraphQL.
 */
export function useGraphQLRelevance(tab: Tab): SectionRelevance {
	const { data: request } = useRequestQuery(tab.entityId);
	return request?.bodyType === "graphql" ? "content" : "hidden";
}

/* ── Recent sends ────────────────────────────────────────────────────────── */

/**
 * A request nobody has sent yet is the common case for a request being written,
 * and "This request has not been sent yet" was a whole expanded section saying
 * so. It stays visible as a header rather than hiding: the section reappearing
 * on the first send is worth less than the reader knowing the trend is there to
 * come back to.
 *
 * The list query is the section's own - one page of `GET /runs` it would have
 * made on expansion anyway - so this costs an expanded section nothing extra,
 * and a collapsed one a single list call.
 */
export function useRecentSendsRelevance(tab: Tab): SectionRelevance {
	const { data, isLoading } = useRecentDesignRunsQuery(tab.entityId);
	if (isLoading && !data) return "content";
	return (data?.data ?? []).length === 0 ? { empty: "not sent yet" } : "content";
}
