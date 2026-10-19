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
 * "AWS signature".
 *
 * Per-host extras layer *on top* of this base rather than re-listing it: the
 * panel adds an icon per mode, the collection tab adds an inheritance-worded
 * hint, and only the request side offers `inherit` (a collection is always a
 * source, never an inheritor).
 *
 * digest/aws/ntlm/hawk/oauth1/edgegrid/jwt are stored but never offered: the
 * engine has no resolution for them, so a picker entry would let someone
 * configure something that silently does nothing. They still arrive - the
 * Insomnia importer produces them and the Postman importer preserves them - so
 * both editors must *surface* them (name the stored mode, say plainly that
 * Vayu does not send it and the request goes out without auth) rather than
 * narrow them to "none" and quietly rewrite them on save (#2474).
 */

import type { AuthMode } from "@/types";

/** Display name for every auth mode, editable or not. */
export const AUTH_MODE_LABELS: Record<AuthMode, string> = {
	none: "No auth",
	noauth: "No auth (blocks inheriting)",
	inherit: "Inherit from collection",
	bearer: "Bearer token",
	basic: "Basic auth",
	apikey: "API key",
	oauth2: "OAuth 2.0",
	digest: "Digest",
	aws: "AWS signature",
	ntlm: "NTLM",
	hawk: "Hawk",
	oauth1: "OAuth 1.0",
	edgegrid: "Akamai EdgeGrid",
	jwt: "JWT bearer",
};

/**
 * The modes an editor may offer, in picker order. `inherit` and `noauth` are
 * deliberately absent - each belongs to exactly one host, which adds it: the
 * request panel prepends `inherit`, the collection tab inserts `noauth`
 * ({@link COLLECTION_AUTH_MODES}).
 */
export const EDITABLE_AUTH_MODES = ["none", "bearer", "basic", "apikey", "oauth2"] as const;

/**
 * The collection tab's picker order: `noauth` next to `none`, because the two
 * differ only in what descendants inherit and are read as a pair.
 *
 * `noauth` is collection-only. On a request, `none` already means "send
 * nothing" - a request's own auth is never walked - so offering both there would
 * be two options doing one job. See `RequestAuth` in `types/domain.ts` for the
 * semantics and `resolveAuthSource` for the walk that reads them.
 */
export const COLLECTION_AUTH_MODES = [
	"none",
	"noauth",
	...EDITABLE_AUTH_MODES.slice(1),
] as readonly CollectionAuthMode[];

/** A mode the collection auth tab offers: everything {@link AuthFields} edits, plus `noauth`. */
export type CollectionAuthMode = EditableAuthMode | "noauth";

/** A mode {@link AuthFields} can edit. */
export type EditableAuthMode = (typeof EDITABLE_AUTH_MODES)[number];

/** The modes stored-but-not-editable in either auth editor. */
export type UneditableAuthMode = "digest" | "aws" | "ntlm" | "hawk" | "oauth1" | "edgegrid" | "jwt";

const UNEDITABLE_AUTH_MODES: readonly string[] = [
	"digest",
	"aws",
	"ntlm",
	"hawk",
	"oauth1",
	"edgegrid",
	"jwt",
] satisfies readonly UneditableAuthMode[];

/** Narrowing guard: is this mode one an editor stores but cannot edit? */
export function isUneditableAuthMode(mode: AuthMode | string): mode is UneditableAuthMode {
	return UNEDITABLE_AUTH_MODES.includes(mode);
}

/** Narrowing guard: is this a mode the collection auth tab offers? */
export function isCollectionAuthMode(mode: AuthMode | string): mode is CollectionAuthMode {
	return (COLLECTION_AUTH_MODES as readonly string[]).includes(mode);
}

/**
 * Will the engine put this mode's credentials on the wire? The stored-but-not-
 * editable modes are exactly the ones it has no resolution for, so the request
 * goes out without auth; every other mode (including `none` and `inherit`, which
 * resolve to one of the rest) is applied. A surface that claims "sending X"
 * asks this first rather than trusting that a stored mode is a sent one.
 */
export function isEngineExecutableAuthMode(mode: AuthMode | string): boolean {
	return !isUneditableAuthMode(mode);
}

/**
 * Display name for a stored-but-not-editable mode. Both editors show it in the
 * picker placeholder and in the "… auth is set" warning, so the wording is
 * shared rather than written twice.
 */
export function uneditableAuthLabel(mode: AuthMode | string): string | null {
	return isUneditableAuthMode(mode) ? AUTH_MODE_LABELS[mode] : null;
}
