/**
 * Unified Variable Editor
 *
 * A single configurable editor component that handles all variable types:
 * - Globals
 * - Environments
 * - Collections
 *
 * The editor is configured via the `config` prop which determines:
 * - Data source and mutations
 * - UI colors and icons
 * - Header content
 * - Additional actions (e.g., delete for environments)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Globe, Cloud, Folder, Trash2, AlertCircle, LucideIcon } from "lucide-react";
import {
    useGlobalsQuery,
    useUpdateGlobalsMutation,
    useUpdateEnvironmentMutation,
    useDeleteEnvironmentMutation,
    useUpdateCollectionMutation,
} from "@/queries";
import { useSaveStore, useVariablesStore } from "@/stores";
import type { VariableValue, Collection, Environment } from "@/types";
import { Button, Input, Badge } from "@/components/ui";
import { cn } from "@/lib/utils";

interface VariableRow {
    key: string;
    value: string;
    enabled: boolean;
    isNew?: boolean;
}

type VariableEditorType = "globals" | "environment" | "collection";

interface VariableEditorConfig {
    type: VariableEditorType;
    // For globals
    globalsData?: { variables?: Record<string, VariableValue> } | null;
    isLoading?: boolean;
    error?: Error | null;
    // For environment
    environment?: Environment;
    // For collection
    collection?: Collection;
}

const EDITOR_CONFIGS = {
    globals: {
        icon: Globe as LucideIcon,
        iconColor: "text-green-500",
        title: "Global Variables",
        subtitle: "Global Variables",
        infoText: "Global variables are available in all requests (lowest priority). They can be overridden by environment and collection variables.",
        infoBg: "bg-green-50 dark:bg-green-950/50",
        infoTextColor: "text-green-700 dark:text-green-300",
        infoBorder: "border-green-100 dark:border-green-900",
        checkboxColor: "text-green-500 focus:ring-green-500 accent-green-500",
        loadingColor: "border-green-500",
    },
    environment: {
        icon: Cloud as LucideIcon,
        iconColor: "text-blue-400",
        title: (name: string) => name,
        subtitle: "Environment Variables",
        infoText: "Environment variables override global variables but can be overridden by collection variables.",
        infoBg: "bg-blue-50 dark:bg-blue-950/50",
        infoTextColor: "text-blue-700 dark:text-blue-300",
        infoBorder: "border-blue-100 dark:border-blue-900",
        checkboxColor: "text-blue-500 focus:ring-blue-500 accent-blue-500",
        loadingColor: "border-blue-500",
    },
    collection: {
        icon: Folder as LucideIcon,
        iconColor: "text-orange-400",
        title: (name: string) => name,
        subtitle: "Collection Variables",
        infoText: "Collection variables have the highest priority and override both global and environment variables.",
        infoBg: "bg-orange-50 dark:bg-orange-950/50",
        infoTextColor: "text-orange-700 dark:text-orange-300",
        infoBorder: "border-orange-100 dark:border-orange-900",
        checkboxColor: "text-orange-500 focus:ring-orange-500 accent-orange-500",
        loadingColor: "border-orange-500",
    },
} as const;

interface VariableEditorProps {
    config: VariableEditorConfig;
}

export default function VariableEditor({ config }: VariableEditorProps) {
    const { type, globalsData, isLoading, error, environment, collection } = config;
    const editorConfig = EDITOR_CONFIGS[type];

    // Queries and mutations based on type
    const globalsQuery = useGlobalsQuery();
    const updateGlobalsMutation = useUpdateGlobalsMutation();
    const updateEnvironmentMutation = useUpdateEnvironmentMutation();
    const deleteEnvironmentMutation = useDeleteEnvironmentMutation();
    const updateCollectionMutation = useUpdateCollectionMutation();

    const { setSelectedCategory, setActiveEnvironmentId } = useVariablesStore();
    const {
        registerContext,
        unregisterContext,
        updateContext,
        setActiveContext,
        markPendingSave,
        startSaving,
        completeSave,
        failSave,
        setStatus,
    } = useSaveStore();

    const [variables, setVariables] = useState<VariableRow[]>([]);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [hasPendingChanges, setHasPendingChanges] = useState(false);
    const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const variablesRef = useRef<VariableRow[]>([]);
    const performSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

    // Determine context ID and name
    const contextId =
        type === "globals"
            ? "globals-editor"
            : type === "environment"
                ? `environment-${environment?.id}`
                : `collection-${collection?.id}`;

    const contextName =
        type === "globals"
            ? "Global Variables"
            : type === "environment"
                ? `Environment: ${environment?.name}`
                : `Collection: ${collection?.name}`;

    // Get data based on type
    const dataVariables =
        type === "globals"
            ? globalsData?.variables || {}
            : type === "environment"
                ? environment?.variables || {}
                : collection?.variables || {};

    // Determine loading and error states
    const isDataLoading = type === "globals" ? (isLoading ?? globalsQuery.isLoading) : false;
    const dataError = type === "globals" ? (error ?? globalsQuery.error) : null;

    // Keep variablesRef in sync
    useEffect(() => {
        variablesRef.current = variables;
    }, [variables]);

    // Auto-save function
    const performSave = useCallback(async () => {
        const varsToSave = variablesRef.current;
        const variablesObj: Record<string, VariableValue> = {};

        varsToSave.forEach((v) => {
            if (v.key && !v.isNew) {
                variablesObj[v.key] = {
                    value: v.value,
                    enabled: v.enabled,
                };
            }
        });

        startSaving();

        return new Promise<void>((resolve, reject) => {
            if (type === "globals") {
                updateGlobalsMutation.mutate(
                    { variables: variablesObj },
                    {
                        onSuccess: () => {
                            setHasPendingChanges(false);
                            completeSave();
                            setTimeout(() => setStatus("idle"), 2000);
                            resolve();
                        },
                        onError: (error) => {
                            failSave(error instanceof Error ? error.message : "Save failed");
                            reject(error);
                        },
                    }
                );
            } else if (type === "environment" && environment) {
                updateEnvironmentMutation.mutate(
                    {
                        id: environment.id,
                        name: environment.name,
                        variables: variablesObj,
                    },
                    {
                        onSuccess: () => {
                            setHasPendingChanges(false);
                            completeSave();
                            setTimeout(() => setStatus("idle"), 2000);
                            resolve();
                        },
                        onError: (error) => {
                            failSave(error instanceof Error ? error.message : "Save failed");
                            reject(error);
                        },
                    }
                );
            } else if (type === "collection" && collection) {
                updateCollectionMutation.mutate(
                    {
                        id: collection.id,
                        name: collection.name,
                        variables: variablesObj,
                    },
                    {
                        onSuccess: () => {
                            setHasPendingChanges(false);
                            completeSave();
                            setTimeout(() => setStatus("idle"), 2000);
                            resolve();
                        },
                        onError: (error) => {
                            failSave(error instanceof Error ? error.message : "Save failed");
                            reject(error);
                        },
                    }
                );
            }
        });
    }, [
        type,
        environment,
        collection,
        updateGlobalsMutation,
        updateEnvironmentMutation,
        updateCollectionMutation,
        startSaving,
        completeSave,
        failSave,
        setStatus,
    ]);

    // Keep performSaveRef updated
    useEffect(() => {
        performSaveRef.current = performSave;
    }, [performSave]);

    // Register save context on mount
    useEffect(() => {
        registerContext({
            id: contextId,
            name: contextName,
            save: () => performSaveRef.current(),
            hasPendingChanges: false,
        });
        setActiveContext(contextId);

        return () => {
            unregisterContext(contextId);
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [contextId, contextName, registerContext, unregisterContext, setActiveContext]);

    // Update context when hasPendingChanges changes
    useEffect(() => {
        updateContext(contextId, { hasPendingChanges });
    }, [contextId, hasPendingChanges, updateContext]);

    // Handle blur - save when user leaves the field
    const handleBlur = useCallback(() => {
        if (hasPendingChanges) {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
            performSaveRef.current();
        }
    }, [hasPendingChanges]);

    // Handle focus - cancel any pending save
    const handleFocus = useCallback(() => {
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }
    }, []);

    // Initialize variables from data
    useEffect(() => {
        if (dataVariables && Object.keys(dataVariables).length > 0) {
            const rows: VariableRow[] = Object.entries(dataVariables).map(([key, val]) => ({
                key,
                value: val.value,
                enabled: val.enabled,
            }));
            rows.push({ key: "", value: "", enabled: true, isNew: true });
            setVariables(rows);
        } else {
            setVariables([{ key: "", value: "", enabled: true, isNew: true }]);
        }
    }, [
        type === "globals"
            ? globalsData
            : type === "environment"
                ? environment?.id
                : collection?.id,
        dataVariables,
    ]);

    const updateVariable = (index: number, field: keyof VariableRow, value: string | boolean) => {
        const newVariables = [...variables];
        newVariables[index] = { ...newVariables[index], [field]: value };

        if (newVariables[index].isNew && (newVariables[index].key || newVariables[index].value)) {
            newVariables[index].isNew = false;
            newVariables.push({ key: "", value: "", enabled: true, isNew: true });
        }

        setVariables(newVariables);
        setHasPendingChanges(true);
        markPendingSave(contextId);
    };

    const removeVariable = (index: number) => {
        const newVariables = variables.filter((_, i) => i !== index);
        if (newVariables.length === 0 || !newVariables.some((v) => v.isNew)) {
            newVariables.push({ key: "", value: "", enabled: true, isNew: true });
        }
        setVariables(newVariables);
        setHasPendingChanges(true);
        performSaveRef.current();
    };

    // Environment-specific handlers
    const handleDeleteEnvironment = () => {
        if (type === "environment" && environment) {
            deleteEnvironmentMutation.mutate(environment.id, {
                onSuccess: () => {
                    setSelectedCategory(null);
                },
            });
        }
    };

    const handleSetActiveEnvironment = () => {
        if (type === "environment" && environment) {
            setActiveEnvironmentId(environment.id);
        }
    };

    const isActiveEnvironment =
        type === "environment" &&
        environment &&
        useVariablesStore.getState().activeEnvironmentId === environment.id;

    const Icon = editorConfig.icon;
    const title =
        type === "globals"
            ? (editorConfig.title as string)
            : (editorConfig.title as (name: string) => string)(
                type === "environment" ? environment?.name || "" : collection?.name || ""
            );

    if (isDataLoading) {
        return (
            <div className="flex items-center justify-center h-full">
                <div
                    className={cn(
                        "animate-spin w-6 h-6 border-2 border-t-transparent rounded-full",
                        editorConfig.loadingColor
                    )}
                />
            </div>
        );
    }

    if (dataError) {
        return (
            <div className="flex items-center justify-center h-full text-destructive">
                <AlertCircle className="w-5 h-5 mr-2" />
                <span>Failed to load {type === "globals" ? "globals" : type === "environment" ? "environment" : "collection"}</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/50">
                <div className="flex items-center gap-2">
                    <Icon className={cn("w-5 h-5", editorConfig.iconColor)} />
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                            {type === "environment" && isActiveEnvironment && (
                                <Badge
                                    variant="secondary"
                                    className="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                                >
                                    Active
                                </Badge>
                            )}
                        </div>
                        <p className="text-xs text-muted-foreground">{editorConfig.subtitle}</p>
                    </div>
                </div>
                {type === "environment" && environment && (
                    <div className="flex items-center gap-2">
                        {!isActiveEnvironment && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleSetActiveEnvironment}
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
                    </div>
                )}
            </div>

            {/* Info Banner */}
            <div
                className={cn(
                    "px-4 py-2 text-xs border-b",
                    editorConfig.infoBg,
                    editorConfig.infoTextColor,
                    editorConfig.infoBorder
                )}
            >
                {editorConfig.infoText}
            </div>

            {/* Delete Confirmation (Environment only) */}
            {type === "environment" && showDeleteConfirm && environment && (
                <div className="px-4 py-3 bg-destructive/10 border-b border-destructive/20 flex items-center justify-between">
                    <span className="text-sm text-destructive">
                        Delete "{environment.name}"? This cannot be undone.
                    </span>
                    <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            size="sm"
                            onClick={handleDeleteEnvironment}
                            disabled={deleteEnvironmentMutation.isPending}
                        >
                            {deleteEnvironmentMutation.isPending ? "Deleting..." : "Delete"}
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
                                        onChange={(e) => {
                                            updateVariable(index, "enabled", e.target.checked);
                                            performSaveRef.current();
                                        }}
                                        className={cn("w-4 h-4 rounded border-input", editorConfig.checkboxColor)}
                                        disabled={variable.isNew && !variable.key}
                                    />
                                </td>
                                <td className="py-1 px-2">
                                    <Input
                                        type="text"
                                        value={variable.key}
                                        onChange={(e) => updateVariable(index, "key", e.target.value)}
                                        onFocus={handleFocus}
                                        onBlur={handleBlur}
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
                                        onChange={(e) => updateVariable(index, "value", e.target.value)}
                                        onFocus={handleFocus}
                                        onBlur={handleBlur}
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
                {variables.filter((v) => v.key && !v.isNew).length} variable(s)
            </div>
        </div>
    );
}
