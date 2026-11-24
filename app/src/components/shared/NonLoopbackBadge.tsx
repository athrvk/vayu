/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The standing reminder that a local service is reachable beyond this machine. The engine refuses
 * to bind wide without explicit confirmation; this says it was given, wherever the service is
 * named. A component, as the Services drawer and the inbox tab both render it, and two copies had
 * drifted (the bare bind address against "Reachable on <bind>", #556).
 */

import { Badge } from "@/components/ui";

export interface NonLoopbackBadgeProps {
	/** The address the service is bound to, e.g. `0.0.0.0`. */
	bind: string;
}

export function NonLoopbackBadge({ bind }: NonLoopbackBadgeProps) {
	return (
		// `variant="chip"`, per the Badge note: other variants pair `bg-x` with a `hover:bg-x/80`
		// tailwind-merge keeps, so the fill would show at rest and the accent under the pointer.
		<Badge variant="chip" className="bg-status-warning-fill text-primary-foreground">
			Reachable on {bind}
		</Badge>
	);
}
