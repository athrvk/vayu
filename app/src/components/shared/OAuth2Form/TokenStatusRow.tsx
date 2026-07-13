/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { ApiError } from "@/services/http-client";
import {
	useOAuth2TokenStatusQuery,
	useFetchOAuth2TokenMutation,
	useClearOAuth2TokenMutation,
} from "@/queries/oauth";
import { queryKeys } from "@/queries/keys";
import { computeOAuth2CacheKey } from "@/services/oauth/cache-key";
import { runInteractiveAuthorization } from "@/services/oauth/authorize";
import { useToastStore } from "@/stores";
import type { OAuth2Config } from "@/types";

interface TokenStatusRowProps {
	/** The config with {{variables}} already resolved (used for the token request). */
	resolvedConfig: OAuth2Config;
}

function maskToken(token: string): string {
	if (token.length <= 10) return "••••";
	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function humanizeExpiry(expiresAt: number | null): string {
	if (expiresAt === null) return "does not expire";
	const ms = expiresAt - Date.now();
	if (ms <= 0) return "expired";
	const mins = Math.round(ms / 60_000);
	if (mins < 60) return `expires in ${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `expires in ${hours}h`;
	return `expires in ${Math.round(hours / 24)}d`;
}

export default function TokenStatusRow({ resolvedConfig }: TokenStatusRowProps) {
	const showToast = useToastStore((s) => s.showToast);
	const queryClient = useQueryClient();
	const [authorizing, setAuthorizing] = useState(false);

	const cacheKey = useMemo(() => {
		if (!resolvedConfig.accessTokenUrl || !resolvedConfig.clientId) return null;
		return computeOAuth2CacheKey(resolvedConfig);
	}, [resolvedConfig]);

	const statusQuery = useOAuth2TokenStatusQuery(cacheKey);
	const fetchMutation = useFetchOAuth2TokenMutation();
	const clearMutation = useClearOAuth2TokenMutation();

	const interactive = resolvedConfig.grantType === "authorization_code";
	const busy = fetchMutation.isPending || clearMutation.isPending || authorizing;

	const handleGetToken = async () => {
		if (interactive) {
			// Engine-hosted loopback + PKCE; opens the system browser (or the
			// embedded window when the config opts in).
			setAuthorizing(true);
			try {
				await runInteractiveAuthorization(resolvedConfig);
				if (cacheKey) {
					queryClient.invalidateQueries({ queryKey: queryKeys.oauth.token(cacheKey) });
				}
				showToast("Authorized", "success");
			} catch (err) {
				showToast(err instanceof Error ? err.message : "Authorization failed", "error");
			} finally {
				setAuthorizing(false);
			}
			return;
		}
		fetchMutation.mutate(
			{ config: resolvedConfig, force: true },
			{
				onError: (err) => {
					const message = err instanceof ApiError ? err.message : "Failed to get token";
					showToast(message, "error");
				},
			}
		);
	};

	const handleClear = () => {
		if (!cacheKey) return;
		clearMutation.mutate(cacheKey);
	};

	if (!cacheKey) {
		return (
			<p className="text-xs text-muted-foreground">
				Enter the token URL and client ID to fetch a token.
			</p>
		);
	}

	const status = statusQuery.data;
	const token = status?.found ? status.token : undefined;
	const expired = status?.expired ?? false;

	return (
		<div className="flex items-center gap-3 flex-wrap rounded-md border border-border bg-panel px-3 py-2">
			<div className="flex items-center gap-2 min-w-0 flex-1">
				<span
					className={`h-2 w-2 rounded-full shrink-0 ${
						token
							? expired
								? "bg-amber-500"
								: "bg-emerald-500"
							: "bg-muted-foreground/40"
					}`}
					aria-hidden
				/>
				{token ? (
					<span className="text-xs text-muted-foreground truncate">
						<code className="text-foreground">{maskToken(token.accessToken)}</code>
						{" · "}
						{expired ? "expired" : humanizeExpiry(token.expiresAt)}
					</span>
				) : (
					<span className="text-xs text-muted-foreground">No token cached</span>
				)}
			</div>

			<div className="flex items-center gap-1.5 shrink-0">
				<Button size="sm" variant="outline" onClick={handleGetToken} disabled={busy}>
					{fetchMutation.isPending || authorizing ? (
						<Loader2 className="w-3.5 h-3.5 animate-spin" />
					) : token && !expired ? (
						<RefreshCw className="w-3.5 h-3.5" />
					) : (
						<KeyRound className="w-3.5 h-3.5" />
					)}
					<span className="ml-1.5">
						{token ? (expired ? "Refresh" : "Renew") : "Get Token"}
					</span>
				</Button>
				{token && (
					<Button
						size="sm"
						variant="ghost"
						onClick={handleClear}
						disabled={busy}
						title="Clear cached token"
					>
						<Trash2 className="w-3.5 h-3.5" />
					</Button>
				)}
			</div>
		</div>
	);
}
