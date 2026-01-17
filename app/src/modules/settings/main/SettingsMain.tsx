/**
 * Settings Main
 *
 * Displays the settings editor for the selected category.
 * Shows a form with all configurable entries for that category.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSettingsStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { useConfigQuery, useUpdateConfigMutation } from "@/queries";
import type { ConfigEntry, SettingsCategory } from "@/types";
import { Settings, Save, RotateCcw, Loader2, AlertCircle, AlertTriangle, RefreshCw, X } from "lucide-react";
import {
    Button,
    Input,
    Label,
    Switch,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Skeleton,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import UISettingsPanel from "./UISettingsPanel";
import { isSizeConfig, formatBytes, formatSizeRange } from "../utils/format-size";

/**
 * Check if a config entry requires a restart when changed
 * We detect this by checking if the label contains "(Requires Restart)"
 */
const isRestartRequired = (entry: ConfigEntry): boolean => {
    return entry.label.includes("(Requires Restart)") || entry.requiresRestart === true;
};

const CATEGORY_TITLES: Record<SettingsCategory, { title: string; description: string }> = {
    ui: {
        title: "Appearance",
        description: "Customize the look and feel of the application",
    },
    general_engine: {
        title: "General & Engine",
        description: "Core settings defining the application's base capacity and threading model",
    },
    network_performance: {
        title: "Network & Connectivity",
        description: "Low-level networking tuning for throughput, DNS, and connection persistence",
    },
    scripting_sandbox: {
        title: "Scripting Environment",
        description: "Configuration for the QuickJS sandbox execution, limits, and debugging",
    },
    observability: {
        title: "Observability & Data",
        description: "Settings for real-time dashboards (SSE), metrics aggregation, and data parsing limits",
    },
};

interface EditedValue {
    value: string;
    isValid: boolean;
    error?: string;
}

