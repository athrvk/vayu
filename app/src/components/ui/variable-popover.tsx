/**
 * Variable Popover
 *
 * Unified popover component for viewing and editing variable values.
 * Supports two modes:
 * - manual: Save/Cancel buttons (explicit save)
 * - auto: Auto-saves on close (implicit save)
 */

import { useState, useEffect, useRef } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Button } from "./button";
import { Input } from "./input";
import { VariableScopeBadge, type VariableScope } from "./variable-scope-badge";

export interface VariableInfo {
    value: string;
    scope: VariableScope;
}

export interface VariablePopoverProps {
    /** Variable name */
    name: string;
    /** Variable information (value and scope) */
    varInfo: VariableInfo | null;
    /** Whether the variable is resolved */
    resolved: boolean;
    /** Callback when value changes (required for editable mode) */
    onValueChange?: (name: string, value: string, scope: VariableScope) => void;
    /** Save mode: 'manual' shows Save/Cancel buttons, 'auto' saves on close */
    saveMode?: "manual" | "auto";
    /** Whether editing is disabled */
    disabled?: boolean;
    /** Custom trigger element */
    trigger: React.ReactNode;
    /** Custom className for trigger */
    triggerClassName?: string;
    /** Show current value section (default: true for auto mode, false for manual) */
    showCurrentValue?: boolean;
}

export function VariablePopover({
    name,
    varInfo,
    resolved,
    onValueChange,
    saveMode = "auto",
    disabled = false,
    trigger,
    triggerClassName,
    showCurrentValue,
}: VariablePopoverProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [editValue, setEditValue] = useState(varInfo?.value || "");
    const openValueRef = useRef(varInfo?.value || "");

    // Keep editValue in sync with varInfo when popover is closed
    useEffect(() => {
        if (!isOpen && varInfo) {
            setEditValue(varInfo.value);
        }
    }, [varInfo?.value, isOpen]);

    // Initialize ref when opening
    useEffect(() => {
        if (isOpen && varInfo) {
            openValueRef.current = varInfo.value;
            setEditValue(varInfo.value);
        }
    }, [isOpen, varInfo]);

    const handleOpenChange = (open: boolean) => {
        if (open) {
            setIsOpen(true);
        } else {
            // Closing: auto-save if in auto mode and value changed
            if (saveMode === "auto" && onValueChange && varInfo) {
                if (editValue !== openValueRef.current) {
                    onValueChange(name, editValue, varInfo.scope);
                }
            }
            setIsOpen(false);
        }
    };

    const handleSave = () => {
        if (onValueChange && varInfo) {
            onValueChange(name, editValue, varInfo.scope);
        }
        setIsOpen(false);
    };

    const handleCancel = () => {
        if (varInfo) {
            setEditValue(varInfo.value);
        }
        setIsOpen(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (saveMode === "manual") {
            if (e.key === "Enter") {
                handleSave();
            } else if (e.key === "Escape") {
                handleCancel();
            }
        } else {
            // Auto mode: just close on Enter/Escape
            if (e.key === "Enter" || e.key === "Escape") {
                setIsOpen(false);
            }
        }
    };

    const shouldShowCurrentValue =
        showCurrentValue !== undefined
            ? showCurrentValue
            : saveMode === "auto" && resolved;

    const canEdit = !!onValueChange && !!varInfo && resolved && !disabled;

    // Handle trigger click manually to ensure popover opens
    const handleTriggerClick = (e: React.MouseEvent) => {
        if (!disabled) {
            e.stopPropagation(); // Prevent input blur
            if (!isOpen) {
                setIsOpen(true);
            }
        }
    };

    // Wrap trigger in span with click handler
    const triggerElement = (
        <span
            className={triggerClassName}
            onClick={handleTriggerClick}
            style={{ display: "inline" }}
        >
            {trigger}
        </span>
    );

    return (
        <Popover open={isOpen} onOpenChange={handleOpenChange}>
            <PopoverTrigger asChild>
                {triggerElement}
            </PopoverTrigger>
            <PopoverContent
                className="w-72 p-3"
                align="start"
                side="bottom"
                onClick={(e) => e.stopPropagation()}
                onPointerDownOutside={(e) => {
                    if (saveMode === "manual") {
                        e.preventDefault();
                    }
                }}
                onOpenAutoFocus={(e) => e.preventDefault()}
            >
                <div className="space-y-3">
                    {/* Header: Variable name and scope badge */}
                    <div>
                        <div className="flex flex-row items-baseline justify-between gap-2">
                            <span className="font-mono text-sm font-medium">{name}</span>
                            {varInfo && <VariableScopeBadge scope={varInfo.scope} variant="full" />}
                        </div>
                    </div>

                    {resolved && varInfo ? (
                        <>
                            {/* Current Value Section (for auto mode) */}
                            {shouldShowCurrentValue && (
                                <div className="space-y-2">
                                    <label className="text-xs text-muted-foreground">
                                        Current Value
                                    </label>
                                    <div className="font-mono text-sm bg-muted px-2 py-1.5 rounded break-all">
                                        {varInfo.value || (
                                            <span className="italic text-muted-foreground">empty</span>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Edit Section */}
                            {canEdit && (
                                <div className="space-y-2">
                                    <label className="text-xs text-muted-foreground">
                                        {saveMode === "auto" ? "Edit Value" : "Value"}
                                    </label>
                                    <Input
                                        value={editValue}
                                        onChange={(e) => setEditValue(e.target.value)}
                                        onKeyDown={handleKeyDown}
                                        className="h-8 font-mono text-sm"
                                        autoFocus
                                    />
                                </div>
                            )}

                            {/* Action Buttons (manual mode only) */}
                            {saveMode === "manual" && canEdit && (
                                <>
                                    <div className="flex justify-end gap-2">
                                        <Button size="sm" variant="ghost" onClick={handleCancel}>
                                            Cancel
                                        </Button>
                                        <Button size="sm" onClick={handleSave}>
                                            Save
                                        </Button>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        Press Enter to save, Esc to cancel
                                    </p>
                                </>
                            )}

                            {/* Auto-save hint (auto mode only) */}
                            {saveMode === "auto" && canEdit && (
                                <p className="text-[10px] text-muted-foreground">
                                    Auto-saves when you click away
                                </p>
                            )}
                        </>
                    ) : (
                        <div className="text-sm text-destructive">
                            Variable not defined. Define it in Globals, an Environment, or
                            Collection variables.
                        </div>
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}
