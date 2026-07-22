/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OAuth2Form - shared editor for an {@link OAuth2Config}. Rendered by the
 * request builder's Auth tab and (via an injected TextInput) the collection
 * auth editor. Non-interactive grants (client credentials, password) fetch
 * tokens directly; the Authorization Code flow is selectable but its token
 * action is gated until the interactive sign-in lands.
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

export default function OAuth2Form({
	value,
	onChange,
	resolveString,
	TextInput = PlainTextInput,
}: OAuth2FormProps) {
	const [advancedOpen, setAdvancedOpen] = useState(false);

	const set = <K extends keyof OAuth2Config>(key: K, v: OAuth2Config[K]) =>
		onChange({ ...value, [key]: v });

	const grant = value.grantType;
	const isAuthCode = grant === "authorization_code";
	const isPassword = grant === "password";

	// Config with variables resolved, for the token status/actions.
	const resolvedConfig = useMemo<OAuth2Config>(() => {
		const r = resolveString ?? ((s: string) => s);
		const rz = (s?: string) => (s ? r(s) : s);
		return {
			...value,
			accessTokenUrl: r(value.accessTokenUrl ?? ""),
			clientId: r(value.clientId ?? ""),
			clientSecret: rz(value.clientSecret),
			username: rz(value.username),
			password: rz(value.password),
			scope: rz(value.scope),
			audience: rz(value.audience),
			resource: rz(value.resource),
			authorizationUrl: rz(value.authorizationUrl),
			refreshTokenUrl: rz(value.refreshTokenUrl),
		};
	}, [value, resolveString]);

	const field = (label: string, node: React.ReactNode, hint?: string) => (
		<div className="space-y-1.5">
			<Label>{label}</Label>
			{node}
			{hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
		</div>
	);

	return (
		<div className="space-y-4">
			{field(
				"Grant Type",
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
					"Authorization URL",
					<TextInput
						value={value.authorizationUrl ?? ""}
						onChange={(v) => set("authorizationUrl", v)}
						placeholder="https://idp.example.com/authorize"
					/>
				)}

			{field(
				"Access Token URL",
				<TextInput
					value={value.accessTokenUrl}
					onChange={(v) => set("accessTokenUrl", v)}
					placeholder="https://idp.example.com/token"
				/>
			)}

			{isAuthCode &&
				field(
					"Callback URL",
					<TextInput
						value={value.callbackUrl ?? ""}
						onChange={(v) => set("callbackUrl", v)}
						placeholder="auto - 127.0.0.1 loopback"
					/>,
					"Leave blank to use an automatic loopback redirect."
				)}

			<div className="grid grid-cols-2 gap-4">
				{field(
					"Client ID",
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
						className={`w-3.5 h-3.5 transition-transform ${advancedOpen ? "" : "-rotate-90"}`}
					/>
					Advanced
				</CollapsibleTrigger>
				<CollapsibleContent className="pt-4 space-y-4">
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
