/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { pickByCount } from "@/modules/dashboard/utils/format";

/**
 * Names the tokens left written because a pre-request script runs before the
 * send (#2521), so a `{{token}}` reads as deliberate rather than as a variable
 * that failed to resolve. The Code section's note, the "Sends" line's hint and a
 * deferred token's hover are this one sentence.
 *
 * Its own module, apart from `code-composition.ts`, because the token painters
 * under `components/shared/` say it too and must not load a query to do so.
 */
export function deferredNote(names: readonly string[]): string {
	const tokens = names.map((name) => `{{${name}}}`).join(", ");
	return pickByCount(names.length, {
		one: `${tokens} is set by a pre-request script at send.`,
		other: `${tokens} are set by a pre-request script at send.`,
	});
}
