/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The standing reminder that a local service is reachable beyond this machine.
 *
 * The engine already refused to bind wide without an explicit confirmation;
 * this is what says the confirmation was given, wherever the service is named.
 *
 * A component rather than the same four lines twice: the Services drawer and
 * the inbox tab both render it, and as two copies they had already drifted -
 * the drawer printed the bare bind address and the tab "Reachable on <bind>",
 * so the same fact read as two different things depending on which surface you
 * were looking at (issue #556).
 */

import { Badge } from "@/components/ui";

export interface NonLoopbackBadgeProps {
	/** The address the service is bound to, e.g. `0.0.0.0`. */
	bind: string;
}

export function NonLoopbackBadge({ bind }: NonLoopbackBadgeProps) {
	return (
		// `variant="chip"`, per the Badge note: every other variant pairs its
		// `bg-x` with a `hover:bg-x/80` that tailwind-merge does not replace, so
		// the fill below would win at rest and the accent under the pointer.
		<Badge variant="chip" className="bg-status-warning-fill text-primary-foreground">
			Reachable on {bind}
		</Badge>
	);
}
