/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The OAuth 2.0 config fields the **engine names in error prose**, and the label
 * each one carries on screen.
 *
 * The engine's messages are written against the JSON contract, which is right
 * for an API - `accessTokenUrl must be an http(s) URL` is exactly what an MCP
 * client or a curl user needs. It is the wrong string to put in front of someone
 * looking at a form field labelled **Access Token URL**, and those messages reach
 * three toasts unaltered: the token action in `TokenStatusRow`, and the
 * `AUTH_FAILED` path in the request builder and `DesignRunView`. So the renderer
 * relabels on the way out, in one place, rather than each toast site paraphrasing.
 *
 * Only the five fields that actually appear in an engine message are listed.
 * `OAuth2Form` has ~18 fields; registering the other thirteen would add a dozen
 * entries no code path ever reads, which is this codebase's most repeated defect.
 * Each key here has two real readers - the form's own field label and
 * {@link humanizeOAuth2Error} - and three of them also name a missing field in
 * the token status row.
 */

/**
 * Label for each config field the engine can name. Source of truth: `OAuth2Form`
 * renders these, so an error and the field it points at cannot drift apart.
 */
export const OAUTH2_FIELD_LABELS = {
	grantType: "Grant Type",
	authorizationUrl: "Authorization URL",
	accessTokenUrl: "Access Token URL",
	callbackUrl: "Callback URL",
	clientId: "Client ID",
} as const;

export type OAuth2LabelledField = keyof typeof OAUTH2_FIELD_LABELS;

// Whole words only, so `clientIdentifier` in a provider's own message survives.
const FIELD_PATTERN = new RegExp(`\\b(${Object.keys(OAUTH2_FIELD_LABELS).join("|")})\\b`, "g");

/**
 * Rewrite the JSON field names in an engine (or provider) OAuth 2.0 error into
 * the labels the user sees. Anything unrecognised passes through untouched, so a
 * provider's own `invalid_client` prose still reads as the provider's.
 */
export function humanizeOAuth2Error(message: string): string {
	return message.replace(
		FIELD_PATTERN,
		(field) => OAUTH2_FIELD_LABELS[field as OAuth2LabelledField]
	);
}
