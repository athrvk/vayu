/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OAuth2LoadTestGuard — warns when a duration-based load test would outlive its
 * OAuth 2.0 access token. The engine acquires the token once at run start and
 * does not refresh mid-run, so a test longer than the token's remaining life
 * starts failing partway through. This is the interim guard for that gap:
 *
 *   - covered            → nothing to do
 *   - stale-but-coverable → offer Refresh (a fresh token gives a full window)
 *   - longer-than-lifetime → block, with an explicit "start anyway" override
 *
 * Reports whether the Start button should be gated via onGateChange.
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Loader2 } from "lucide-react";
import { Button, Switch } from "@/components/ui";
import { computeOAuth2CacheKey } from "@/services/oauth/cache-key";
import { useOAuth2TokenStatusQuery, useFetchOAuth2TokenMutation } from "@/queries/oauth";
import { useToastStore } from "@/stores";
import type { OAuth2Config } from "@/types";
import { coverageState, fmtDuration } from "./oauth2-load-test-coverage";
import { Callout } from "./LoadTestConfigDialog/Callout";

interface OAuth2LoadTestGuardProps {
	/** Variable-resolved OAuth 2.0 config for the pending request. */
	config: OAuth2Config;
	/** Total test duration in seconds, or null when the test has no fixed
	 *  duration (iterations mode) — in which case the guard is inert. */
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

	// Compute the coverage state (pure decision — see coverageState).
	const state = useMemo(
		() => coverageState(durationSeconds, cacheKey != null, token),
		[durationSeconds, cacheKey, token]
	);

	// Reset the override whenever the situation changes. This is the render-phase
	// "adjust state when a prop changes" pattern — cheaper and more correct than a
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
					showToast(err instanceof Error ? err.message : "Token refresh failed", "error"),
			}
		);
	};

	if (state.kind === "covered") {
		return (
			<Callout severity="info" positive>
				{state.nonExpiring
					? "Access token does not expire — it covers the full test."
					: "Access token covers the full test duration."}
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
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<RefreshCw className="h-3.5 w-3.5" />
						)}
						<span className="ml-1.5">Fetch &amp; check</span>
					</Button>
				}
			>
				One is fetched when the test starts; if its lifetime is shorter than the test,
				requests will fail after it expires.
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
				<label className="flex items-center gap-2 text-[11px] text-muted-foreground">
					<Switch checked={acknowledged} onCheckedChange={setAcknowledged} />
					Start anyway
				</label>
			}
		>
			{isRefreshable ? (
				<>
					the cached token expires in <strong>{fmtDuration(state.remainingMs)}</strong>,
					but this test runs for <strong>{fmtDuration(state.durationMs)}</strong>. Refresh
					for a full <strong>{fmtDuration(state.lifetimeMs)}</strong> window.
					<Button
						size="sm"
						variant="outline"
						onClick={handleRefresh}
						disabled={fetchMutation.isPending}
						className="mt-2 flex"
					>
						{fetchMutation.isPending ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<RefreshCw className="h-3.5 w-3.5" />
						)}
						<span className="ml-1.5">Refresh token</span>
					</Button>
				</>
			) : (
				<>
					this provider&apos;s tokens last only{" "}
					<strong>{fmtDuration(state.lifetimeMs)}</strong>, shorter than the{" "}
					<strong>{fmtDuration(state.durationMs)}</strong> test. Requests will fail once
					it expires — mid-run refresh isn&apos;t supported yet, so shorten the run to
					avoid failures.
				</>
			)}
		</Callout>
	);
}
