/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { useMemo, useState, type ReactNode } from "react";
import { KeyRound, RefreshCw, Trash2, Loader2, Eye, EyeOff, X } from "lucide-react";
import { Button, IconSwap, LabelSwap, TooltipIconButton } from "@/components/ui";
import { TimeValue } from "@/components/shared/TimeValue";
import { ApiError } from "@/services/http-client";
import {
	useOAuth2TokenStatusQuery,
	useFetchOAuth2TokenMutation,
	useClearOAuth2TokenMutation,
} from "@/queries/oauth";
import { deferredTokens } from "@/lib/deferred-note";
import { oauth2TokenKey } from "@/services/oauth/cache-key";
import { awaitsDiscovery, discoveredValues } from "@/services/oauth/discovery";
import { humanizeOAuth2Error } from "@/constants/oauth2-fields";
import { tokenScopeIds } from "@/services/oauth/signing-key";
import { useSessionStore, useToastStore } from "@/stores";
import { useNow } from "@/hooks/useNow";
import type { OAuth2Config, OAuth2DiscoveredField } from "@/types";
import { fieldListPhrase, missingOAuth2Fields } from "./missing-fields";
import { useOAuth2SignIn, type OAuth2SignedIn } from "./useOAuth2SignIn";
import {
	TOKEN_ACTION_LABELS,
	lapseInstant,
	noTokenState,
	tokenPhase,
	type NoTokenState,
	type TokenExpiryText,
	type TokenPhase,
} from "./token-phase";

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
	/**
	 * The collection a Get token names to the engine beside the active
	 * environment, which resolve a `jwt_bearer` key reference (#3632).
	 */
	collectionId?: string | null;
	/**
	 * Writes what a discovered sign-in filled into the stored config (#3766).
	 * Only a host that edits the config passes it; without it a config still
	 * awaiting discovery cannot be signed in here, because the token would land
	 * under a key the stored config never comes to name.
	 */
	onDiscovered?: (values: Partial<Record<OAuth2DiscoveredField, string>>) => void;
}

