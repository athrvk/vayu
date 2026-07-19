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

const SCOPE_CONFIG: Record<VariableScope, { compact: string; full: string; className: string }> = {
	global: {
		compact: "G",
		full: "Global",
		className: "bg-scope-global/10 text-scope-global",
	},
	collection: {
		compact: "C",
		full: "Collection",
		className: "bg-scope-collection/10 text-scope-collection",
	},
	environment: {
		compact: "E",
		full: "Environment",
		className: "bg-scope-environment/10 text-scope-environment",
	},
};

export function VariableScopeBadge({
	scope,
	variant = "compact",
	className,
}: VariableScopeBadgeProps) {
	const config = SCOPE_CONFIG[scope];
	const label = variant === "compact" ? config.compact : config.full;

	// For compact variant, use outline style (for autocomplete lists)
	// For full variant, use secondary style (for popover details)
	if (variant === "compact") {
		return (
			<Badge
				variant="outline"
				className={cn(
					"h-5 px-1.5 text-[10px] font-medium",
					// global stays neutral; collection/environment carry their scope
					// hue (previously these two were swapped — collection showed blue,
					// environment green).
					scope === "global"
						? "bg-muted"
						: scope === "collection"
							? "bg-scope-collection/10 text-scope-collection border-scope-collection/30"
							: "bg-scope-environment/10 text-scope-environment border-scope-environment/30",
					className
				)}
			>
				{label}
			</Badge>
		);
	}

	return (
		<Badge
			variant="secondary"
			className={cn("text-[10px] px-1.5 py-0", config.className, className)}
		>
			{label}
		</Badge>
	);
}
