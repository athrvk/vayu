/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OAuth2Form - shared editor for an {@link OAuth2Config}. Rendered by the
 * request builder's Auth tab and (via an injected TextInput) the collection
 * auth editor. Non-interactive grants (client credentials, password) post
 * straight to the token endpoint; the Authorization Code grant runs the
 * interactive flow (engine-hosted loopback + PKCE) from the same action.
 */

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Label,
	Switch,
	Input,
	SecretInput,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui";
import { OAUTH2_FIELD_LABELS } from "@/constants/oauth2-fields";
import { createStableResolve } from "@/lib/dynamic-variable-cache";
import type { OAuth2Config, OAuth2GrantType } from "@/types";
import TokenStatusRow from "./TokenStatusRow";
import type { OAuth2FormProps, OAuth2TextInput } from "./types";

const GRANT_TYPES: { value: OAuth2GrantType; label: string }[] = [
	{ value: "client_credentials", label: "Client Credentials" },
	{ value: "password", label: "Password Credentials" },
	{ value: "authorization_code", label: "Authorization Code (PKCE)" },
];

// A plain-input fallback when the host does not inject a variable-aware input.
// Secret fields render a masked input with a reveal toggle.
const PlainTextInput: OAuth2TextInput = ({ value, onChange, placeholder, type }) =>
	type === "password" ? (
		<SecretInput value={value} onChange={onChange} placeholder={placeholder} />
	) : (
		<Input
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			type="text"
			className="font-mono text-sm"
		/>
	);

/*
 * One entry per config *field* - `<resolveKey>:clientId` and its siblings -
 * cached across this form's own unmount.
 *
 * `resolvedConfig` below is not only a display: `TokenStatusRow` derives the
 * token cache key from it (`computeOAuth2CacheKey`) and queries on that string,
 * and the same object is what a Get Token actually posts. A `{{$guid}}` in the
 * access-token URL or the client id therefore did more than flicker - the
 * builder's Auth tab is not force-mounted (`RequestTabs/index.tsx`), so a look
 * at Headers and back rebuilt this form, resolved fresh, and pointed the status
 * row at a cache key nothing had ever fetched: a token that was on screen a
 * moment ago reading as "No token cached", with nothing edited. The memo alone
 * could not answer that, because it dies with the component.
 *
 * `resolveString` comes from the request builder's provider at the one host
 * that passes it, so it outlives this form and the entry is still valid on the
 * way back in. With no `resolveKey` the cache is bypassed entirely, which is
 * the collection auth editor's case: it passes no resolver either, so every
 * field is already its own literal text.
 */
const stableConfigField = createStableResolve();

