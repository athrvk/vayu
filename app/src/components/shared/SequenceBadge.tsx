/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The chip that stands where a method sits for a run whose target is a sequence
 * (#2823): History's request bar and the live dashboard's sequence panel draw
 * the same one.
 *
 * Not a `MethodBadge`: SEQUENCE is not a method, and the primitive would tint it
 * in the OPTIONS colour (the `getMethodColor` fallback) and truncate it at the
 * seven-character method column. It keeps the neutral outline chip, minus a
 * `font-bold` the code font has no face for - `Badge`'s own `font-semibold` is
 * the weight the mono step documents (#1199).
 */

import { Badge } from "@/components/ui";

export function SequenceBadge() {
	return (
		<Badge variant="outline" className="font-mono shrink-0">
			SEQUENCE
		</Badge>
	);
}
