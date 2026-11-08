/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OAuth2LoadTestGuard - says whether a duration-based load test will stay
 * authorized for its whole length.
 *
 * The engine now refreshes a header-placed OAuth 2.0 token *during* the run
 * (#478), a collection load run's steps included (#3199), so most long runs
 * need no warning at all. What is left is the set of credentials it cannot
 * renew - a query-placed token, `autoRefreshToken: false`, an authorization_code
 * grant with no refresh token - where a run longer than the token still starts
 * failing partway through:
 *
 *   - covered              → nothing to do (including "the engine will renew it")
 *   - stale-but-coverable  → offer Refresh (a fresh token gives a full window)
 *   - longer-than-lifetime → block, with an explicit "start anyway" override
 *
 * Which case applies is `isMidRunRefreshable`, whose docstring holds the exact
 * rule and how far it mirrors the engine's; see oauth2-load-test-coverage.ts.
 *
 * A run fetches its token once, before any script, from the stored values
 * (#2742), so that is the token judged here. Where a pre-request script may
 * change a name the config uses, a Send could judge another token, so each
 * verdict says which one it is about (`scriptMayChangeSettings`).
 *
 * Reports whether the Start button should be gated via onGateChange. The
 * request's load dialog renders one; the collection run dialog renders one per
 * distinct token its requests send, and gates Run while any of them gates.
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Button, Switch } from "@/components/ui";
import { computeOAuth2CacheKey } from "@/services/oauth/cache-key";
import { useOAuth2TokenStatusQuery, useFetchOAuth2TokenMutation } from "@/queries/oauth";
import { useToastStore } from "@/stores";
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
	/** Total test duration in seconds, or null when the test has no fixed
	 *  duration (iterations mode) - in which case the guard is inert. */
	durationSeconds: number | null;
	/** A pre-request script may change a name in `config` (the dialog's deferred
	 *  names are not empty): the verdicts then name the token as fetched before
	 *  scripts. */
	scriptMayChangeSettings?: boolean;
	onGateChange: (gated: boolean) => void;
}

export default function OAuth2LoadTestGuard({
	config,
	durationSeconds,
	scriptMayChangeSettings = false,
	onGateChange,
}: OAuth2LoadTestGuardProps) {
	const showToast = useToastStore((s) => s.showToast);
	const [acknowledged, setAcknowledged] = useState(false);

	const cacheKey = useMemo(() => {
		if (!config.accessTokenUrl || !config.clientId) return null;
		return computeOAuth2CacheKey(config);
	}, [config]);

	const statusQuery = useOAuth2TokenStatusQuery(cacheKey);
	const fetchMutation = useFetchOAuth2TokenMutation();

	const status = statusQuery.data;
	// A token the engine flags expired has lapsed whatever its `expiresAt` says, so
	// the same phase the token row shows decides it; the clock flips it at the
	// expiry without waiting for the next poll.
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

	// Compute the coverage state (pure decision - see coverageState).
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

	// With an answer on screen a failed refetch changes nothing: the stale verdict
	// stands. Only an absent answer can be pending or unreachable (#3388).
	const noToken = status ? "none-cached" : noTokenState(false, statusQuery);

	// Reset the override whenever the situation changes. This is the render-phase
	// "adjust state when a prop changes" pattern - cheaper and more correct than a
	// reset effect (no extra commit, no stale-frame flash).
	const situation = `${durationSeconds}${cacheKey ?? ""}${state.kind}`;
	const [prevSituation, setPrevSituation] = useState(situation);
	if (situation !== prevSituation) {
		setPrevSituation(situation);
		setAcknowledged(false);
	}

	// A test is gated when it would outlive the token and the user hasn't
	// resolved it (refreshed into coverage, or explicitly acknowledged).
	const gated = (state.kind === "refresh" || state.kind === "too-long") && !acknowledged;

	useEffect(() => {
		onGateChange(gated);
	}, [gated, onGateChange]);

	if (state.kind === "inert" || state.kind === "no-config") {
		return null;
	}

	const handleRefresh = () => {
		fetchMutation.mutate(
			{ config, force: true },
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

	// refresh or too-long → a real warning with an override. `blocking`, not
	// `warning`: both of these disable Start, and with a pre-request-script
	// notice possibly sitting beside them the severity is what says which one is
	// actually stopping the run.
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