export default function OAuth2Form({
	value,
	onChange,
	resolveString,
	resolveKey,
	TextInput = PlainTextInput,
}: OAuth2FormProps) {
	const [advancedOpen, setAdvancedOpen] = useState(false);

	const set = <K extends keyof OAuth2Config>(key: K, v: OAuth2Config[K]) =>
		onChange({ ...value, [key]: v });

	const grant = value.grantType;
	const isAuthCode = grant === "authorization_code";
	const isPassword = grant === "password";

	// Config with variables resolved, for the token status/actions. Each field
	// keeps its own cache entry (see `stableConfigField` above), so the memo is
	// what holds the object identity still and the cache is what holds the
	// values still across a remount.
	const resolvedConfig = useMemo<OAuth2Config>(() => {
		const resolve = resolveString ?? ((s: string) => s);
		const r = (field: string, s: string) =>
			resolveKey ? stableConfigField(`${resolveKey}:${field}`, s, resolve) : resolve(s);
		// An absent optional field stays absent: resolving it would turn every
		// `undefined` into `""`, and the cache key tells those two apart.
		const rz = (field: string, s?: string) => (s ? r(field, s) : s);
		return {
			...value,
			accessTokenUrl: r("accessTokenUrl", value.accessTokenUrl ?? ""),
			clientId: r("clientId", value.clientId ?? ""),
			clientSecret: rz("clientSecret", value.clientSecret),
			username: rz("username", value.username),
			password: rz("password", value.password),
			scope: rz("scope", value.scope),
			audience: rz("audience", value.audience),
			resource: rz("resource", value.resource),
			authorizationUrl: rz("authorizationUrl", value.authorizationUrl),
			refreshTokenUrl: rz("refreshTokenUrl", value.refreshTokenUrl),
		};
	}, [value, resolveString, resolveKey]);

	const field = (label: string, node: React.ReactNode, hint?: string) => (
		<div className="space-y-1.5">
			<Label>{label}</Label>
			{node}
			{hint && <p className="text-label text-muted-foreground">{hint}</p>}
		</div>
	);

	return (
		<div className="space-y-4">
			{field(
				OAUTH2_FIELD_LABELS.grantType,
				<Select value={grant} onValueChange={(g: OAuth2GrantType) => set("grantType", g)}>
					<SelectTrigger className="w-64">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{GRANT_TYPES.map((g) => (
							<SelectItem key={g.value} value={g.value}>
								{g.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}

			{isAuthCode &&
				field(
					OAUTH2_FIELD_LABELS.authorizationUrl,
					<TextInput
						value={value.authorizationUrl ?? ""}
						onChange={(v) => set("authorizationUrl", v)}
						placeholder="https://idp.example.com/authorize"
					/>
				)}

			{field(
				OAUTH2_FIELD_LABELS.accessTokenUrl,
				<TextInput
					value={value.accessTokenUrl}
					onChange={(v) => set("accessTokenUrl", v)}
					placeholder="https://idp.example.com/token"
				/>
			)}

			{isAuthCode &&
				field(
					OAUTH2_FIELD_LABELS.callbackUrl,
					<TextInput
						value={value.callbackUrl ?? ""}
						onChange={(v) => set("callbackUrl", v)}
						placeholder="auto - 127.0.0.1 loopback"
					/>,
					"Leave blank to use an automatic loopback redirect."
				)}

			<div className="grid grid-cols-2 gap-4">
				{field(
					OAUTH2_FIELD_LABELS.clientId,
					<TextInput
						value={value.clientId}
						onChange={(v) => set("clientId", v)}
						placeholder="client id or {{var}}"
					/>
				)}
				{field(
					"Client Secret",
					<TextInput
						value={value.clientSecret ?? ""}
						onChange={(v) => set("clientSecret", v)}
						placeholder="client secret or {{var}}"
						type="password"
					/>
				)}
			</div>

			{isPassword && (
				<div className="grid grid-cols-2 gap-4">
					{field(
						"Username",
						<TextInput
							value={value.username ?? ""}
							onChange={(v) => set("username", v)}
							placeholder="username or {{var}}"
						/>
					)}
					{field(
						"Password",
						<TextInput
							value={value.password ?? ""}
							onChange={(v) => set("password", v)}
							placeholder="password or {{var}}"
							type="password"
						/>
					)}
				</div>
			)}

			{field(
				"Scope",
				<TextInput
					value={value.scope ?? ""}
					onChange={(v) => set("scope", v)}
					placeholder="space-separated scopes"
				/>
			)}

			{isAuthCode &&
				field(
					"PKCE",
					<div className="flex items-center gap-2">
						<Switch
							checked={value.pkce ?? true}
							onCheckedChange={(c) => set("pkce", c)}
						/>
						<span className="text-xs text-muted-foreground">
							Use PKCE (S256) - recommended
						</span>
					</div>
				)}

			<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
				<CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
					<ChevronDown
						className={`size-icon-sm transition-transform ${advancedOpen ? "" : "-rotate-90"}`}
					/>
					Advanced
				</CollapsibleTrigger>
				<CollapsibleContent className="pt-4 px-1 pb-1 space-y-4">
					<div className="grid grid-cols-2 gap-4">
						{field(
							"Client Authentication",
							<Select
								value={value.credentialsPlacement ?? "basic_auth_header"}
								onValueChange={(v: "basic_auth_header" | "body") =>
									set("credentialsPlacement", v)
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="basic_auth_header">
										Send as Basic Auth header
									</SelectItem>
									<SelectItem value="body">Send in body</SelectItem>
								</SelectContent>
							</Select>
						)}
						{field(
							"Token Placement",
							<Select
								value={value.tokenPlacement ?? "header"}
								onValueChange={(v: "header" | "query") => set("tokenPlacement", v)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="header">Request header</SelectItem>
									<SelectItem value="query">Query param</SelectItem>
								</SelectContent>
							</Select>
						)}
					</div>

					<div className="grid grid-cols-2 gap-4">
						{value.tokenPlacement === "query"
							? field(
									"Query Param Name",
									<TextInput
										value={value.queryParamName ?? ""}
										onChange={(v) => set("queryParamName", v)}
										placeholder="access_token"
									/>
								)
							: field(
									"Header Prefix",
									<TextInput
										value={value.headerPrefix ?? ""}
										onChange={(v) => set("headerPrefix", v)}
										placeholder="Bearer"
									/>
								)}
						{field(
							"Credentials ID",
							<TextInput
								value={value.credentialsId ?? ""}
								onChange={(v) => set("credentialsId", v)}
								placeholder="default"
							/>,
							"Separate token cache entries for the same URL/client."
						)}
					</div>

					<div className="grid grid-cols-2 gap-4">
						{field(
							"Audience",
							<TextInput
								value={value.audience ?? ""}
								onChange={(v) => set("audience", v)}
								placeholder="optional"
							/>
						)}
						{field(
							"Resource",
							<TextInput
								value={value.resource ?? ""}
								onChange={(v) => set("resource", v)}
								placeholder="optional"
							/>
						)}
					</div>

					{field(
						"Refresh Token URL",
						<TextInput
							value={value.refreshTokenUrl ?? ""}
							onChange={(v) => set("refreshTokenUrl", v)}
							placeholder="defaults to the token URL"
						/>
					)}

					<div className="flex items-center gap-6">
						<label className="flex items-center gap-2 text-xs text-muted-foreground">
							<Switch
								checked={value.autoFetchToken ?? true}
								onCheckedChange={(c) => set("autoFetchToken", c)}
							/>
							Auto-fetch token
						</label>
						<label className="flex items-center gap-2 text-xs text-muted-foreground">
							<Switch
								checked={value.autoRefreshToken ?? true}
								onCheckedChange={(c) => set("autoRefreshToken", c)}
							/>
							Auto-refresh token
						</label>
					</div>
				</CollapsibleContent>
			</Collapsible>

			<div className="pt-1">
				<TokenStatusRow resolvedConfig={resolvedConfig} />
			</div>
		</div>
	);
}
