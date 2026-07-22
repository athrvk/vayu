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
import { cn } from "@/lib/utils";
import type { VariableScope } from "@/types";

// Re-export for convenience (components importing from ui/variable-scope-badge)
export type { VariableScope };

export interface VariableScopeBadgeProps {
	scope: VariableScope;
	variant?: "compact" | "full";
	className?: string;
}

/**
 * One colour per scope, read by both variants.
 *
 * The compact branch used to re-derive these inline and special-cased global to
 * `bg-muted`, so the same scope rendered green in a popover and grey in the
 * autocomplete list. `--scope-global` is a real token (green in both themes),
 * `docs/design-system.md` gives it the same "icon/text solid, `/10` tint"
 * convention as the other two, and `VariableTableEditor` and
 * `VariablesCategoryTree` already paint it green — the autocomplete was the
 * only place that disagreed.
 */
const SCOPE_CONFIG: Record<
	VariableScope,
	{ compact: string; full: string; tint: string; border: string }
> = {
	global: {
		compact: "G",
		full: "Global",
		tint: "bg-scope-global/10 text-scope-global",
		border: "border-scope-global/30",
	},
	collection: {
		compact: "C",
		full: "Collection",
		tint: "bg-scope-collection/10 text-scope-collection",
		border: "border-scope-collection/30",
	},
	environment: {
		compact: "E",
		full: "Environment",
		tint: "bg-scope-environment/10 text-scope-environment",
		border: "border-scope-environment/30",
	},
};

export function VariableScopeBadge({
	scope,
	variant = "compact",
	className,
}: VariableScopeBadgeProps) {
	const config = SCOPE_CONFIG[scope];
	const label = variant === "compact" ? config.compact : config.full;

	/*
	 * `chip` for both: every other Badge variant pairs `bg-x` with
	 * `hover:bg-x/80`, and tailwind-merge files `hover:bg-*` under a different
	 * key from `bg-*` — so the tint below replaced the background and left the
	 * hover behind. The full variant was `secondary` and greyed out under the
	 * pointer. None of these is clickable.
	 */
	if (variant === "compact") {
		return (
			<Badge
				variant="chip"
				className={cn(
					"h-5 px-1.5 text-[10px] font-medium border",
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
