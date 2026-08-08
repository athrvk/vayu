/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which environment is active, and the way to the editor.
 *
 * Two sections above this one - the variables in scope and the cookies for this
 * host - are scoped by the active environment, so naming it here is what keeps
 * them from looking wrong when the answer is "you are on None".
 *
 * The button opens the Variables drawer rather than repeating the TitleBar's
 * switcher. That switcher is inline markup in `TitleBar.tsx`, not a primitive,
 * and a second copy of it would be a second copy of its switch-confirmation
 * flow - one of the few places in the app where a click has consequences the
 * user cannot see.
 */

import { useEnvironmentsQuery } from "@/queries";
import { useLayoutStore } from "@/stores";
import { useSessionStore } from "@/stores";
import { Button } from "@/components/ui";

export function EnvironmentSection() {
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const { data: environments = [] } = useEnvironmentsQuery();
	const activateDrawerView = useLayoutStore((s) => s.activateDrawerView);

	const active = environments.find((e) => e.id === activeEnvironmentId);

	return (
		<div className="flex items-center justify-between gap-2">
			<span className="text-xs font-mono text-foreground truncate">
				{active ? active.name : "No environment"}
			</span>
			<Button
				variant="ghost"
				size="sm"
				className="h-6 text-xs shrink-0"
				onClick={() => activateDrawerView("variables")}
			>
				Manage
			</Button>
		</div>
	);
}
