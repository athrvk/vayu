/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, Trash2, Loader2, Eye, EyeOff } from "lucide-react";
import { Button, IconSwap, LabelSwap, TooltipIconButton } from "@/components/ui";
import { TimeValue } from "@/components/shared/TimeValue";
import { ApiError } from "@/services/http-client";
import {
	useOAuth2TokenStatusQuery,
	useFetchOAuth2TokenMutation,
	useClearOAuth2TokenMutation,
} from "@/queries/oauth";
import { queryKeys } from "@/queries/keys";
import { deferredTokens } from "@/lib/deferred-note";
import { computeOAuth2CacheKey } from "@/services/oauth/cache-key";
import { runInteractiveAuthorization } from "@/services/oauth/authorize";
import { systemNotify, NOTIFY_KINDS } from "@/services/notify";
import { OAUTH2_FIELD_LABELS, humanizeOAuth2Error } from "@/constants/oauth2-fields";
import { useToastStore } from "@/stores";
import type { OAuth2Config } from "@/types";

interface TokenStatusRowProps {
	/** The config with {{variables}} already resolved (used for the token request). */
	resolvedConfig: OAuth2Config;
	/**
	 * The names in the as-written config that a pre-request script may change,
	 * from the engine's `deferredVariables` (#2742). A Send resolves the config
	 * after the script, so the token cached for `resolvedConfig` may not be the
	 * one it uses: with any name here the row reports no token state and says why,
	 * while Get token and Clear keep acting on the stored settings. The HOST
	 * computes it and the row never queries - three surfaces share this row and
	 * none of them gives it a query client by contract. Memoise it.
	 */
	deferredNames?: readonly string[];
}

const TOKEN_ACTION_LABELS = ["Get token", "Renew", "Refresh"] as const;

function maskToken(token: string): string {
	if (token.length <= 10) return "••••";
	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function listPhrase(items: string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The engine's `expired` flag, or the local clock if it has not caught up yet. */
function hasLapsed(expiresAt: number, expired: boolean): boolean {
	return expired || expiresAt <= Date.now();
}

function TokenExpiry({ expiresAt, expired }: { expiresAt: number | null; expired: boolean }) {
	if (expiresAt === null) return <>{expired ? "expired" : "does not expire"}</>;
	const lapsed = hasLapsed(expiresAt, expired);
	return (
		<>
			{lapsed ? "expired " : "expires "}
			<TimeValue value={expiresAt} style="relative" />
		</>
	);
}

export default function TokenStatusRow({ resolvedConfig, deferredNames }: TokenStatusRowProps) {
	if (deferredNames && deferredNames.length > 0)
		return <DeferredTokenRow resolvedConfig={resolvedConfig} names={deferredNames} />;
	return <CachedTokenRow resolvedConfig={resolvedConfig} />;
}

/**
 * What both rows do to the token stored for @p resolvedConfig: fetch it (the
 * interactive sign-in for an authorization_code grant, a client request for the
 * rest) and clear it. The rows differ in what they report, never in what the
 * actions do.
 */
function useTokenActions(resolvedConfig: OAuth2Config) {
	const showToast = useToastStore((s) => s.showToast);
	const queryClient = useQueryClient();
	const [authorizing, setAuthorizing] = useState(false);

	const cacheKey = useMemo(() => {
		if (!resolvedConfig.accessTokenUrl || !resolvedConfig.clientId) return null;
		return computeOAuth2CacheKey(resolvedConfig);
	}, [resolvedConfig]);

	const fetchMutation = useFetchOAuth2TokenMutation();
	const clearMutation = useClearOAuth2TokenMutation();

	const interactive = resolvedConfig.grantType === "authorization_code";
	const busy = fetchMutation.isPending || clearMutation.isPending || authorizing;
	const fetching = fetchMutation.isPending || authorizing;

	// What the engine needs before a token request can go anywhere: the authorize
	// start rejects without authorizationUrl + clientId, the token endpoint without
	// accessTokenUrl + clientId (clientId for every grant, not just the ones RFC
	// 6749 requires it for). Presence only - the engine owns URL validity, and
	// duplicating that rule here would be a second copy of it to keep in step;
	// its 400 arrives relabelled instead (humanizeOAuth2Error).
	const missingFields = useMemo(() => {
		const missing: string[] = [];
		if (interactive && !resolvedConfig.authorizationUrl) {
			missing.push(OAUTH2_FIELD_LABELS.authorizationUrl);
		}
		if (!resolvedConfig.accessTokenUrl) missing.push(OAUTH2_FIELD_LABELS.accessTokenUrl);
		if (!resolvedConfig.clientId) missing.push(OAUTH2_FIELD_LABELS.clientId);
		return missing;
	}, [interactive, resolvedConfig]);
	const incomplete = missingFields.length > 0;

	const getToken = async () => {
		if (incomplete) return;
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
				// The loopback flow puts the user in their browser by design, so
				// this is the one success they are guaranteed not to be looking at
				// (#1358). The click brings them back to the request they left.
				systemNotify.post({
					kind: NOTIFY_KINDS.signedIn,
					title: "Signed in",
					body: "Back to Vayu to continue.",
				});
			} catch (err) {
				showToast(
					err instanceof Error
						? humanizeOAuth2Error(err.message)
						: "Authorization failed",
					"error"
				);
			} finally {
				setAuthorizing(false);
			}
			return;
		}
		fetchMutation.mutate(
			{ config: resolvedConfig, force: true },
			{
				onError: (err) => {
					const message =
						err instanceof ApiError
							? humanizeOAuth2Error(err.message)
							: "Couldn't get token";
					showToast(message, "error");
				},
			}
		);
	};

	const clear = () => {
		if (!cacheKey) return;
		clearMutation.mutate(cacheKey);
	};

	return { cacheKey, missingFields, incomplete, busy, fetching, getToken, clear };
}

