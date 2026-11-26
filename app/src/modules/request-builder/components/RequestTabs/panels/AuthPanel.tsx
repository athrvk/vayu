/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The request's auth source. The picker and banners are this host's; the fields are the shared
 * `AuthFields`, as the collection `AuthTab` renders. Only two things are request-specific:
 * `inherit` is offered (a collection is always a source), and the text input is variable-aware.
 */

import { Key, Lock, User, KeyRound, ShieldCheck } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	SecretInput,
} from "@/components/ui";
import { AuthFields, Callout, LabelledField, type AuthTextInput } from "@/components/shared";
import { defaultOAuth2Config } from "@/services/oauth/defaults";
import { useOAuth2DeferredNames } from "../../../hooks/useOAuth2DeferredNames";
import { AUTH_MODE_LABELS, EDITABLE_AUTH_MODES, uneditableAuthLabel } from "@/constants/auth-modes";
import type { RequestAuth } from "@/types";
import { useRequestBuilderContext } from "../../../context";
import VariableInput from "@/components/shared/VariableInput";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
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

// Variable-aware text input, so {{variables}} work in every auth field. Secret fields (client
// secret, password) use the masked SecretInput with a reveal toggle instead: masking and token
// highlighting cannot coexist, and hiding a secret at rest wins. Always inside
// `RequestBuilderProvider`, so it reads the scope here rather than threading it through every
// field; `VariableInput` does not know the context (#564).
const VariableTextInput: AuthTextInput = ({ id, label, value, onChange, placeholder, type }) => {
	const variables = useVariableSupport();
	return type === "password" ? (
		<SecretInput id={id} value={value} onChange={onChange} placeholder={placeholder} />
	) : (
		<VariableInput
			id={id}
			aria-label={label}
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			variables={variables}
		/>
	);
};

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
	const variables = useVariableSupport();
	const auth = request.auth;

	const deferredNames = useOAuth2DeferredNames(
		request.id ?? "",
		auth.mode === "oauth2" ? auth.config : null
	);

	const handleModeChange = (mode: string) => {
		updateField("auth", defaultsFor(mode as PickerMode));
	};

	// digest/aws/ntlm are stored but not editable (the engine cannot resolve them): name the real
	// mode and warn, as the collection AuthTab does, instead of the picker's "No Auth" fallback.
	// Picking any type replaces it.
	const uneditableLabel = uneditableAuthLabel(auth.mode);

	return (
		<div className="space-y-6">
			<LabelledField label="Authentication type">
				{(c) => (
					<Select
						value={uneditableLabel ? "" : auth.mode}
						onValueChange={handleModeChange}
					>
						<SelectTrigger id={c.id} className="w-auto">
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
											<Icon className="size-icon" />
											<span>{AUTH_MODE_LABELS[mode]}</span>
										</div>
									</SelectItem>
								);
							})}
						</SelectContent>
					</Select>
				)}
			</LabelledField>

			{auth.mode === "inherit" && <AuthInheritBanner collectionId={request.collectionId} />}

			{/* Stored-but-not-editable mode (imported digest/aws/ntlm) */}
			{uneditableLabel && (
				<Callout severity="warning" title={`${uneditableLabel} auth is set`}>
					It was imported and can't be edited here yet. Vayu does not send this auth type,
					so the request goes out without auth. Picking a type above replaces it.
				</Callout>
			)}

			{auth.mode !== "inherit" && (
				<AuthFields
					value={auth}
					onChange={(next) => updateField("auth", next)}
					noAuthDescription="No authentication will be sent with this request."
					TextInput={VariableTextInput}
					resolveString={resolveString}
					variables={variables}
					deferredNames={deferredNames}
					collectionId={request.collectionId}
					/*
					 * Names the fields whose resolved values must hold across this panel's unmount,
					 * as Auth is not force-mounted (Auth, then Headers, then Auth is a new form). A
					 * request with no id shares one entry, as `ParamsPanel` does: an unsaved draft
					 * has nothing else stable.
					 */
					resolveKey={request.id ?? "new"}
				/>
			)}
		</div>
	);
}