export default function SettingsMain() {
    const {
        selectedCategory,
        pendingRestart,
        restartRequiredKeys,
        addRestartRequiredKey,
        clearRestartRequired
    } = useSettingsStore();
    const { 
        startSaving, 
        completeSave, 
        failSave, 
        setStatus, 
        markPendingSave,
        registerContext,
        unregisterContext,
        setActiveContext,
        updateContext
    } = useSaveStore();
    const queryClient = useQueryClient();
    const { data: configResponse, isLoading, error } = useConfigQuery();
    const updateConfigMutation = useUpdateConfigMutation();

    // Track edited values locally
    const [editedValues, setEditedValues] = useState<Record<string, EditedValue>>({});
    const [isRestarting, setIsRestarting] = useState(false);
    
    // Ref for save function to avoid stale closures
    const handleSaveRef = useRef<(() => Promise<void>) | undefined>(undefined);

    // Filter entries by selected category (calculate before early returns)
    const categoryEntries =
        selectedCategory && configResponse?.entries
            ? configResponse.entries.filter((entry) => entry.category === selectedCategory)
            : [];
    const categoryConfig = selectedCategory ? CATEGORY_TITLES[selectedCategory] : null;

    // Check if there are unsaved changes (calculate before early returns)
    const hasChanges = Object.keys(editedValues).length > 0;
    const hasInvalidValues = Object.values(editedValues).some((v) => !v.isValid);

    // Reset edited values when category changes
    useEffect(() => {
        setEditedValues({});
    }, [selectedCategory]);

    // Mark as pending when there are unsaved changes
    // This hook must be called before any early returns to follow Rules of Hooks
    useEffect(() => {
        if (hasChanges && !hasInvalidValues) {
            markPendingSave("settings");
        } else {
            setStatus("idle");
        }
    }, [hasChanges, hasInvalidValues, markPendingSave, setStatus]);

    // Save changes - MUST be defined before early returns (Rules of Hooks)
    const handleSave = useCallback(async () => {
        if (hasInvalidValues || !hasChanges) return;

        const updates: Record<string, string> = {};
        const restartKeys: string[] = [];

        for (const [key, edited] of Object.entries(editedValues)) {
            updates[key] = edited.value;

            // Check if this config requires restart
            const entry = configResponse?.entries.find((e) => e.key === key);
            if (entry && isRestartRequired(entry)) {
                restartKeys.push(key);
            }
        }

        startSaving();
        try {
            await updateConfigMutation.mutateAsync({ entries: updates });
            setEditedValues({});
            completeSave();

            // Track restart-required configs
            for (const key of restartKeys) {
                addRestartRequiredKey(key);
            }

            // Reset to idle after showing "saved" status
            setTimeout(() => setStatus("idle"), 2000);
        } catch (err) {
            console.error("Failed to save settings:", err);
            failSave(err instanceof Error ? err.message : "Failed to save settings");
        }
    }, [
        hasInvalidValues,
        hasChanges,
        editedValues,
        configResponse,
        updateConfigMutation,
        startSaving,
        completeSave,
        failSave,
        setStatus,
        addRestartRequiredKey,
    ]);

    // Keep handleSave ref updated
    useEffect(() => {
        handleSaveRef.current = handleSave;
    }, [handleSave]);

    // Register save context when settings are ready (not loading, no error, category selected)
    const contextId = "settings";
    useEffect(() => {
        // Only register when we have a valid settings view (not loading, no error, category selected, not UI category)
        if (isLoading || error || !selectedCategory || selectedCategory === "ui") {
            return;
        }

        registerContext({
            id: contextId,
            name: "Settings",
            save: () => handleSaveRef.current?.() ?? Promise.resolve(),
            hasPendingChanges: hasChanges && !hasInvalidValues,
        });
        setActiveContext(contextId);

        return () => {
            unregisterContext(contextId);
        };
    }, [
        isLoading,
        error,
        selectedCategory,
        registerContext,
        unregisterContext,
        setActiveContext,
        hasChanges,
        hasInvalidValues,
    ]);

    // Update context when hasChanges changes
    useEffect(() => {
        if (isLoading || error || !selectedCategory || selectedCategory === "ui") {
            return;
        }
        updateContext(contextId, {
            hasPendingChanges: hasChanges && !hasInvalidValues,
            save: () => handleSaveRef.current?.() ?? Promise.resolve(),
        });
    }, [isLoading, error, selectedCategory, hasChanges, hasInvalidValues, updateContext]);

    if (!selectedCategory) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4 p-8">
                <Settings className="w-16 h-16 opacity-30" />
                <div className="text-center max-w-md">
                    <p className="text-lg font-medium">No Category Selected</p>
                    <p className="text-sm mt-2">
                        Select a category from the sidebar to view and edit settings
                    </p>
                </div>
            </div>
        );
    }

    // UI settings are handled by a separate panel (client-side only)
    if (selectedCategory === "ui") {
        return <UISettingsPanel />;
    }

    if (isLoading) {
        return (
            <div className="flex-1 p-6 space-y-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-4 w-96" />
                <div className="space-y-4 mt-6">
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-destructive gap-4 p-8">
                <AlertCircle className="w-12 h-12" />
                <div className="text-center">
                    <p className="text-lg font-medium">Failed to load settings</p>
                    <p className="text-sm mt-1 text-muted-foreground">
                        {error instanceof Error ? error.message : "Unknown error"}
                    </p>
                </div>
            </div>
        );
    }

    // Validate a value based on entry constraints
    const validateValue = (entry: ConfigEntry, value: string): { isValid: boolean; error?: string } => {
        if (entry.type === "integer" || entry.type === "number") {
            const num = entry.type === "integer" ? parseInt(value, 10) : parseFloat(value);
            if (isNaN(num)) {
                return { isValid: false, error: `Must be a valid ${entry.type}` };
            }
            if (entry.min !== undefined) {
                const min = parseFloat(entry.min);
                if (num < min) {
                    return { isValid: false, error: `Must be at least ${min}` };
                }
            }
            if (entry.max !== undefined) {
                const max = parseFloat(entry.max);
                if (num > max) {
                    return { isValid: false, error: `Must be at most ${max}` };
                }
            }
        }
        return { isValid: true };
    };

    // Get current value (edited or original)
    const getCurrentValue = (entry: ConfigEntry): string => {
        const edited = editedValues[entry.key];
        return edited ? edited.value : entry.value;
    };

    // Get formatted size for display (suffix/helper text)
    const getFormattedSize = (entry: ConfigEntry): string | null => {
        if (!isSizeConfig(entry.key)) return null;
        const value = getCurrentValue(entry);
        const bytes = parseInt(value, 10);
        if (isNaN(bytes)) return null;
        return formatBytes(bytes);
    };

    // Handle value change
    const handleValueChange = (entry: ConfigEntry, newValue: string) => {
        const validation = validateValue(entry, newValue);
        setEditedValues((prev) => ({
            ...prev,
            [entry.key]: {
                value: newValue,
                isValid: validation.isValid,
                error: validation.error,
            },
        }));
    };

    // Handle boolean toggle
    const handleBooleanToggle = (entry: ConfigEntry, checked: boolean) => {
        setEditedValues((prev) => ({
            ...prev,
            [entry.key]: {
                value: checked ? "true" : "false",
                isValid: true,
            },
        }));
    };

    // Reset a single value
    const handleReset = (entry: ConfigEntry) => {
        setEditedValues((prev) => {
            const next = { ...prev };
            delete next[entry.key];
            return next;
        });
    };

    // Reset to defaults
    const handleResetToDefaults = () => {
        const defaultValues: Record<string, EditedValue> = {};
        for (const entry of categoryEntries) {
            if (entry.value !== entry.default) {
                defaultValues[entry.key] = {
                    value: entry.default,
                    isValid: true,
                };
            }
        }
        setEditedValues(defaultValues);
    };


    // Get labels for restart-required keys
    const getRestartRequiredLabels = (): string[] => {
        if (!configResponse?.entries) return restartRequiredKeys;
        return restartRequiredKeys.map((key) => {
            const entry = configResponse.entries.find((e) => e.key === key);
            return entry?.label.replace(" (Requires Restart)", "") || key;
        });
    };

    return (
        <div className="flex-1 flex flex-col overflow-hidden">
            {/* Restart Required Banner */}
            {pendingRestart && (
                <div className="bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 px-6 py-3 shrink-0">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-900/50">
                                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                                    Engine restart required
                                </p>
                                <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                                    Changes to{" "}
                                    <span className="font-medium">
                                        {getRestartRequiredLabels().join(", ")}
                                    </span>{" "}
                                    will take effect after restarting the engine
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={clearRestartRequired}
                                className="border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/50"
                            >
                                <X className="w-4 h-4 mr-1.5" />
                                Dismiss
                            </Button>
                            <Button
                                size="sm"
                                className="bg-amber-600 hover:bg-amber-700 text-white"
                                disabled={isRestarting}
                                onClick={async () => {
                                    if (window.electronAPI) {
                                        setIsRestarting(true);
                                        try {
                                            const result = await window.electronAPI.restartEngine();
                                            if (result.success) {
                                                // Wait a moment for engine to fully initialize
                                                await new Promise((resolve) => setTimeout(resolve, 1500));
                                                // Invalidate all queries to refresh data from the new engine instance
                                                await queryClient.invalidateQueries();
                                                clearRestartRequired();
                                            } else {
                                                window.alert(`Failed to restart engine: ${result.error}`);
                                            }
                                        } finally {
                                            setIsRestarting(false);
                                        }
                                    } else {
                                        // Running in browser (dev mode without electron)
                                        window.alert("Engine restart is only available in the desktop app. Please restart the engine manually.");
                                    }
                                }}
                            >
                                {isRestarting ? (
                                    <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                                ) : (
                                    <RefreshCw className="w-4 h-4 mr-1.5" />
                                )}
                                {isRestarting ? "Restarting..." : "Restart Engine"}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div className="border-b border-border px-6 py-4 shrink-0">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-xl font-semibold">{categoryConfig?.title}</h1>
                        <p className="text-sm text-muted-foreground mt-1">{categoryConfig?.description}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleResetToDefaults}
                            disabled={updateConfigMutation.isPending}
                        >
                            <RotateCcw className="w-4 h-4 mr-1.5" />
                            Reset to Defaults
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleSave}
                            disabled={!hasChanges || hasInvalidValues || updateConfigMutation.isPending}
                        >
                            {updateConfigMutation.isPending ? (
                                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                            ) : (
                                <Save className="w-4 h-4 mr-1.5" />
                            )}
                            Save Changes
                        </Button>
                    </div>
                </div>
            </div>

            {/* Settings Grid */}
            <div className="flex-1 overflow-auto p-6">
                <div className="grid gap-4 max-w-3xl">
                    {categoryEntries.map((entry) => {
                        const currentValue = getCurrentValue(entry);
                        const edited = editedValues[entry.key];
                        const isModified = edited !== undefined;
                        const hasError = edited?.error;
                        const needsRestart = isRestartRequired(entry);
                        const isPendingRestart = restartRequiredKeys.includes(entry.key);

                        return (
                            <Card
                                key={entry.key}
                                className={cn(
                                    "transition-colors",
                                    isModified && !hasError && "border-primary/50",
                                    hasError && "border-destructive/50",
                                    isPendingRestart && "border-amber-400/50 bg-amber-50/30 dark:bg-amber-950/10"
                                )}
                            >
                                <CardHeader className="pb-3">
                                    <div className="flex items-start justify-between">
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <CardTitle className="text-base">
                                                    {entry.label.replace(" (Requires Restart)", "")}
                                                </CardTitle>
                                                {needsRestart && (
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                                                        <RefreshCw className="w-2.5 h-2.5" />
                                                        Restart Required
                                                    </span>
                                                )}
                                                {isPendingRestart && (
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500 text-white">
                                                        Pending
                                                    </span>
                                                )}
                                            </div>
                                            <CardDescription className="mt-1">{entry.description}</CardDescription>
                                        </div>
                                        {isModified && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleReset(entry)}
                                                className="text-xs h-7 px-2"
                                            >
                                                Reset
                                            </Button>
                                        )}
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    {entry.type === "boolean" ? (
                                        <div className="flex items-center gap-3">
                                            <Switch
                                                checked={currentValue === "true"}
                                                onCheckedChange={(checked) => handleBooleanToggle(entry, checked)}
                                            />
                                            <Label className="text-sm text-muted-foreground">
                                                {currentValue === "true" ? "Enabled" : "Disabled"}
                                            </Label>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            <div className="flex items-center gap-2">
                                                    <div className="relative">
                                                        <Input
                                                            type={entry.type === "integer" || entry.type === "number" ? "number" : "text"}
                                                            value={currentValue}
                                                            onChange={(e) => handleValueChange(entry, e.target.value)}
                                                            className={cn("max-w-xs", hasError && "border-destructive", isSizeConfig(entry.key) && "pr-16")}
                                                            placeholder={isSizeConfig(entry.key) ? "Enter bytes" : undefined}
                                                            min={entry.min}
                                                            max={entry.max}
                                                        />
                                                        {isSizeConfig(entry.key) && getFormattedSize(entry) && (
                                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                                                                {getFormattedSize(entry)}
                                                            </span>
                                                        )}
                                                    </div>
                                                    {(entry.min || entry.max) && (
                                                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                                                            {isSizeConfig(entry.key) ? (
                                                                formatSizeRange(entry.min, entry.max) || ""
                                                            ) : (
                                                                entry.min && entry.max
                                                                    ? `${entry.min} - ${entry.max}`
                                                                    : entry.min
                                                                        ? `Min: ${entry.min}`
                                                                        : `Max: ${entry.max}`
                                                            )}
                                                    </span>
                                                )}
                                            </div>
                                            {hasError && (
                                                <p className="text-xs text-destructive">{edited.error}</p>
                                            )}
                                            {currentValue !== entry.default && (
                                                <p className="text-xs text-muted-foreground">
                                                        Default: {isSizeConfig(entry.key)
                                                            ? formatBytes(parseInt(entry.default, 10) || 0)
                                                            : entry.default}
                                                </p>
                                            )}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
