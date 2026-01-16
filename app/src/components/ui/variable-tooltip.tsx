/**
 * Variable Tooltip
 *
 * Shows variable information in a tooltip for non-editable variables.
 * Used when variables are displayed but cannot be edited inline.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { VariableScopeBadge, type VariableScope } from "./variable-scope-badge";

export interface VariableInfo {
    value: string;
    scope: VariableScope;
}

export interface VariableTooltipProps {
    varName: string;
    varInfo: VariableInfo | null;
    children: React.ReactNode;
    className?: string;
}

export function VariableTooltip({
    varName,
    varInfo,
    children,
    className,
}: VariableTooltipProps) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className={className}>{children}</span>
            </TooltipTrigger>
            <TooltipContent>
                {varInfo ? (
                    <div className="text-xs">
                        <div className="font-medium">{varName}</div>
                        <div className="text-muted-foreground">= {varInfo.value}</div>
                        <div className="text-muted-foreground mt-1 flex items-center gap-1">
                            Scope: <VariableScopeBadge scope={varInfo.scope} variant="full" />
                        </div>
                    </div>
                ) : (
                    <div className="text-xs text-destructive">Unresolved variable</div>
                )}
            </TooltipContent>
        </Tooltip>
    );
}
