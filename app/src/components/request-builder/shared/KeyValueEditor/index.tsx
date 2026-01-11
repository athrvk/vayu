/**
 * KeyValueEditor Component
 * 
 * Reusable editor for key-value pairs with variable support.
 * Used for: Query Params, Headers, Form Data, URL Encoded
 * 
 * Features:
 * - Add/remove rows
 * - Enable/disable individual rows
 * - Variable syntax highlighting and autocomplete
 * - Optional resolved value preview
 * - Optional description field
 */

import { useCallback } from "react";
import { Plus } from "lucide-react";
import { Button, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { KeyValueItem, KeyValueEditorProps } from "../../types";
import { createEmptyKeyValue } from "../../types";
import KeyValueRow from "./KeyValueRow";

export default function KeyValueEditor({
    items,
    onChange,
    keyPlaceholder = "Key",
    valuePlaceholder = "Value",
    showResolved = true,
    allowDisable = true,
    readOnly = false,
    keySuggestions,
}: KeyValueEditorProps) {
    // Add new row
    const handleAdd = useCallback(() => {
        onChange([...items, createEmptyKeyValue()]);
    }, [items, onChange]);

    // Remove row
    const handleRemove = useCallback((id: string) => {
        const newItems = items.filter(item => item.id !== id);
        // Always keep at least one empty row
        onChange(newItems.length > 0 ? newItems : [createEmptyKeyValue()]);
    }, [items, onChange]);

    // Update row
    const handleUpdate = useCallback((id: string, field: keyof KeyValueItem, value: string | boolean) => {
        onChange(items.map(item =>
            item.id === id ? { ...item, [field]: value } : item
        ));
    }, [items, onChange]);

    // Count enabled items with values
    const enabledCount = items.filter(item => item.enabled && item.key.trim()).length;

    return (
        <div className="space-y-2">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    {enabledCount > 0 && (
                        <Badge variant="secondary" className="text-xs">
                            {enabledCount} active
                        </Badge>
                    )}
                </div>
                {!readOnly && (
                    <Button size="sm" variant="outline" onClick={handleAdd}>
                        <Plus className="w-4 h-4 mr-1" />
                        Add
                    </Button>
                )}
            </div>

            {/* Column Headers */}
            <div className={cn(
                "grid gap-2 text-xs font-medium text-muted-foreground px-1",
                showResolved
                    ? "grid-cols-[24px_1fr_1fr_1fr_32px]"
                    : "grid-cols-[24px_1fr_1fr_32px]"
            )}>
                <div></div>
                <div>{keyPlaceholder}</div>
                <div>{valuePlaceholder}</div>
                {showResolved && <div>Resolved</div>}
                <div></div>
            </div>

            {/* Rows */}
            <div className="space-y-1">
                {items.map((item) => (
                    <KeyValueRow
                        key={item.id}
                        item={item}
                        keyPlaceholder={keyPlaceholder}
                        valuePlaceholder={valuePlaceholder}
                        showResolved={showResolved}
                        allowDisable={allowDisable}
                        readOnly={readOnly}
                        keySuggestions={keySuggestions}
                        onUpdate={handleUpdate}
                        onRemove={handleRemove}
                    />
                ))}
            </div>

            {/* Empty State */}
            {items.length === 0 && (
                <div className="py-8 text-center text-muted-foreground text-sm">
                    No items. Click "Add" to create one.
                </div>
            )}
        </div>
    );
}