type TokenActions = ReturnType<typeof useTokenActions>;

/** The bordered box both rows draw: a dot and a summary on the left, the action rail on the right. */
function TokenRowShell({
	dotClass,
	summary,
	rail,
	below,
}: {
	dotClass: string;
	summary: ReactNode;
	rail: ReactNode;
	below?: ReactNode;
}) {
	return (
		<div className="rounded-md border border-border bg-panel">
			{/* Summary row - geometry never changes */}
			<div className="flex items-center gap-3 px-3 py-2">
				<div className="flex items-center gap-2 min-w-0 flex-1">
					<span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} aria-hidden />
					{summary}
				</div>

				{/*
				 * Action rail. The token action is its last child, so the row's
				 * right edge pins it: everything that mounts once a token lands
				 * goes before it, and its glyph and label reserve their widest
				 * state. With Clear after it, the button slid left by Clear's
				 * width the moment a fetch landed, and a second click on the same
				 * spot cleared the token just fetched - the hazard
				 * `SchemaStatusBadge` documents for its Refresh button.
				 */}
				<div className="flex items-center gap-1 shrink-0">{rail}</div>
			</div>
			{below}
		</div>
	);
}

function ClearTokenButton({ actions }: { actions: TokenActions }) {
	return (
		<TooltipIconButton
			size="sm"
			label="Clear cached token"
			onClick={actions.clear}
			disabled={actions.busy}
			icon={<Trash2 className="size-icon-sm" />}
		/>
	);
}

function GetTokenButton({
	actions,
	label,
	renews,
}: {
	actions: TokenActions;
	label: (typeof TOKEN_ACTION_LABELS)[number];
	/** The glyph for a token that is current: renew, not fetch. */
	renews: boolean;
}) {
	return (
		<Button
			size="sm"
			variant="outline"
			onClick={actions.getToken}
			disabled={actions.busy || actions.incomplete}
		>
			<IconSwap
				state={actions.fetching ? "pending" : renews ? "renew" : "fetch"}
				icons={{
					fetch: <KeyRound className="size-icon-sm" />,
					renew: <RefreshCw className="size-icon-sm" />,
					pending: <Loader2 className="size-icon-sm animate-spin" />,
				}}
			/>
			<LabelSwap label={label} states={TOKEN_ACTION_LABELS} />
		</Button>
	);
}

