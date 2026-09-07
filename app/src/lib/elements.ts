/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Small, context-free reads over an `ElementDef[]` list (issue #1512),
 * shared by the request-builder module, the collections module and the
 * generic reference scanners in `lib/` - none of which may depend on each
 * other, so this lives in `lib/` rather than under any one of them.
 */

import type { ElementDef } from "@/types";
import { generateId } from "@/lib/id";

/**
 * The joined text of every enabled element of one script kind (`script.pre`
 * or `script.post`) in a list - what the load path's `tests`/pre-request
 * warning, and the variable-reference scanners, need: one flat string per
 * entity rather than the element list itself.
 *
 * Joined with the engine's own separator (`"\n\n"`, `read_post_request_script`
 * / `compose_script_parts`) so a caller feeding this into `scriptParts()`
 * reproduces the single string a `script.post` column used to hold - the
 * common case is exactly one such element, and this degrades sensibly for
 * more than one rather than silently dropping every part past the first.
 */
export function scriptTextFor(
	elements: ElementDef[],
	kind: "script.pre" | "script.post"
): string | undefined {
	const scripts = elements
		.filter((el) => el.kind === kind && el.enabled)
		.map((el) => el.config.script)
		.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
	return scripts.length > 0 ? scripts.join("\n\n") : undefined;
}

/**
 * The `script.pre`/`script.post` pair every new request and collection is
 * created with, empty and enabled. The two script tabs this feature replaced
 * were always present, running only once given a non-blank body; a fresh
 * `elements: []` loses that visible slot; a fresh user has to know the
 * "Add element" menu exists before they can find where a pre-request or test
 * script goes. An empty `config.script` still passes the kind's own schema -
 * it requires the property present, not non-empty - and `scriptTextFor`
 * already treats a blank script as absent everywhere it's read.
 */
export function defaultScriptElements(): ElementDef[] {
	return [
		{ id: `el_${generateId()}`, kind: "script.pre", enabled: true, config: { script: "" } },
		{ id: `el_${generateId()}`, kind: "script.post", enabled: true, config: { script: "" } },
	];
}
