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
 * (#478), so most long runs need no warning at all. What is left is the set of
 * credentials it cannot renew - a query-placed token, `autoRefreshToken: false`,
 * an authorization_code grant with no refresh token - where a run longer than
 * the token still starts failing partway through:
 *
 *   - covered              → nothing to do (including "the engine will renew it")
 *   - stale-but-coverable  → offer Refresh (a fresh token gives a full window)
 *   - longer-than-lifetime → block, with an explicit "start anyway" override
 *
 * Which case applies is `isMidRunRefreshable`, whose docstring holds the exact
 * rule and how far it mirrors the engine's; see oauth2-load-test-coverage.ts.
 *
 * Reports whether the Start button should be gated via onGateChange.
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Button, Switch } from "@/components/ui";
import { computeOAuth2CacheKey } from "@/services/oauth/cache-key";
import { useOAuth2TokenStatusQuery, useFetchOAuth2TokenMutation } from "@/queries/oauth";
import { useToastStore } from "@/stores";
import { humanizeOAuth2Error } from "@/constants/oauth2-fields";
import type { OAuth2Config } from "@/types";
import { coverageState, fmtDuration, isMidRunRefreshable } from "./oauth2-load-test-coverage";
import { Callout } from "@/components/shared";

interface OAuth2LoadTestGuardProps {
	/** Variable-resolved OAuth 2.0 config for the pending request. */
	config: OAuth2Config;
	/** Total test duration in seconds, or null when the test has no fixed
	 *  duration (iterations mode) - in which case the guard is inert. */
	durationSeconds: number | null;
	onGateChange: (gated: boolean) => void;
}

export default function OAuth2LoadTestGuard({
	config,
	durationSeconds,
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

	const token = statusQuery.data?.found ? statusQuery.data.token : undefined;

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

	if (state.kind === "covered") {
		return (
			<Callout severity="info" positive>
				{state.nonExpiring
					? "Access token doesn't expire - it covers the whole run."
					: state.viaRefresh
						? "Access token expires during the run - the engine refreshes it mid-run."
						: "Access token covers the whole run."}
			</Callout>
		);
	}

	if (state.kind === "no-token") {
		return (
			<Callout
				severity="warning"
				title="No token cached yet"
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
						<span className="ml-1.5">Fetch &amp; check</span>
					</Button>
				}
			>
				One is fetched when the run starts. If its lifetime is shorter than the run,
				requests fail once it expires.
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
					? "Token expires before the run ends"
					: "Token is shorter than the run"
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
						<span className="ml-1.5">Refresh token</span>
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
