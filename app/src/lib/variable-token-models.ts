/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which models hold text this app interpolates `{{variables}}` in.
 *
 * A Monaco hover provider is registered per *language*, once, for the whole
 * app - there is no per-editor hover the way there is a per-editor decoration.
 * So the `json` provider that answers for a request body is the same object
 * Monaco asks about a **response** body, which is also `json`: without this
 * register, hovering `{{userId}}` inside a webhook payload someone was *sent*
 * would offer to define it, and the response viewer would be the one surface
 * this feature is supposed to leave alone (issue #1220).
 *
 * `readOnly` cannot answer the question: it is an editor option, and the
 * provider is handed a model. So the editors that paint tokens mark their own
 * model here, and the hover answers for a marked model and no other.
 *
 * A `WeakSet` because a model outlives nothing: when Monaco disposes one, the
 * entry goes with it whether or not anybody remembered to unmark it.
 */

import type * as Monaco from "monaco-editor";

const painted = new WeakSet<Monaco.editor.ITextModel>();

/** This model's `{{tokens}}` are painted, so its hover may answer for them. */
export function markVariableTokenModel(model: Monaco.editor.ITextModel): void {
	painted.add(model);
}

/** The editor stopped painting this model - a mode switch, or an unmount. */
export function forgetVariableTokenModel(model: Monaco.editor.ITextModel): void {
	painted.delete(model);
}

export function isVariableTokenModel(model: Monaco.editor.ITextModel): boolean {
	return painted.has(model);
}
