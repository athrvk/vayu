/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one registry of auth modes: what each is called, and which of them an
 * editor may offer.
 *
 * Every mode is named exactly once here. Four places used to name them
 * independently - the request `AuthPanel` (`AUTH_TYPES`), the collection
 * `AuthTab` (`AUTH_OPTIONS`), `AuthInheritBanner`'s `describeAuth`, and this
 * file's uneditable subset - and they had already drifted: the banner rendered
 * `OAUTH2` / `AWS` in raw uppercase for modes the pickers called "OAuth 2.0" and
 * "AWS Signature".
 *
 * Per-host extras layer *on top* of this base rather than re-listing it: the
 * panel adds an icon per mode, the collection tab adds an inheritance-worded
 * hint, and only the request side offers `inherit` (a collection is always a
 * source, never an inheritor).
 *
 * digest/aws/ntlm are stored but never offered: the engine has no resolution for
 * them, so a picker entry would let someone configure something that silently
 * does nothing. They still arrive - the Insomnia importer produces them and the
 * Postman importer preserves them - so both editors must *surface* them (name
 * the stored mode, warn that it is still what runs) rather than narrow them to
 * "none" and quietly rewrite them on save.
 */

import type { AuthMode } from "@/types";

/** Display name for every auth mode, editable or not. */
export const AUTH_MODE_LABELS: Record<AuthMode, string> = {
	none: "No Auth",
	inherit: "Inherit from Collection",
	bearer: "Bearer Token",
	basic: "Basic Auth",
	apikey: "API Key",
	oauth2: "OAuth 2.0",
	digest: "Digest",
	aws: "AWS Signature",
	ntlm: "NTLM",
};

/**
 * The modes an editor may offer, in picker order. `inherit` is deliberately
 * absent - it is request-only, and the request panel prepends it.
 */
export const EDITABLE_AUTH_MODES = ["none", "bearer", "basic", "apikey", "oauth2"] as const;

/** A mode {@link AuthFields} can edit. */
export type EditableAuthMode = (typeof EDITABLE_AUTH_MODES)[number];

/** The modes stored-but-not-editable in either auth editor. */
export type UneditableAuthMode = "digest" | "aws" | "ntlm";

/** Narrowing guard: is this mode one an editor stores but cannot edit? */
export function isUneditableAuthMode(mode: AuthMode | string): mode is UneditableAuthMode {
	return mode === "digest" || mode === "aws" || mode === "ntlm";
}

/** Narrowing guard: is this a mode the shared field editor can render? */
export function isEditableAuthMode(mode: AuthMode | string): mode is EditableAuthMode {
	return (EDITABLE_AUTH_MODES as readonly string[]).includes(mode);
}

/**
 * Display name for a stored-but-not-editable mode. Both editors show it in the
 * picker placeholder and in the "… auth is set" warning, so the wording is
 * shared rather than written twice.
 */
export function uneditableAuthLabel(mode: AuthMode | string): string | null {
	return isUneditableAuthMode(mode) ? AUTH_MODE_LABELS[mode] : null;
}
