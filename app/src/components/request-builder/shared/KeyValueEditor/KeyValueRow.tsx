/**
 * KeyValueRow Component
 * 
 * Single row in the KeyValueEditor with variable support
 */

import { memo } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { KeyValueItem } from "../../types";
import { useRequestBuilderContext } from "../../context/RequestBuilderContext";
import VariableInput from "../VariableInput";

interface KeyValueRowProps {
    item: KeyValueItem;
    keyPlaceholder: string;
    valuePlaceholder: string;
    showResolved: boolean;
    allowDisable: boolean;
    readOnly: boolean;
    keySuggestions?: string[];
    onUpdate: (id: string, field: keyof KeyValueItem, value: string | boolean) => void;
    onRemove: (id: string) => void;
}

function KeyValueRow({
    item,
    keyPlaceholder,
    valuePlaceholder,
    showResolved,
    allowDisable,
    readOnly,
    keySuggestions,
    onUpdate,
    onRemove,
}: KeyValueRowProps) {
    const { resolveString } = useRequestBuilderContext();

    const resolvedKey = resolveString(item.key);
    const resolvedValue = resolveString(item.value);
    const hasVariableInKey = item.key !== resolvedKey;
    const hasVariableInValue = item.value !== resolvedValue;

    return (
        <div
            className={cn(
                "grid gap-2 items-center group",
                showResolved
                    ? "grid-cols-[24px_1fr_1fr_1fr_32px]"
                    : "grid-cols-[24px_1fr_1fr_32px]",
                !item.enabled && "opacity-50"
            )}
        >
            {/* Enable/Disable Checkbox */}
            {allowDisable ? (
                <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={(e) => onUpdate(item.id, "enabled", e.target.checked)}
                    disabled={readOnly}
                    className="w-4 h-4 rounded border-input cursor-pointer"
                />
            ) : (
                <div className="w-4" />
            )}

            {/* Key Input */}
            <VariableInput
                value={item.key}
                onChange={(v) => onUpdate(item.id, "key", v)}
                placeholder={keyPlaceholder}
                disabled={readOnly || !item.enabled}
                suggestions={keySuggestions}
            />

            {/* Value Input */}
            <VariableInput
                value={item.value}
                onChange={(v) => onUpdate(item.id, "value", v)}
                placeholder={valuePlaceholder}
                disabled={readOnly || !item.enabled}
            />

            {/* Resolved Preview */}
            {showResolved && (
                <div className="flex items-center min-w-0">
                    <div className="truncate text-sm font-mono text-muted-foreground bg-muted/50 px-2 py-1.5 rounded-md w-full h-9 flex items-center">
                        {item.enabled && (resolvedKey || resolvedValue) ? (
                            <>
                                <span className={hasVariableInKey ? "text-primary" : ""}>
                                    {resolvedKey}
                                </span>
                                {resolvedKey && resolvedValue && <span>=</span>}
                                <span className={hasVariableInValue ? "text-primary" : ""}>
                                    {resolvedValue}
                                </span>
                            </>
                        ) : (
                            <span className="italic text-muted-foreground/50">—</span>
                        )}
                    </div>
                </div>
            )}

            {/* Remove Button */}
            <Button
                size="icon"
                variant="ghost"
                onClick={() => onRemove(item.id)}
                disabled={readOnly}
                className="h-8 w-8 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
            >
                <Trash2 className="w-4 h-4" />
            </Button>
        </div>
    );
}

export default memo(KeyValueRow);
