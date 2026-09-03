/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variable Scope Badge
 *
 * Centralized component for displaying variable scope badges.
 * Supports two display modes:
 * - compact: Single letter (G, C, E) - for tight spaces
 * - full: Full word (Global, Collection, Environment) - for popovers/details
 */

import { Badge } from "./badge";
import { VARIABLE_SCOPE_CONFIG } from "@/constants/variables";
import { cn } from "@/lib/utils";
import type { VariableScope } from "@/types";

// Re-export for convenience (components importing from ui/variable-scope-badge)
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
	 * `chip` for both: every other Badge variant pairs `bg-x` with
	 * `hover:bg-x/80`, and tailwind-merge files `hover:bg-*` under a different
	 * key from `bg-*` - so the tint below replaced the background and left the
	 * hover behind. The full variant was `secondary` and greyed out under the
	 * pointer. None of these is clickable.
	 *
	 * Neither variant names a weight: `Badge`'s own base is `font-semibold`,
	 * which is the micro/badge step (#1222). Compact used to override it to
	 * `font-medium` while full inherited the base, so one primitive rendered one
	 * size at two weights. The weight is pinned by rendering both variants in
	 * `variable-scope-badge.test.tsx` - no source scan can see a class that
	 * arrives from a `cva` base through `cn()`.
	 */
	if (variant === "compact") {
		return (
			<Badge
				variant="chip"
				className={cn(
					"h-5 px-1.5 text-[10px] border",
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
		<Badge variant="chip" className={cn("text-[10px] px-1.5 py-0", config.tint, className)}>
			{label}
		</Badge>
	);
}
