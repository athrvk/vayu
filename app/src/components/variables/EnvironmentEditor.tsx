/**
 * Environment Editor
 * 
 * Editor for environment-scoped variables.
 * Environments have medium priority in variable resolution (override globals, overridden by collections).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Cloud, Trash2, Check } from "lucide-react";
import { useUpdateEnvironmentMutation, useDeleteEnvironmentMutation } from "@/queries";
import { Button, Input, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Environment, VariableValue } from "@/types";
import { useVariablesStore } from "@/stores";

interface VariableRow {
    key: string;
    value: string;
    enabled: boolean;
    isNew?: boolean;
}

interface EnvironmentEditorProps {
    environment: Environment;
}

export default function EnvironmentEditor({ environment }: EnvironmentEditorProps) {
    const updateMutation = useUpdateEnvironmentMutation();
    const deleteMutation = useDeleteEnvironmentMutation();
    const { setSelectedCategory, setActiveEnvironmentId } = useVariablesStore();

    const [variables, setVariables] = useState<VariableRow[]>([]);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showSaved, setShowSaved] = useState(false);
    const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Auto-save function
    const performSave = useCallback((varsToSave: VariableRow[]) => {
        const variablesObj: Record<string, VariableValue> = {};

        varsToSave.forEach((v) => {
            if (v.key && !v.isNew) {
                variablesObj[v.key] = {
                    value: v.value,
                    enabled: v.enabled,
                };
            }
        });

        updateMutation.mutate({
            id: environment.id,
            name: environment.name,
            variables: variablesObj,
        }, {
            onSuccess: () => {
                setShowSaved(true);
                setTimeout(() => setShowSaved(false), 2000);
            }
        });
    }, [updateMutation, environment.id, environment.name]);

    // Debounced save - triggers after user stops typing
    const debouncedSave = useCallback((varsToSave: VariableRow[]) => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }
        saveTimeoutRef.current = setTimeout(() => {
            performSave(varsToSave);
        }, 800);
    }, [performSave]);

    // Cleanup timeout on unmount
    useEffect(() => {
        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, []);

    // Initialize variables from environment data
    useEffect(() => {
        const rows: VariableRow[] = Object.entries(environment.variables || {}).map(([key, val]) => ({
            key,
            value: val.value,
            enabled: val.enabled,
        }));
        rows.push({ key: '', value: '', enabled: true, isNew: true });
        setVariables(rows);
    }, [environment.id, environment.variables]);

    const updateVariable = (index: number, field: keyof VariableRow, value: string | boolean) => {
        const newVariables = [...variables];
        newVariables[index] = { ...newVariables[index], [field]: value };

        if (newVariables[index].isNew && (newVariables[index].key || newVariables[index].value)) {
            newVariables[index].isNew = false;
            newVariables.push({ key: '', value: '', enabled: true, isNew: true });
        }

        setVariables(newVariables);
        debouncedSave(newVariables);
    };

    const removeVariable = (index: number) => {
        const newVariables = variables.filter((_, i) => i !== index);
        if (newVariables.length === 0 || !newVariables.some(v => v.isNew)) {
            newVariables.push({ key: '', value: '', enabled: true, isNew: true });
        }
        setVariables(newVariables);
        debouncedSave(newVariables);
    };

    const handleDelete = () => {
        deleteMutation.mutate(environment.id, {
            onSuccess: () => {
                setSelectedCategory(null);
            }
        });
    };

    const handleSetActive = () => {
        setActiveEnvironmentId(environment.id);
    };

    const isActive = useVariablesStore.getState().activeEnvironmentId === environment.id;

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/50">
                <div className="flex items-center gap-2">
                    <Cloud className="w-5 h-5 text-blue-400" />
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold text-foreground">{environment.name}</h2>
                            {isActive && (
                                <Badge variant="secondary" className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                                    Active
                                </Badge>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">Environment Variables</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {!isActive && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleSetActive}
                            className="border-blue-300 text-blue-600 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-950"
                        >
                            Set Active
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowDeleteConfirm(true)}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Delete environment"
                    >
                        <Trash2 className="w-4 h-4" />
                    </Button>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        {updateMutation.isPending && (
                            <span className="flex items-center gap-1">
                                <span className="animate-spin w-3 h-3 border border-blue-500 border-t-transparent rounded-full" />
                                Saving...
                            </span>
                        )}
                        {showSaved && !updateMutation.isPending && (
                            <span className="flex items-center gap-1 text-blue-600">
                                <Check className="w-4 h-4" />
                                Saved
                            </span>
                        )}
                    </div>
                </div>
            </div>

            <div className="px-4 py-2 text-xs text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/50 border-b border-blue-100 dark:border-blue-900">
                Environment variables override global variables but can be overridden by collection variables.
            </div>

            {/* Delete Confirmation */}
            {showDeleteConfirm && (
                <div className="px-4 py-3 bg-destructive/10 border-b border-destructive/20 flex items-center justify-between">
                    <span className="text-sm text-destructive">
                        Delete "{environment.name}"? This cannot be undone.
                    </span>
                    <div className="flex gap-2">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowDeleteConfirm(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleDelete}
                            disabled={deleteMutation.isPending}
                        >
                            {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
                        </Button>
                    </div>
                </div>
            )}

            {/* Variables Table */}
            <div className="flex-1 overflow-y-auto p-4">
                <table className="w-full">
                    <thead>
                        <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                            <th className="pb-2 w-8"></th>
                            <th className="pb-2 px-2">Variable</th>
                            <th className="pb-2 px-2">Value</th>
                            <th className="pb-2 w-10"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {variables.map((variable, index) => (
                            <tr key={index} className="group">
                                <td className="py-1">
                                    <input
                                        type="checkbox"
                                        checked={variable.enabled}
                                        onChange={(e) => updateVariable(index, 'enabled', e.target.checked)}
                                        className="w-4 h-4 rounded border-input text-blue-500 focus:ring-blue-500"
                                        disabled={variable.isNew && !variable.key}
                                    />
                                </td>
                                <td className="py-1 px-2">
                                    <Input
                                        type="text"
                                        value={variable.key}
                                        onChange={(e) => updateVariable(index, 'key', e.target.value)}
                                        placeholder="variable_name"
                                        className={cn(
                                            "h-8",
                                            !variable.enabled && !variable.isNew && "text-muted-foreground bg-muted"
                                        )}
                                    />
                                </td>
                                <td className="py-1 px-2">
                                    <Input
                                        type="text"
                                        value={variable.value}
                                        onChange={(e) => updateVariable(index, 'value', e.target.value)}
                                        placeholder="value"
                                        className={cn(
                                            "h-8",
                                            !variable.enabled && !variable.isNew && "text-muted-foreground bg-muted"
                                        )}
                                    />
                                </td>
                                <td className="py-1">
                                    {!variable.isNew && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => removeVariable(index)}
                                            className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </Button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-border bg-muted/50 text-xs text-muted-foreground">
                {variables.filter(v => v.key && !v.isNew).length} variable(s)
                <span className="ml-2">• Auto-saves as you type</span>
            </div>
        </div>
    );
}
