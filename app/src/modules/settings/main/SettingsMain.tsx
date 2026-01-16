/**
 * Settings Main
 *
 * Displays the settings editor for the selected category.
 * Shows a form with all configurable entries for that category.
 */

import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSettingsStore } from "@/stores";
import { useConfigQuery, useUpdateConfigMutation } from "@/queries";
import type { ConfigEntry, SettingsCategory } from "@/types";
import { Settings, Save, RotateCcw, Loader2, CheckCircle2, AlertCircle, AlertTriangle, RefreshCw, X } from "lucide-react";
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
import { isSizeConfig, formatBytes, parseSizeToBytes, formatSizeRange } from "../utils/format-size";

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
    server: {
        title: "Server Settings",
        description: "Configure server behavior, timeouts, and connection settings",
    },
    scripting: {
        title: "Scripting Settings",
        description: "Configure JavaScript script execution limits and behavior",
    },
    performance: {
        title: "Performance Settings",
        description: "Tune performance parameters for load testing and data processing",
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
    const queryClient = useQueryClient();
    const { data: configResponse, isLoading, error } = useConfigQuery();
    const updateConfigMutation = useUpdateConfigMutation();

    // Track edited values locally
    const [editedValues, setEditedValues] = useState<Record<string, EditedValue>>({});
    const [saveSuccess, setSaveSuccess] = useState(false);
    const [isRestarting, setIsRestarting] = useState(false);

    // Reset edited values when category changes
    useEffect(() => {
        setEditedValues({});
        setSaveSuccess(false);
    }, [selectedCategory]);

    // Clear success message after 3 seconds
    useEffect(() => {
        if (saveSuccess) {
            const timer = setTimeout(() => setSaveSuccess(false), 3000);
            return () => clearTimeout(timer);
        }
    }, [saveSuccess]);

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

    // Filter entries by selected category
    const categoryEntries =
        configResponse?.entries.filter((entry) => entry.category === selectedCategory) || [];

    const categoryConfig = CATEGORY_TITLES[selectedCategory];

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

    // Get current value (edited or original) - formatted for size configs
    const getCurrentValue = (entry: ConfigEntry): string => {
        const edited = editedValues[entry.key];
        const rawValue = edited ? edited.value : entry.value;

        // For size configs, format for display
        if (isSizeConfig(entry.key)) {
            const bytes = parseInt(rawValue, 10);
            if (!isNaN(bytes)) {
                return formatBytes(bytes);
            }
        }

        return rawValue;
    };

    // Handle value change
    const handleValueChange = (entry: ConfigEntry, newValue: string) => {
        let processedValue = newValue;
        let validation: { isValid: boolean; error?: string } = { isValid: true };

        // For size configs, parse human-readable format
        if (isSizeConfig(entry.key)) {
            const parsed = parseSizeToBytes(newValue);
            if (parsed === null) {
                // Try parsing as raw bytes as fallback
                const bytes = parseInt(newValue, 10);
                if (isNaN(bytes)) {
                    validation = {
                        isValid: false,
                        error: "Invalid format. Use bytes (e.g., 67108864) or human-readable (e.g., 64 MB)",
                    };
                } else {
                    processedValue = bytes.toString();
                }
            } else {
                processedValue = parsed.toString();
            }
        }

        // Validate the processed value
        if (validation.isValid) {
            const valResult = validateValue(entry, processedValue);
            validation = valResult;
            // Format error messages for size configs
            if (!validation.isValid && isSizeConfig(entry.key) && validation.error) {
                if (entry.min && validation.error.includes("at least")) {
                    const minBytes = parseInt(entry.min, 10);
                    if (!isNaN(minBytes)) {
                        validation.error = `Must be at least ${formatBytes(minBytes)}`;
                    }
                }
                if (entry.max && validation.error.includes("at most")) {
                    const maxBytes = parseInt(entry.max, 10);
                    if (!isNaN(maxBytes)) {
                        validation.error = `Must be at most ${formatBytes(maxBytes)}`;
                    }
                }
            }
        }

        setEditedValues((prev) => ({
            ...prev,
            [entry.key]: {
                value: processedValue,
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

    // Check if there are unsaved changes
    const hasChanges = Object.keys(editedValues).length > 0;
    const hasInvalidValues = Object.values(editedValues).some((v) => !v.isValid);

    // Save changes
    const handleSave = async () => {
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

        try {
            await updateConfigMutation.mutateAsync({ entries: updates });
            setEditedValues({});
            setSaveSuccess(true);

            // Track restart-required configs
            for (const key of restartKeys) {
                addRestartRequiredKey(key);
            }
        } catch (err) {
            console.error("Failed to save settings:", err);
        }
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
                        <h1 className="text-xl font-semibold">{categoryConfig.title}</h1>
                        <p className="text-sm text-muted-foreground mt-1">{categoryConfig.description}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        {saveSuccess && (
                            <div className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
                                <CheckCircle2 className="w-4 h-4" />
                                <span>Saved</span>
                            </div>
                        )}
                        {updateConfigMutation.isError && (
                            <div className="flex items-center gap-1.5 text-sm text-destructive">
                                <AlertCircle className="w-4 h-4" />
                                <span>Failed to save</span>
                            </div>
                        )}
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
                                                <Input
                                                        type={isSizeConfig(entry.key) ? "text" : (entry.type === "integer" || entry.type === "number" ? "number" : "text")}
                                                    value={currentValue}
                                                    onChange={(e) => handleValueChange(entry, e.target.value)}
                                                    className={cn("max-w-xs", hasError && "border-destructive")}
                                                        placeholder={isSizeConfig(entry.key) ? "e.g., 64 MB or 67108864" : undefined}
                                                        min={entry.min && !isSizeConfig(entry.key) ? entry.min : undefined}
                                                        max={entry.max && !isSizeConfig(entry.key) ? entry.max : undefined}
                                                />
                                                    {isSizeConfig(entry.key) ? (
                                                        <span className="text-xs text-muted-foreground">
                                                            {formatSizeRange(entry.min, entry.max) || ""}
                                                        </span>
                                                    ) : (entry.min || entry.max) && (
                                                    <span className="text-xs text-muted-foreground">
                                                        {entry.min && entry.max
                                                            ? `${entry.min} - ${entry.max}`
                                                            : entry.min
                                                                ? `Min: ${entry.min}`
                                                                : `Max: ${entry.max}`}
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
