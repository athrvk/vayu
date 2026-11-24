/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * OAuth2Form - shared editor for an {@link OAuth2Config}. Rendered by the
 * request builder's Auth tab and (via an injected TextInput) the collection
 * auth editor. Non-interactive grants (client credentials, password, JWT
 * bearer) post straight to the token endpoint; the Authorization Code grant runs
 * the interactive flow (engine-hosted loopback + PKCE) from the same action.
 */

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
	Input,
	SecretInput,
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui";
import { DISCOVERED_FIELD_LABELS, OAUTH2_FIELD_LABELS } from "@/constants/oauth2-fields";
import { withDiscoveredValues } from "@/services/oauth/discovery";
import type { OAuth2Config, OAuth2DiscoveredField, OAuth2GrantType, OAuth2ParamRow } from "@/types";
import { LabelledField, type LabelledControlProps } from "../LabelledField";
import DiscoveryFields from "./DiscoveryFields";
import JwtBearerFields from "./JwtBearerFields";
import ParamRowsEditor from "./ParamRowsEditor";
import { resolveOAuth2Config } from "./resolve-config";
import SecondsInput from "./SecondsInput";
import TokenStatusRow from "./TokenStatusRow";
import type { OAuth2FormProps, OAuth2TextInput } from "./types";

/** What the engine holds `fallbackExpiresIn` to (`MAX_FALLBACK_EXPIRES_IN_SECONDS`): one year. */
const MAX_FALLBACK_EXPIRES_IN_SECONDS = 365 * 24 * 3600;

/** A blank discoverable member's placeholder while discovery is on. */
const DISCOVERY_PLACEHOLDERS: Record<OAuth2DiscoveredField, string> = {
	authorizationUrl: "found at sign-in",
	accessTokenUrl: "found at sign-in",
	clientId: "blank registers a client at sign-in",
	resource: "found at sign-in",
	scope: "found at sign-in",
};

const GRANT_TYPES: { value: OAuth2GrantType; label: string }[] = [
	{ value: "client_credentials", label: "Client credentials" },
	{ value: "password", label: "Password credentials" },
	{ value: "authorization_code", label: "Authorization code (PKCE)" },
	{ value: "jwt_bearer", label: "JWT bearer" },
];

