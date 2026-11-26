/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The chip where a method would sit for a run whose target is a sequence (#2823), drawn by
 * History's request bar and the live dashboard's sequence panel. Not a `MethodBadge`: SEQUENCE is
 * no method, and the primitive would tint it the OPTIONS colour (the `getMethodColor` fallback) and
 * truncate it in the five-character method column. The neutral outline chip, without a `font-bold`
 * the code font has no face for: `Badge`'s `font-semibold` is the mono step's documented weight
 * (#1199).
 */

import { Badge } from "@/components/ui";

export function SequenceBadge() {
	return (
		<Badge variant="outline" className="font-mono shrink-0">
			SEQUENCE
		</Badge>
	);
}