function maskToken(token: string): string {
	if (token.length <= 10) return "••••";
	return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function TokenExpiry({ expiry }: { expiry: TokenExpiryText }) {
	if (expiry.at === null) return <>{expiry.word}</>;
	return (
		<>
			{expiry.word} <TimeValue value={expiry.at} style="relative" />
		</>
	);
}

export default function TokenStatusRow({
	resolvedConfig,
	deferredNames,
	collectionId,
	onDiscovered,
}: TokenStatusRowProps) {
	if (deferredNames && deferredNames.length > 0)
		return (
			<DeferredTokenRow
				resolvedConfig={resolvedConfig}
				names={deferredNames}
				collectionId={collectionId}
				onDiscovered={onDiscovered}
			/>
		);
	return (
		<CachedTokenRow
			resolvedConfig={resolvedConfig}
			collectionId={collectionId}
			onDiscovered={onDiscovered}
		/>
	);
}

type RowProps = Pick<TokenStatusRowProps, "resolvedConfig" | "collectionId" | "onDiscovered">;

/**
 * What both rows do to the token stored for @p resolvedConfig: fetch it (the
 * interactive sign-in for an authorization_code grant, a client request for the
 * rest) and clear it. The rows differ in what they report, never in what the
 * actions do.
 */
function useTokenActions({ resolvedConfig, collectionId, onDiscovered }: RowProps) {
	const showToast = useToastStore((s) => s.showToast);
	const environmentId = useSessionStore((s) => s.activeEnvironmentId);

	const cacheKey = useMemo(() => oauth2TokenKey(resolvedConfig), [resolvedConfig]);
	const awaiting = useMemo(() => awaitsDiscovery(resolvedConfig), [resolvedConfig]);

	const writeDiscovered: OAuth2SignedIn | undefined = onDiscovered
		? ({ resolved }, sent) => {
				if (resolved) onDiscovered(discoveredValues(sent, resolved));
			}
		: undefined;
	const signin = useOAuth2SignIn(resolvedConfig, writeDiscovered);

	const fetchMutation = useFetchOAuth2TokenMutation();
	const clearMutation = useClearOAuth2TokenMutation();

	const interactive = resolvedConfig.grantType === "authorization_code";
	const busy = fetchMutation.isPending || clearMutation.isPending || signin.authorizing;
	const fetching = fetchMutation.isPending || signin.authorizing;

	// Which fields are absent is `missingOAuth2Fields`'s to say; this memo only
	// keeps the list's identity still across renders that change nothing.
	const missingFields = useMemo(() => missingOAuth2Fields(resolvedConfig), [resolvedConfig]);
	const incomplete = missingFields.length > 0;
	const discoveryElsewhere = awaiting && !onDiscovered;

	const getToken = async () => {
		if (incomplete || discoveryElsewhere) return;
		if (interactive) {
			await signin.signIn();
			return;
		}
		fetchMutation.mutate(
			{ config: resolvedConfig, force: true, ...tokenScopeIds(environmentId, collectionId) },
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

	return {
		cacheKey,
		missingFields,
		incomplete,
		awaiting,
		discoveryElsewhere,
		busy,
		fetching,
		authorizing: signin.authorizing,
		getToken,
		cancelSignIn: signin.cancel,
		clear,
	};
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

/**
 * Stops the sign-in running for this config. It mounts before the token action,
 * which has to stay the rail's last child. The browser tab or window the
 * sign-in opened is the user's to close.
 */
function CancelSignInButton({ actions }: { actions: TokenActions }) {
	return (
		<TooltipIconButton
			size="sm"
			label="Cancel sign-in"
			onClick={actions.cancelSignIn}
			icon={<X className="size-icon-sm" />}
		/>
	);
}

function GetTokenButton({
	actions,
	label,
	renews,
}: {
	actions: TokenActions;
	label: TokenPhase["actionLabel"];
	/** The glyph for a token that is current: renew, not fetch. */
	renews: boolean;
}) {
	return (
		<Button
			size="sm"
			variant="outline"
			onClick={actions.getToken}
			disabled={actions.busy || actions.incomplete || actions.discoveryElsewhere}
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
function DeferredTokenRow({ names, ...row }: RowProps & { names: readonly string[] }) {
	const actions = useTokenActions(row);
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
					{actions.authorizing && <CancelSignInButton actions={actions} />}
					<GetTokenButton actions={actions} label="Get token" renews={false} />
				</>
			}
			below={
				actions.incomplete ? (
					<RowNote>{missingFieldsText(actions.missingFields)}</RowNote>
				) : (
					actions.discoveryElsewhere && <RowNote>{DISCOVER_ELSEWHERE_TEXT}</RowNote>
				)
			}
		/>
	);
}

const missingFieldsText = (missingFields: string[]) =>
	`Enter the ${fieldListPhrase(missingFields)} to fetch a token`;

const AWAITING_DISCOVERY_TEXT = "Not signed in - Get token discovers the server's endpoints";

const DISCOVER_ELSEWHERE_TEXT =
	"Get a token from the Auth tab first - it discovers the server's endpoints";

function RowNote({ children }: { children: ReactNode }) {
	return (
		<div className="border-t border-border px-3 py-2">
			<p className="text-xs text-muted-foreground">{children}</p>
		</div>
	);
}

function NoTokenSummary({ state, actions }: { state: NoTokenState; actions: TokenActions }) {
	switch (state) {
		case "missing-fields":
			return (
				<span className="text-xs text-muted-foreground">
					{missingFieldsText(actions.missingFields)}
				</span>
			);
		case "awaiting-discovery":
			return (
				<span className="text-xs text-muted-foreground">
					{actions.discoveryElsewhere ? DISCOVER_ELSEWHERE_TEXT : AWAITING_DISCOVERY_TEXT}
				</span>
			);
		case "checking":
			return (
				<span className="text-xs text-muted-foreground">Checking for a cached token…</span>
			);
		case "check-failed":
			return (
				<span className="text-xs text-status-error-text">
					Couldn't check for a cached token
				</span>
			);
		case "none-cached":
			return <span className="text-xs text-muted-foreground">No token cached</span>;
	}
}

function CachedTokenRow(row: RowProps) {
	const actions = useTokenActions(row);
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
	// The flip at `expiresAt` is the clock's, not a refetch's: the engine's flag
	// only catches up with it on the next poll.
	const now = useNow(lapseInstant(status));
	const phase = tokenPhase(status, now);
	const noToken = noTokenState(incomplete, statusQuery, actions.awaiting);

	return (
		<TokenRowShell
			dotClass={!token && noToken === "check-failed" ? "bg-status-error" : phase.dotClass}
			summary={
				token && phase.expiry ? (
					<span className="text-xs text-muted-foreground">
						<code className="text-foreground">{maskToken(token.accessToken)}</code>
						{" · "}
						<TokenExpiry expiry={phase.expiry} />
					</span>
				) : (
					<NoTokenSummary state={noToken} actions={actions} />
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
					{actions.authorizing && <CancelSignInButton actions={actions} />}
					<GetTokenButton
						actions={actions}
						label={phase.actionLabel}
						renews={phase.renews}
					/>
				</>
			}
			below={
				<>
					{/* A cached token survives edits that break the config - the cache key
					    omits the Authorization URL and the scope, so clearing either keeps the
					    token on screen while the missing field disables the action. The summary slot is taken by the token, so the reason goes
					    below rather than nowhere. */}
					{incomplete && token && <RowNote>{missingFieldsText(missingFields)}</RowNote>}

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
