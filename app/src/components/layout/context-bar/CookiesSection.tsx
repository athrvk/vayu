/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The cookies this request's host has in the jar.
 *
 * **This is an approximation and the UI says so.** libcurl decides what is
 * actually attached, applying the full domain/path/secure/expiry matching rules;
 * re-implementing those here would be a second matcher to keep in step with a
 * C library, and it would be wrong in the cases that matter (a path-scoped
 * cookie, a `Secure` cookie on an http URL). So this filters by host, calls
 * itself "cookies for this host", and points at the raw-request view - which
 * shows the `Cookie` line the jar actually sent - for the exact answer.
 *
 * The jar is per environment (issue #301), so the section reads the scope for
 * the environment that is active right now and clears that one.
 */

import { Cookie as CookieIcon } from "lucide-react";
import { useCookiesQuery, useClearCookiesMutation } from "@/queries/cookies";
import { useRequestQuery } from "@/queries";
import { useVariableResolver } from "@/hooks/useVariableResolver";
import { useSessionStore } from "@/stores";
import { Button } from "@/components/ui";
import { TruncatedText } from "@/components/shared";
import { cookieMatchesHost, hostOf } from "./cookie-host";
import { SectionEmpty, SectionLoading } from "./Section";
import type { ContextBarSectionProps } from "./types";

export function CookiesSection({ tab }: ContextBarSectionProps) {
	const { data: request } = useRequestQuery(tab.entityId);
	const { resolveString } = useVariableResolver({
		collectionId: request?.collectionId || undefined,
	});
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const { data, isLoading } = useCookiesQuery();
	const clearCookies = useClearCookiesMutation();

	if (isLoading) return <SectionLoading />;

	const host = request ? hostOf(resolveString(request.url)) : null;
	if (!host) return <SectionEmpty>This request has no host yet</SectionEmpty>;

	const scope = data?.scopes.find((s) => (s.environmentId ?? null) === activeEnvironmentId);
	const matches = (scope?.cookies ?? []).filter((c) => cookieMatchesHost(c, host));

	return (
		<div className="space-y-2">
			<p className="text-[11px] text-muted-foreground m-0">
				Cookies for <span className="font-mono text-foreground">{host}</span>. libcurl
				decides what is finally attached - the response's raw request view shows the exact{" "}
				<span className="font-mono">Cookie</span> line that was sent.
			</p>
			{matches.length === 0 ? (
				<SectionEmpty>No cookies held for this host</SectionEmpty>
			) : (
				<>
					<ul className="space-y-1 m-0 p-0 list-none">
						{matches.map((cookie) => (
							<li
								key={`${cookie.domain}${cookie.path}${cookie.name}`}
								className="flex items-center gap-1.5 min-w-0"
							>
								<CookieIcon
									className="w-3 h-3 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								<TruncatedText className="text-xs font-mono text-foreground">
									{cookie.name}
								</TruncatedText>
								<span className="text-[10px] text-muted-foreground shrink-0">
									{cookie.domain}
									{cookie.path}
								</span>
							</li>
						))}
					</ul>
					<Button
						variant="outline"
						size="sm"
						className="h-6 text-xs"
						disabled={clearCookies.isPending}
						onClick={() => clearCookies.mutate({ environmentId: activeEnvironmentId })}
					>
						Clear jar for this environment
					</Button>
				</>
			)}
		</div>
	);
}
