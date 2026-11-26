/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A variable's scope badge, `compact` (G, C, E) for tight spaces or `full` (Global, Collection,
 * Environment) for popovers and details.
 */

import { Badge } from "./badge";
import { VARIABLE_SCOPE_CONFIG } from "@/constants/variables";
import { cn } from "@/lib/utils";
import type { VariableScope } from "@/types";

// Re-exported for components importing from `ui/variable-scope-badge`.
export type { VariableScope };

export interface VariableScopeBadgeProps {
	scope: VariableScope;
	variant?: "compact" | "full";
	className?: string;
}

export function VariableScopeBadge({
	scope,
	variant = "compact",
	className,
}: VariableScopeBadgeProps) {
	const config = VARIABLE_SCOPE_CONFIG[scope];
	const label = variant === "compact" ? config.compact : config.full;

	/*
	 * `chip` for both: other Badge variants pair `bg-x` with `hover:bg-x/80`, and tailwind-merge
	 * files `hover:bg-*` apart from `bg-*`, so the tint below would keep the hover. None is
	 * clickable. Neither names a weight: `Badge`'s base `font-semibold` is the micro/badge step
	 * (#1222), pinned by rendering both in `variable-scope-badge.test.tsx`, as no source scan sees
	 * a class arriving from a `cva` base through `cn()`.
	 */
	if (variant === "compact") {
		return (
			<Badge
				variant="chip"
				className={cn(
					"h-5 px-1.5 text-micro border",
					config.tint,
					config.border,
					className
				)}
			>
				{label}
			</Badge>
		);
	}

	return (
		<Badge variant="chip" className={cn("text-micro px-1.5 py-0", config.tint, className)}>
			{label}
		</Badge>
	);
}
