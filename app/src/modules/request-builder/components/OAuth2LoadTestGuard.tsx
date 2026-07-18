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
import { AlertTriangle, CheckCircle2, RefreshCw, Loader2 } from "lucide-react";
import { Button, Switch } from "@/components/ui";
import { computeOAuth2CacheKey } from "@/services/oauth/cache-key";
import { useOAuth2TokenStatusQuery, useFetchOAuth2TokenMutation } from "@/queries/oauth";
import { useToastStore } from "@/stores";
import type { OAuth2Config } from "@/types";
import { coverageState, fmtDuration } from "./oauth2-load-test-coverage";

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
			<div className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-xs text-muted-foreground">
				<CheckCircle2 className="h-3.5 w-3.5 text-status-success shrink-0" />
				{state.nonExpiring
					? "Access token does not expire — it covers the full test."
					: "Access token covers the full test duration."}
			</div>
		);
	}

	if (state.kind === "no-token") {
		return (
			<div className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-xs text-muted-foreground">
				<AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
				<span className="flex-1">
					No token cached yet. One is fetched when the test starts; if its lifetime is
					shorter than the test, requests will fail after it expires.
				</span>
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
			</div>
		);
	}

	// refresh or too-long → a real warning with an override.
	const isRefreshable = state.kind === "refresh";
	return (
		<div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5">
			<div className="flex items-start gap-2">
				<AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
				<div className="text-xs text-foreground">
					{isRefreshable ? (
						<>
							The cached token expires in{" "}
							<strong>{fmtDuration(state.remainingMs)}</strong>, but this test runs
							for <strong>{fmtDuration(state.durationMs)}</strong>. Refresh for a full{" "}
							<strong>{fmtDuration(state.lifetimeMs)}</strong> window before starting.
						</>
					) : (
						<>
							This provider&apos;s tokens last only{" "}
							<strong>{fmtDuration(state.lifetimeMs)}</strong>, shorter than the{" "}
							<strong>{fmtDuration(state.durationMs)}</strong> test. Requests will
							fail once the token expires — mid-run refresh isn&apos;t supported yet.
						</>
					)}
				</div>
			</div>

			<div className="flex items-center justify-between gap-3 pl-6">
				{isRefreshable ? (
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
						<span className="ml-1.5">Refresh token</span>
					</Button>
				) : (
					<span className="text-[11px] text-muted-foreground">
						Shorten the test duration to avoid failures.
					</span>
				)}
				<label className="flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
					<Switch checked={acknowledged} onCheckedChange={setAcknowledged} />
					Start anyway
				</label>
			</div>
		</div>
	);
}
