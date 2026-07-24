/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Auth modes a request or collection can *store* but neither editor can edit -
 * the single source of truth for their display names.
 *
 * The engine has no resolution for digest/aws/ntlm, so offering them in a
 * picker would let someone configure something that silently does nothing. But
 * they still arrive: the Insomnia importer produces `digest`/`aws`/`ntlm` on
 * requests and the Postman importer preserves them, so both editors have to
 * *surface* them (name the stored mode, warn that it is still what runs) rather
 * than narrow them to "none" and quietly rewrite them on save.
 *
 * Both hosts named these independently before this existed - the collection
 * `AuthTab` and the request `AuthPanel`. One list, one set of words.
 */

import type { AuthMode } from "@/types";

/** The modes stored-but-not-editable in either auth editor. */
export type UneditableAuthMode = "digest" | "aws" | "ntlm";

/** Display names for the stored-but-not-editable modes. */
export const UNEDITABLE_AUTH_LABELS: Record<UneditableAuthMode, string> = {
	digest: "Digest",
	aws: "AWS Signature",
	ntlm: "NTLM",
};

/** Narrowing guard: is this mode one an editor stores but cannot edit? */
export function isUneditableAuthMode(mode: AuthMode | string): mode is UneditableAuthMode {
	return mode === "digest" || mode === "aws" || mode === "ntlm";
}
