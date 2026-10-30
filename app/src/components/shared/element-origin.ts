/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ElementOrigin } from "@/types/domain";

/**
 * Where an element row came from, for the one case worth saying (issue #3051):
 * a collection's element running on a request that does not own it. A
 * request's own element needs no line - it is the step's - and the engine
 * names a folder's level by the same `collection` kind, which the UI calls a
 * collection throughout (`docs/ux-writing.md`). `undefined` means print
 * nothing, for an inline send with no origin as well.
 */
export function elementOriginLabel(origin: ElementOrigin | undefined): string | undefined {
	if (origin?.kind !== "collection") return undefined;
	return origin.name ? `from "${origin.name}"` : "from a collection";
}
