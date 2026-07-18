/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * AuthPanel Component
 *
 * Authentication configuration:
 * - None
 * - Bearer Token
 * - Basic Auth
 * - API Key
 * - OAuth 2.0 (TODO)
 */

import { Key, Lock, User, KeyRound, ShieldCheck } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Label,
	SecretInput,
} from "@/components/ui";
import { OAuth2Form, type OAuth2TextInput } from "@/components/shared/OAuth2Form";
import { defaultOAuth2Config } from "@/services/oauth/defaults";
import { useRequestBuilderContext } from "../../../context";
import VariableInput from "../../../shared/VariableInput";
import type { AuthType, AuthConfigState } from "../../../types";
import AuthInheritBanner from "./AuthInheritBanner";

const AUTH_TYPES: { value: AuthType; label: string; icon: typeof Key }[] = [
	{ value: "inherit", label: "Inherit from Collection", icon: Lock },
	{ value: "none", label: "No Auth", icon: Lock },
	{ value: "bearer", label: "Bearer Token", icon: Key },
	{ value: "basic", label: "Basic Auth", icon: User },
	{ value: "api-key", label: "API Key", icon: KeyRound },
	{ value: "oauth2", label: "OAuth 2.0", icon: ShieldCheck },
];

// Variable-aware text input for the OAuth 2.0 form (so {{variables}} work in
// every field). Secret fields (client secret / password) instead use the masked
// SecretInput with a reveal toggle — masking and {{variable}} token highlighting
// can't coexist, and hiding the secret at rest wins for those fields.
const VariableTextInput: OAuth2TextInput = ({ value, onChange, placeholder, type }) =>
	type === "password" ? (
		<SecretInput value={value} onChange={onChange} placeholder={placeholder} />
	) : (
		<VariableInput value={value} onChange={onChange} placeholder={placeholder} />
	);

export default function AuthPanel() {
	const { request, updateField, setRequest, resolveString } = useRequestBuilderContext();
	const authType = request.authType;
	const authConfig = request.authConfig;

	const handleTypeChange = (type: AuthType) => {
		// Initialize defaults for each type
		let newConfig: AuthConfigState = {};

		if (type === "bearer") {
			newConfig = { token: authConfig.token || "" };
		} else if (type === "basic") {
			newConfig = {
				username: authConfig.username || "",
				password: authConfig.password || "",
			};
		} else if (type === "api-key") {
			newConfig = {
				key: authConfig.key || "",
				value: authConfig.value || "",
				addTo: authConfig.addTo || "header",
			};
		} else if (type === "oauth2") {
			newConfig = { oauth2: authConfig.oauth2 ?? defaultOAuth2Config() };
		}

		setRequest({ authType: type, authConfig: newConfig });
	};

	const updateConfig = (updates: Partial<AuthConfigState>) => {
		updateField("authConfig", { ...authConfig, ...updates });
	};

	return (
		<div className="space-y-6">
			{/* Auth Type Selector */}
			<div className="space-y-2">
				<Label>Authentication Type</Label>
				<Select value={authType} onValueChange={handleTypeChange}>
					<SelectTrigger className="w-auto">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{AUTH_TYPES.map((type) => {
							const Icon = type.icon;
							return (
								<SelectItem key={type.value} value={type.value}>
									<div className="flex items-center gap-2">
										<Icon className="w-4 h-4" />
										<span>{type.label}</span>
									</div>
								</SelectItem>
							);
						})}
					</SelectContent>
				</Select>
			</div>

			{/* Inherit resolution */}
			{authType === "inherit" && <AuthInheritBanner collectionId={request.collectionId} />}

			{/* Auth Configuration */}
			{authType === "none" && (
				<div className="py-8 text-center text-muted-foreground">
					<Lock className="w-8 h-8 mx-auto mb-2 opacity-50" />
					<p>No authentication will be sent with this request.</p>
				</div>
			)}

			{authType === "bearer" && (
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">
						The token will be sent as{" "}
						<code className="bg-muted px-1 rounded-md">
							Authorization: Bearer &lt;token&gt;
						</code>
					</p>
					<div className="space-y-2">
						<Label>Token</Label>
						<VariableInput
							value={authConfig.token || ""}
							onChange={(token) => updateConfig({ token })}
							placeholder="Enter bearer token or {{variable}}"
						/>
					</div>
				</div>
			)}

			{authType === "basic" && (
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">
						Credentials will be sent as{" "}
						<code className="bg-muted px-1 rounded-md">
							Authorization: Basic &lt;base64&gt;
						</code>
					</p>
					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label>Username</Label>
							<VariableInput
								value={authConfig.username || ""}
								onChange={(username) => updateConfig({ username })}
								placeholder="Username"
							/>
						</div>
						<div className="space-y-2">
							<Label>Password</Label>
							<SecretInput
								value={authConfig.password || ""}
								onChange={(password) => updateConfig({ password })}
								placeholder="Password"
							/>
						</div>
					</div>
				</div>
			)}

			{authType === "api-key" && (
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">
						The API key will be added as a{" "}
						{authConfig.addTo === "header" ? "header" : "query parameter"}.
					</p>

					<div className="space-y-2">
						<Label>Add to</Label>
						<Select
							value={authConfig.addTo || "header"}
							onValueChange={(addTo: "header" | "query") => updateConfig({ addTo })}
						>
							<SelectTrigger className="w-48">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="header">Header</SelectItem>
								<SelectItem value="query">Query Params</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label>Key</Label>
							<VariableInput
								value={authConfig.key || ""}
								onChange={(key) => updateConfig({ key })}
								placeholder="X-API-Key"
							/>
						</div>
						<div className="space-y-2">
							<Label>Value</Label>
							<VariableInput
								value={authConfig.value || ""}
								onChange={(value) => updateConfig({ value })}
								placeholder="{{api_key}}"
							/>
						</div>
					</div>
				</div>
			)}

			{authType === "oauth2" && (
				<OAuth2Form
					value={authConfig.oauth2 ?? defaultOAuth2Config()}
					onChange={(oauth2) => updateConfig({ oauth2 })}
					resolveString={resolveString}
					TextInput={VariableTextInput}
				/>
			)}
		</div>
	);
}
