/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Refusing a blank name, in one voice.
 *
 * Both Info tabs autosave, so neither has a disabled Save button left to
 * express "this cannot be saved". The refusal has to be spoken instead, and by
 * both of them the same way - two surfaces enforcing one rule in two different
 * wordings is how a rule stops reading as a rule.
 *
 * A toast and nothing else. The caller puts the stored name back, so the
 * refusal leaves no unsaved edit for the Dock to call "Not saved" (see
 * `stores/save-store`), and a client-side refusal is not a mutation failure,
 * so `SaveFailed` - which renders a *rejected* mutation - never sees it.
 *
 * Restoring the stored value is the caller's, because only the caller knows
 * where its draft lives.
 */

import { useToastStore } from "@/stores/toast-store";

/**
 * Report that a blank name was refused and the stored one put back.
 *
 * @param what - the thing being named, lower case: "request", "collection".
 */
export function reportBlankNameRefused(what: string): void {
	useToastStore.getState().showToast(`A ${what} needs a name - kept the saved one.`, "error");
}
