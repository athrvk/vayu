/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * AuthPanel - the request's auth source.
 *
 * The picker and the surrounding banners are this host's business; the fields
 * themselves are the shared `AuthFields`, the same component the collection
 * `AuthTab` renders. Only two things here are request-specific: `inherit` is
 * offered (a collection is always a source, never an inheritor), and the
 * injected text input is variable-aware.
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
import { AuthFields, Callout, type AuthTextInput } from "@/components/shared";
import { defaultOAuth2Config } from "@/services/oauth/defaults";
import { AUTH_MODE_LABELS, EDITABLE_AUTH_MODES, uneditableAuthLabel } from "@/constants/auth-modes";
import type { RequestAuth } from "@/types";
import { useRequestBuilderContext } from "../../../context";
import VariableInput from "../../../shared/VariableInput";
import AuthInheritBanner from "./AuthInheritBanner";

/** `inherit` first - a request, unlike a collection, may defer to its parent. */
const PICKER_MODES = ["inherit", ...EDITABLE_AUTH_MODES] as const;

type PickerMode = (typeof PICKER_MODES)[number];

/** The one request-specific extra: an icon per mode, layered on the registry. */
const AUTH_MODE_ICONS: Record<PickerMode, typeof Key> = {
	inherit: Lock,
	none: Lock,
	bearer: Key,
	basic: User,
	apikey: KeyRound,
	oauth2: ShieldCheck,
};

// Variable-aware text input for the auth fields (so {{variables}} work in every
// field). Secret fields (client secret / password) instead use the masked
// SecretInput with a reveal toggle - masking and {{variable}} token highlighting
// can't coexist, and hiding the secret at rest wins for those fields.
const VariableTextInput: AuthTextInput = ({ value, onChange, placeholder, type }) =>
	type === "password" ? (
		<SecretInput value={value} onChange={onChange} placeholder={placeholder} />
	) : (
		<VariableInput value={value} onChange={onChange} placeholder={placeholder} />
	);

/** Empty config for a freshly picked mode. */
function defaultsFor(mode: PickerMode): RequestAuth {
	switch (mode) {
		case "inherit":
			return { mode: "inherit" } as const;
		case "none":
			return { mode: "none" } as const;
		case "bearer":
			return { mode: "bearer", token: "" } as const;
		case "basic":
			return { mode: "basic", username: "", password: "" } as const;
		case "apikey":
			return { mode: "apikey", key: "", value: "", in: "header" } as const;
		case "oauth2":
			return { mode: "oauth2", config: defaultOAuth2Config() } as const;
	}
}

export default function AuthPanel() {
	const { request, updateField, resolveString } = useRequestBuilderContext();
	const auth = request.auth;

	const handleModeChange = (mode: string) => {
		updateField("auth", defaultsFor(mode as PickerMode));
	};

	// digest/aws/ntlm are stored but not editable here (the engine can't resolve
	// them). Name the real mode and warn instead of showing the "No Auth" empty
	// state, which is what the picker would fall back to - the same treatment the
	// collection AuthTab gives them. Selecting any type below replaces it.
	const uneditableLabel = uneditableAuthLabel(auth.mode);

	return (
		<div className="space-y-6">
			{/* Auth Type Selector */}
			<div className="space-y-2">
				<Label>Authentication Type</Label>
				<Select value={uneditableLabel ? "" : auth.mode} onValueChange={handleModeChange}>
					<SelectTrigger className="w-auto">
						<SelectValue
							placeholder={
								uneditableLabel
									? `${uneditableLabel} (not editable here)`
									: undefined
							}
						/>
					</SelectTrigger>
					<SelectContent>
						{PICKER_MODES.map((mode) => {
							const Icon = AUTH_MODE_ICONS[mode];
							return (
								<SelectItem key={mode} value={mode}>
									<div className="flex items-center gap-2">
										<Icon className="w-4 h-4" />
										<span>{AUTH_MODE_LABELS[mode]}</span>
									</div>
								</SelectItem>
							);
						})}
					</SelectContent>
				</Select>
			</div>

			{/* Inherit resolution */}
			{auth.mode === "inherit" && <AuthInheritBanner collectionId={request.collectionId} />}

			{/* Stored-but-not-editable mode (imported digest/aws/ntlm) */}
			{uneditableLabel && (
				<Callout severity="warning" title={`${uneditableLabel} auth is set`}>
					It was imported and can't be edited here yet - it is still sent with this
					request. Picking a type above replaces it.
				</Callout>
			)}

			{auth.mode !== "inherit" && (
				<AuthFields
					value={auth}
					onChange={(next) => updateField("auth", next)}
					noAuthDescription="No authentication will be sent with this request."
					TextInput={VariableTextInput}
					resolveString={resolveString}
				/>
			)}
		</div>
	);
}