/**
 * The row for a config a pre-request script may change (#2742). It reads no
 * cache entry and reports no token: a Send resolves the config after the script,
 * so the token cached for the stored values may not be the one it sends, and the
 * row cannot know the one it does. The actions stay live because they act on the
 * stored settings, and for an authorization_code grant this row is the only
 * place to sign in.
 */
function DeferredTokenRow({
	resolvedConfig,
	names,
}: {
	resolvedConfig: OAuth2Config;
	names: readonly string[];
}) {
	const actions = useTokenActions(resolvedConfig);
	return (
		<TokenRowShell
			dotClass="bg-muted-foreground/40"
			summary={
				<span className="text-xs text-muted-foreground">
					{deferredTokens(names)} may be changed by a pre-request script, so the token
					this request sends is fetched at send, after the script. Get token and Clear act
					on the stored settings.
				</span>
			}
			rail={
				<>
					<ClearTokenButton actions={actions} />
					<GetTokenButton actions={actions} label="Get token" renews={false} />
				</>
			}
			below={
				actions.incomplete && <MissingFieldsNote missingFields={actions.missingFields} />
			}
		/>
	);
}

function MissingFieldsNote({ missingFields }: { missingFields: string[] }) {
	return (
		<div className="border-t border-border px-3 py-2">
			<p className="text-xs text-muted-foreground">
				Enter the {listPhrase(missingFields)} to fetch a token
			</p>
		</div>
	);
}

function CachedTokenRow({ resolvedConfig }: { resolvedConfig: OAuth2Config }) {
	const actions = useTokenActions(resolvedConfig);
	const { cacheKey, missingFields, incomplete } = actions;
	const [revealed, setRevealed] = useState(false);

	// Re-hide the token whenever the config identity changes (render-phase reset)
	// so switching requests never reveals a different token unmasked.
	const [prevKey, setPrevKey] = useState(cacheKey);
	if (cacheKey !== prevKey) {
		setPrevKey(cacheKey);
		setRevealed(false);
	}

	const statusQuery = useOAuth2TokenStatusQuery(cacheKey);
	const status = statusQuery.data;
	const token = status?.found ? status.token : undefined;
	const expired = status?.expired ?? false;

	return (
		<TokenRowShell
			dotClass={
				token ? (expired ? "bg-warning" : "bg-status-success") : "bg-muted-foreground/40"
			}
			summary={
				token ? (
					<span className="text-xs text-muted-foreground">
						<code className="text-foreground">{maskToken(token.accessToken)}</code>
						{" · "}
						<TokenExpiry expiresAt={token.expiresAt} expired={expired} />
					</span>
				) : incomplete ? (
					<span className="text-xs text-muted-foreground">
						Enter the {listPhrase(missingFields)} to fetch a token
					</span>
				) : (
					<span className="text-xs text-muted-foreground">No token cached</span>
				)
			}
			rail={
				<>
					{token && (
						<TooltipIconButton
							size="sm"
							label={revealed ? "Hide token" : "Show full token"}
							aria-pressed={revealed}
							onClick={() => setRevealed((v) => !v)}
							icon={
								<IconSwap
									state={revealed ? "revealed" : "hidden"}
									icons={{
										hidden: <Eye className="size-icon-sm" />,
										revealed: <EyeOff className="size-icon-sm" />,
									}}
								/>
							}
						/>
					)}
					{token && <ClearTokenButton actions={actions} />}
					<GetTokenButton
						actions={actions}
						label={token ? (expired ? "Refresh" : "Renew") : "Get token"}
						renews={!!token && !expired}
					/>
				</>
			}
			below={
				<>
					{/* A cached token survives edits that break the config - the cache key
					    omits grantType, so switching Client Credentials → Authorization Code
					    keeps the token on screen while the empty Authorization URL disables
					    the action. The summary slot is taken by the token, so the reason goes
					    below rather than nowhere. */}
					{incomplete && token && <MissingFieldsNote missingFields={missingFields} />}

					{/* Full token disclosure - expands below, doesn't affect the row above */}
					{revealed && token && (
						<div className="border-t border-border px-3 py-2">
							<code className="block break-all text-label leading-relaxed text-foreground select-all">
								{token.accessToken}
							</code>
						</div>
					)}
				</>
			}
		/>
	);
}