// A plain-input fallback when the host does not inject a variable-aware input.
// Secret fields render a masked input with a reveal toggle.
const PlainTextInput: OAuth2TextInput = ({ id, value, onChange, placeholder, type }) =>
	type === "password" ? (
		<SecretInput id={id} value={value} onChange={onChange} placeholder={placeholder} />
	) : (
		<Input
			id={id}
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
	resolveKey,
	deferredNames,
	collectionId,
	TextInput = PlainTextInput,
	variables,
}: OAuth2FormProps) {
	const [advancedOpen, setAdvancedOpen] = useState(false);

	const set = <K extends keyof OAuth2Config>(key: K, v: OAuth2Config[K]) =>
		onChange({ ...value, [key]: v });

	// An emptied list is removed, not stored as `[]`: a config that sets none
	// stays the config it was.
	const setParams = (
		list: "authorizationParams" | "tokenParams" | "refreshParams",
		rows: OAuth2ParamRow[] | undefined
	) => {
		const { [list]: _previous, ...rest } = value;
		onChange(rows ? { ...rest, [list]: rows } : rest);
	};

	const grant = value.grantType;
	const isAuthCode = grant === "authorization_code";
	const isPassword = grant === "password";
	const isJwtBearer = grant === "jwt_bearer";
	const discovering = isAuthCode && value.discoverUrl !== undefined;
	const discovered = new Set(value.discoveredFields ?? []);

	// The grant has no client secret, so a stored one is dropped with the field:
	// hidden, it would still be sent as client authentication beside the assertion.
	// Discovery is offered for the authorization code grant only, and a stored
	// `discoverUrl` holds every token request of the config to the engine's
	// local-host rule (#3800): hidden under another grant, with no switch to turn
	// it off, it would refuse a typed loopback token endpoint unexplained.
	const selectGrant = (next: OAuth2GrantType) => {
		const { discoverUrl: _url, discoveredFields: _found, ...kept } = value;
		const base = next === "authorization_code" ? value : kept;
		if (next !== "jwt_bearer") return onChange({ ...base, grantType: next });
		const { clientSecret: _secret, ...rest } = base;
		onChange({ ...rest, grantType: next });
	};
	const setFallbackExpiry = (seconds: number | undefined) => {
		const { fallbackExpiresIn: _previous, ...rest } = value;
		onChange(seconds === undefined ? rest : { ...rest, fallbackExpiresIn: seconds });
	};

	// Config with variables resolved, for the token status/actions. Each field
	// keeps its own cache entry (see `resolveOAuth2Config`), so the memo is what
	// holds the object identity still and the cache is what holds the values
	// still across a remount.
	const resolvedConfig = useMemo<OAuth2Config>(
		() => resolveOAuth2Config(value, resolveString, resolveKey),
		[value, resolveString, resolveKey]
	);

	const field = (
		label: string,
		control: (props: LabelledControlProps) => React.ReactNode,
		hint?: string
	) => (
		<LabelledField label={label} hint={hint} className="space-y-1.5">
			{control}
		</LabelledField>
	);

	// A member discovery wrote is the server's answer, shown read-only so it is
	// not mistaken for a typed one; Discover again is how it changes. With
	// discovery on, a blank member says it is found at sign-in, and one typed
	// there wins over what discovery would find.
	const discoverable = (
		key: OAuth2DiscoveredField,
		c: LabelledControlProps,
		placeholder: string
	) =>
		discovered.has(key) ? (
			<Input
				id={c.id}
				readOnly
				value={value[key] ?? ""}
				title={value[key]}
				className="font-mono text-sm"
			/>
		) : (
			<TextInput
				{...c}
				value={value[key] ?? ""}
				onChange={(v) => set(key, v)}
				placeholder={discovering ? DISCOVERY_PLACEHOLDERS[key] : placeholder}
			/>
		);

	return (
		<div className="space-y-4">
			{field(OAUTH2_FIELD_LABELS.grantType, (c) => (
				<Select value={grant} onValueChange={selectGrant}>
					{/* `w-3xs`, not `w-64`: the trigger holds a fixed grant-type
					    label ("Authorization Code"), a text measure, and `w-64`
					    rides `--spacing` - narrower at the Default density than the
					    label it holds. */}
					<SelectTrigger id={c.id} className="w-3xs">
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
			))}

			{isAuthCode && (
				<DiscoveryFields value={value} onChange={onChange} TextInput={TextInput} />
			)}

			{isAuthCode &&
				field(OAUTH2_FIELD_LABELS.authorizationUrl, (c) =>
					discoverable("authorizationUrl", c, "https://idp.example.com/authorize")
				)}

			{field(OAUTH2_FIELD_LABELS.accessTokenUrl, (c) =>
				discoverable("accessTokenUrl", c, "https://idp.example.com/token")
			)}

			{isAuthCode &&
				field(
					OAUTH2_FIELD_LABELS.callbackUrl,
					(c) => (
						<TextInput
							{...c}
							value={value.callbackUrl ?? ""}
							onChange={(v) => set("callbackUrl", v)}
							placeholder="auto - 127.0.0.1 loopback"
						/>
					),
					"Leave blank to use an automatic loopback redirect."
				)}

			<div className="grid grid-cols-2 gap-4">
				{field(
					OAUTH2_FIELD_LABELS.clientId,
					(c) => discoverable("clientId", c, "client id or {{var}}"),
					isJwtBearer ? "The assertion's iss claim." : undefined
				)}
				{!isJwtBearer &&
					field("Client secret", (c) => (
						<TextInput
							{...c}
							value={value.clientSecret ?? ""}
							onChange={(v) => set("clientSecret", v)}
							placeholder="client secret or {{var}}"
							type="password"
						/>
					))}
			</div>

			{isJwtBearer && (
				<JwtBearerFields
					value={value}
					onChange={onChange}
					TextInput={TextInput}
					variables={variables}
				/>
			)}

			{isPassword && (
				<div className="grid grid-cols-2 gap-4">
					{field("Username", (c) => (
						<TextInput
							{...c}
							value={value.username ?? ""}
							onChange={(v) => set("username", v)}
							placeholder="username or {{var}}"
						/>
					))}
					{field("Password", (c) => (
						<TextInput
							{...c}
							value={value.password ?? ""}
							onChange={(v) => set("password", v)}
							placeholder="password or {{var}}"
							type="password"
						/>
					))}
				</div>
			)}

			{field(DISCOVERED_FIELD_LABELS.scope, (c) =>
				discoverable("scope", c, "openid profile email")
			)}

			{isAuthCode &&
				field("PKCE", (c) => (
					<div className="flex items-center gap-2">
						<Switch
							id={c.id}
							checked={value.pkce ?? true}
							onCheckedChange={(c) => set("pkce", c)}
						/>
						<span className="text-xs text-muted-foreground">
							Use PKCE (S256) - recommended
						</span>
					</div>
				))}

			<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
				<CollapsibleTrigger className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
					<ChevronDown
						className={`size-icon-sm transition-transform ${advancedOpen ? "" : "-rotate-90"}`}
					/>
					Advanced
				</CollapsibleTrigger>
				<CollapsibleContent className="pt-4 px-1 pb-1 space-y-4">
					<div className="grid grid-cols-2 gap-4">
						{!isJwtBearer &&
							field("Client authentication", (c) => (
								<Select
									value={value.credentialsPlacement ?? "basic_auth_header"}
									onValueChange={(v: "basic_auth_header" | "body") =>
										set("credentialsPlacement", v)
									}
								>
									<SelectTrigger id={c.id}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="basic_auth_header">
											Send as Basic auth header
										</SelectItem>
										<SelectItem value="body">Send in body</SelectItem>
									</SelectContent>
								</Select>
							))}
						{field("Token placement", (c) => (
							<Select
								value={value.tokenPlacement ?? "header"}
								onValueChange={(v: "header" | "query") => set("tokenPlacement", v)}
							>
								<SelectTrigger id={c.id}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="header">Request header</SelectItem>
									<SelectItem value="query">Query param</SelectItem>
								</SelectContent>
							</Select>
						))}
					</div>

					<div className="grid grid-cols-2 gap-4">
						{value.tokenPlacement === "query"
							? field("Query param name", (c) => (
									<TextInput
										{...c}
										value={value.queryParamName ?? ""}
										onChange={(v) => set("queryParamName", v)}
										placeholder="access_token"
									/>
								))
							: field("Header prefix", (c) => (
									<TextInput
										{...c}
										value={value.headerPrefix ?? ""}
										onChange={(v) => set("headerPrefix", v)}
										placeholder="Bearer"
									/>
								))}
						{field(
							"Credentials ID",
							(c) => (
								<TextInput
									{...c}
									value={value.credentialsId ?? ""}
									onChange={(v) => set("credentialsId", v)}
									placeholder="default"
								/>
							),
							"Separate token cache entries for the same URL/client."
						)}
					</div>

					<div className="grid grid-cols-2 gap-4">
						{field("Audience", (c) => (
							<TextInput
								{...c}
								value={value.audience ?? ""}
								onChange={(v) => set("audience", v)}
								placeholder="optional"
							/>
						))}
						{field(DISCOVERED_FIELD_LABELS.resource, (c) =>
							discoverable("resource", c, "optional")
						)}
					</div>

					{field("Refresh token URL", (c) => (
						<TextInput
							{...c}
							value={value.refreshTokenUrl ?? ""}
							onChange={(v) => set("refreshTokenUrl", v)}
							placeholder="defaults to the token URL"
						/>
					))}

					{isAuthCode && (
						<ParamRowsEditor
							label="Authorization request parameters"
							hint="Added to the sign-in URL's query, such as prompt or acr_values."
							rows={value.authorizationParams}
							onChange={(rows) => setParams("authorizationParams", rows)}
							variables={variables}
						/>
					)}

					<ParamRowsEditor
						label="Token request parameters"
						hint="Sent with each new token request, such as an Auth0 audience. Choose whether a row goes in the body, the URL or a header. Different values keep separate cached tokens."
						rows={value.tokenParams}
						onChange={(rows) => setParams("tokenParams", rows)}
						variables={variables}
						sendAs
					/>

					<ParamRowsEditor
						label="Refresh request parameters"
						hint="Sent when a token is refreshed."
						rows={value.refreshParams}
						onChange={(rows) => setParams("refreshParams", rows)}
						variables={variables}
						sendAs
					/>

					{field(
						"Token lifetime if none is stated (seconds)",
						(c) => (
							<SecondsInput
								id={c.id}
								value={value.fallbackExpiresIn}
								onChange={setFallbackExpiry}
								placeholder="never expires"
								min={1}
								max={MAX_FALLBACK_EXPIRES_IN_SECONDS}
							/>
						),
						"How long to keep a token whose response has no expires_in, up to a year (31536000). Empty keeps it until it is replaced."
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
				<TokenStatusRow
					resolvedConfig={resolvedConfig}
					deferredNames={deferredNames}
					collectionId={collectionId}
					onDiscovered={(found) => onChange(withDiscoveredValues(value, found))}
				/>
			</div>
		</div>
	);
}
