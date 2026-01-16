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

export type VariableScope = "global" | "collection" | "environment";

export interface VariableScopeBadgeProps {
    scope: VariableScope;
    variant?: "compact" | "full";
    className?: string;
}

const SCOPE_CONFIG: Record<
    VariableScope,
    { compact: string; full: string; className: string }
> = {
    global: {
        compact: "G",
        full: "Global",
        className: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    },
    collection: {
        compact: "C",
        full: "Collection",
        className: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
    },
    environment: {
        compact: "E",
        full: "Environment",
        className: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    },
};

export function VariableScopeBadge({
    scope,
    variant = "compact",
    className,
}: VariableScopeBadgeProps) {
    const config = SCOPE_CONFIG[scope];
    const label = variant === "compact" ? config.compact : config.full;

    // For compact variant, use outline style (like in templated-input)
    // For full variant, use secondary style (like in VariableToken)
    if (variant === "compact") {
        return (
            <Badge
                variant="outline"
                className={cn(
                    "h-5 px-1.5 text-[10px] font-medium",
                    scope === "global"
                        ? "bg-muted"
                        : scope === "collection"
                            ? "bg-blue-50 text-blue-700 border-blue-200"
                            : "bg-green-50 text-green-700 border-green-200",
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
