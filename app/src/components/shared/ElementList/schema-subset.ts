/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ElementConfigProperty, ElementConfigSchema } from "@/types";

/**
 * The named properties of `schema` as a schema of their own, carrying only the
 * `required` entries that survived the cut. A name the catalogue does not
 * declare (an older engine build) is dropped rather than rendered blank.
 *
 * Shared by the forms that render part of a kind's schema through
 * `GenericElementForm` (`ModeElementForm`, `ScriptElementForm`), so the fields
 * of a part look like every other row in the card because they are the same
 * rows.
 */
export function subsetSchema(
	properties: Record<string, ElementConfigProperty | null | undefined>,
	required: string[] | undefined,
	names: string[]
): ElementConfigSchema {
	const kept: Record<string, ElementConfigProperty | null> = {};
	for (const name of names) {
		if (Object.prototype.hasOwnProperty.call(properties, name)) {
			kept[name] = properties[name] ?? null;
		}
	}
	return {
		type: "object",
		properties: kept,
		required: (required ?? []).filter((name) => name in kept),
	};
}
