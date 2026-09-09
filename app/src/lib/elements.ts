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

/**
 * The joined text of every enabled element of one script kind (`script.pre`
 * or `script.post`) in a list - what a pre-request-script presence check
 * (`LoadTestConfigDialog`'s warning) and the variable-reference scanners
 * (`ColumnAudit`, `column-audit.ts`, `request-references.ts`) need: one flat
 * string per entity rather than the element list itself.
 *
 * Joined with the engine's own separator (`"\n\n"`,
 * `RunContext::compile_step_elements`) so it reproduces what a load run's
 * deferred replay runs when more than one `script.post` element defers - the
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
 * Whether a `script.pre`/`script.post` element's own text is empty or
 * whitespace-only - the shared rule for "absent for every purpose but
 * storage" (#1609): not composed, not run, not reported, not counted toward
 * an inherited-elements notice. A blank element still exists as a stored row
 * (a user may be mid-edit); only its runtime effect is inert.
 */
export function isBlankScriptElement(el: Pick<ElementDef, "kind" | "config">): boolean {
	if (el.kind !== "script.pre" && el.kind !== "script.post") return false;
	const text = el.config.script;
	return typeof text !== "string" || text.trim().length === 0;
}
