/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Says whether a duration-based load test stays authorized for its whole length. The engine
 * refreshes a header-placed OAuth 2.0 token during the run (#478), a collection load run's steps
 * included (#3199), so most long runs need no warning. Left are the credentials it cannot renew (a
 * query-placed token, `autoRefreshToken: false`, an authorization_code grant with no refresh
 * token), where a run longer than the token fails partway:
 *
 *   - covered              → nothing to do (including "the engine will renew it")
 *   - stale-but-coverable  → offer Refresh (a fresh token gives a full window)
 *   - longer-than-lifetime → block, with an explicit "start anyway" override
 *
 * `isMidRunRefreshable` (oauth2-load-test-coverage.ts) holds the exact rule and how far it mirrors
 * the engine. A run fetches its token once, before any script, from stored values (#2742), so that
 * token is judged; where a pre-request script may change a config name, each verdict says which
 * token it means (`scriptMayChangeSettings`). Gating goes out through `onGateChange`: the load
 * dialog renders one guard, the collection run dialog one per distinct token, gating Run while any
 * gates.
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Button, Switch } from "@/components/ui";
import { oauth2TokenKey } from "@/services/oauth/cache-key";
import { awaitsDiscovery } from "@/services/oauth/discovery";
import { useOAuth2TokenStatusQuery, useFetchOAuth2TokenMutation } from "@/queries/oauth";
import { tokenScopeIds } from "@/services/oauth/signing-key";
import { useSessionStore, useToastStore } from "@/stores";
import { humanizeOAuth2Error } from "@/constants/oauth2-fields";
import type { OAuth2Config } from "@/types";
import {
	coverageState,
	fmtDuration,
	isMidRunRefreshable,
	willRefreshFetchedToken,
} from "./oauth2-load-test-coverage";
import { Callout } from "@/components/shared";
import { lapseInstant, noTokenState, tokenPhase } from "@/components/shared/OAuth2Form/token-phase";
import { useNow } from "@/hooks/useNow";

interface OAuth2LoadTestGuardProps {
	/** Variable-resolved OAuth 2.0 config for the pending request. */
	config: OAuth2Config;
	/**
	 * Test length in seconds, or null without a fixed duration (iterations mode): the guard is
	 * inert.
	 */
	durationSeconds: number | null;
	/**
	 * A pre-request script may change a `config` name (deferred names exist): verdicts name the
	 * pre-script token.
	 */
	scriptMayChangeSettings?: boolean;
	/**
	 * Named to the engine on a refresh, beside the active environment, for a `jwt_bearer` key
	 * reference (#3632).
	 */
	collectionId?: string;
	onGateChange: (gated: boolean) => void;
}

export default function OAuth2LoadTestGuard({
	config,
	durationSeconds,
	scriptMayChangeSettings = false,
	collectionId,
	onGateChange,
}: OAuth2LoadTestGuardProps) {
	const showToast = useToastStore((s) => s.showToast);
	const environmentId = useSessionStore((s) => s.activeEnvironmentId);
	const [acknowledged, setAcknowledged] = useState(false);

	const cacheKey = useMemo(() => oauth2TokenKey(config), [config]);

	const statusQuery = useOAuth2TokenStatusQuery(cacheKey);
	const fetchMutation = useFetchOAuth2TokenMutation();

	const status = statusQuery.data;
	// A token the engine flags expired has lapsed whatever `expiresAt` says, so the token row's
	// phase decides it, and the clock flips it at expiry without waiting for a poll.
	const now = useNow(lapseInstant(status));
	const lapsed = tokenPhase(status, now).expiry?.word === "expired";
	const cachedToken = status?.found ? status.token : undefined;
	const token = useMemo(
		() =>
			cachedToken && lapsed
				? { ...cachedToken, expiresAt: Math.min(cachedToken.expiresAt ?? now, now) }
				: cachedToken,
		[cachedToken, lapsed, now]
	);

	// Pure decision: see coverageState.
	const state = useMemo(
		() =>
			coverageState(
				durationSeconds,
				cacheKey != null,
				token,
				isMidRunRefreshable(config, token)
			),
		[durationSeconds, cacheKey, token, config]
	);

	// With an answer on screen a failed refetch changes nothing; only an absent answer can be
	// pending or unreachable (#3388).
	const noToken = status ? "none-cached" : noTokenState(false, statusQuery);

	// Reset the override when the situation changes, in render ("adjust state when a prop
	// changes"): no extra commit and no stale-frame flash, unlike a reset effect.
	const situation = `${durationSeconds}${cacheKey ?? ""}${state.kind}`;
	const [prevSituation, setPrevSituation] = useState(situation);
	if (situation !== prevSituation) {
		setPrevSituation(situation);
		setAcknowledged(false);
	}

	// Gated when the test would outlive the token and the user has not refreshed into coverage or
	// acknowledged it.
	const gated = (state.kind === "refresh" || state.kind === "too-long") && !acknowledged;

	useEffect(() => {
		onGateChange(gated);
	}, [gated, onGateChange]);

	// Whatever the length: a config whose endpoints only a sign-in finds (#3766) has no token a
	// headless run could fetch.
	if (awaitsDiscovery(config)) {
		return (
			<Callout severity="warning" title="Sign in before running">
				This auth finds its endpoints from the server URL when you sign in, and a run
				can&apos;t sign in. Get a token from the Auth tab first.
			</Callout>
		);
	}

	if (state.kind === "inert" || state.kind === "no-config") {
		return null;
	}

	const handleRefresh = () => {
		fetchMutation.mutate(
			{ config, force: true, ...tokenScopeIds(environmentId, collectionId) },
			{
				onError: (err) =>
					showToast(
						err instanceof Error
							? `Couldn't refresh the OAuth 2.0 token - ${humanizeOAuth2Error(err.message)}`
							: "Couldn't refresh the OAuth 2.0 token.",
						"error"
					),
			}
		);
	};

	// The sentence subject and the title lead-in for the token being judged.
	const subject = scriptMayChangeSettings ? "The token fetched before scripts" : "Access token";
	const tokenName = scriptMayChangeSettings ? "Token fetched before scripts" : "Token";

	if (state.kind === "covered") {
		return (
			<Callout severity="info" positive>
				{state.nonExpiring
					? `${subject} doesn't expire - it covers the whole run.`
					: state.viaRefresh
						? `${subject} expires during the run - Vayu's engine refreshes it mid-run.`
						: `${subject} covers the whole run.`}
			</Callout>
		);
	}

	if (state.kind === "no-token" && noToken === "checking") {
		return <Callout severity="info" title="Checking for a cached token…" />;
	}

	if (state.kind === "no-token" && noToken === "check-failed") {
		return (
			<Callout severity="warning" title="Couldn't check for a cached token">
				Whether one is cached, and how long it lasts, isn&apos;t known. Starting is not
				blocked.
			</Callout>
		);
	}

	if (state.kind === "no-token") {
		return (
			<Callout
				severity="warning"
				title={
					scriptMayChangeSettings
						? "No token cached for the stored settings"
						: "No token cached yet"
				}
				action={
					<Button
						size="sm"
						variant="outline"
						onClick={handleRefresh}
						disabled={fetchMutation.isPending}
					>
						{fetchMutation.isPending ? (
							<Loader2 className="size-icon-sm animate-spin" />
						) : (
							<RefreshCw className="size-icon-sm" />
						)}
						Fetch &amp; check
					</Button>
				}
			>
				{willRefreshFetchedToken(config)
					? "One is fetched when the run starts, and Vayu's engine refreshes it mid-run if it expires."
					: "One is fetched when the run starts. If its lifetime is shorter than the run, requests fail once it expires."}
			</Callout>
		);
	}

	// refresh or too-long: a real warning with an override, `blocking` not `warning`, since both
	// disable Start and, beside a pre-request-script notice, severity says which one stops the run.
	const isRefreshable = state.kind === "refresh";
	return (
		<Callout
			severity="blocking"
			title={
				isRefreshable
					? `${tokenName} expires before the run ends`
					: `${tokenName} is shorter than the run`
			}
			action={
				<label className="flex items-center gap-2 text-label text-muted-foreground">
					<Switch checked={acknowledged} onCheckedChange={setAcknowledged} />
					Start anyway
				</label>
			}
		>
			{isRefreshable ? (
				<>
					the cached token expires in <strong>{fmtDuration(state.remainingMs)}</strong>,
					but this run lasts <strong>{fmtDuration(state.durationMs)}</strong>. Refresh for
					a full <strong>{fmtDuration(state.lifetimeMs)}</strong> window.
					<Button
						size="sm"
						variant="outline"
						onClick={handleRefresh}
						disabled={fetchMutation.isPending}
						className="mt-2 flex"
					>
						{fetchMutation.isPending ? (
							<Loader2 className="size-icon-sm animate-spin" />
						) : (
							<RefreshCw className="size-icon-sm" />
						)}
						Refresh token
					</Button>
				</>
			) : (
				<>
					this provider&apos;s tokens last only{" "}
					<strong>{fmtDuration(state.lifetimeMs)}</strong>, shorter than the{" "}
					<strong>{fmtDuration(state.durationMs)}</strong> run. Requests fail once it
					expires - this credential can&apos;t be renewed mid-run (a query-placed token,
					auto-refresh turned off, or an authorization-code grant with no refresh token),
					so shorten the run to avoid failures.
				</>
			)}
		</Callout>
	);
}
