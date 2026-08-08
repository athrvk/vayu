/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Settings Main
 *
 * Displays the settings editor for the selected category.
 * Shows a form with all configurable entries for that category.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEngineStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { useConfigQuery, useUpdateConfigMutation } from "@/queries";
import type { ConfigEntry, EngineSettingsCategory } from "@/types";
import {
	Settings,
	Save,
	RotateCcw,
	Loader2,
	AlertCircle,
	AlertTriangle,
	RefreshCw,
	X,
} from "lucide-react";
import {
	Button,
	Input,
	Label,
	Switch,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
} from "@/components/ui";
import { EmptyState } from "@/components/shared";
import { cn } from "@/lib/utils";
import ClientSettingsPanel from "./panels/ClientSettingsPanel";
import { getAppPanel, isClientCategory } from "./app-panels";
import { isSizeConfig, formatBytes, formatSizeRange } from "../utils/format-size";
import { TIMING } from "@/config/timing";

/**
 * Check if a config entry requires a restart when changed
 *
 * The label is the only signal the engine sends: it writes "(Requires Restart)"
 * into the label itself (`engine/src/db/database.cpp`). A second `requiresRestart`
 * boolean was checked here and typed on `ConfigEntry`, but nothing has ever
 * written it - the MCP tool surface carried the same dead check.
 */
const isRestartRequired = (entry: ConfigEntry): boolean => {
	return entry.label.includes("(Requires Restart)");
};

// Client (app) categories render their own header via ClientSettingsPanel; only
// the engine categories are titled here (this map drives the engine config view).
const CATEGORY_TITLES: Record<EngineSettingsCategory, { title: string; description: string }> = {
	general_engine: {
		title: "General & Engine",
		description: "Core settings defining the application's base capacity and threading model",
	},
	database_performance: {
		title: "Database Performance",
		description:
			"SQLite optimization settings for high-throughput load testing and result storage",
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
		description:
			"Settings for real-time dashboards (SSE), metrics aggregation, and data parsing limits",
	},
};

interface EditedValue {
	value: string;
	isValid: boolean;
	error?: string;
}

export default function SettingsMain() {
	const { selectedCategory } = useSettingsStore();
	const { pendingRestart, restartRequiredKeys, addRestartRequiredKey, clearRestartRequired } =
		useEngineStore();
	const {
		startSaving,
		completeSaveThenIdle,
		failSave,
		setStatus,
		markPendingSave,
		registerContext,
		unregisterContext,
		setActiveContext,
		updateContext,
	} = useSaveStore();
	const queryClient = useQueryClient();
	const { data: configResponse, isLoading, error } = useConfigQuery();
	const updateConfigMutation = useUpdateConfigMutation();

	// Track edited values locally
	const [editedValues, setEditedValues] = useState<Record<string, EditedValue>>({});
	const [isRestarting, setIsRestarting] = useState(false);

	// Refs for the save function and the live edits, so the category-switch
	// cleanup below can flush without either becoming one of its dependencies.
	const handleSaveRef = useRef<(() => Promise<void>) | undefined>(undefined);
	const saveEntriesRef = useRef<
		((entries: Record<string, EditedValue>) => Promise<void>) | undefined
	>(undefined);
	const editedValuesRef = useRef(editedValues);
	// Whether the `pending` status on the Dock is one this panel put there. The
	// unconditional `setStatus("idle")` this replaces ran on mount and on every
	// clean render, so merely opening Settings wiped an `error` another context
	// had just published.
	const markedPendingRef = useRef(false);

	// Filter entries by selected category (calculate before early returns)
	const categoryEntries =
		selectedCategory && configResponse?.entries
			? configResponse.entries
					.filter((entry) => entry.category === selectedCategory)
					.sort((a, b) => a.key.localeCompare(b.key))
			: [];
	const categoryConfig =
		selectedCategory && !isClientCategory(selectedCategory)
			? CATEGORY_TITLES[selectedCategory]
			: null;

	// Check if there are unsaved changes (calculate before early returns)
	const hasChanges = Object.keys(editedValues).length > 0;
	const hasInvalidValues = Object.values(editedValues).some((v) => !v.isValid);

	useEffect(() => {
		editedValuesRef.current = editedValues;
	});

	// Mark as pending when there are unsaved changes
	// This hook must be called before any early returns to follow Rules of Hooks
	useEffect(() => {
		if (hasChanges && !hasInvalidValues) {
			markedPendingRef.current = true;
			markPendingSave();
			return;
		}
		// Only clear a status this panel set. Anything else on screen - another
		// context's `error`, or the `saved` a successful save here just
		// published - is not ours to overwrite.
		if (markedPendingRef.current) {
			markedPendingRef.current = false;
			setStatus("idle");
		}
	}, [hasChanges, hasInvalidValues, markPendingSave, setStatus]);

	/**
	 * Persist an explicit set of edits.
	 *
	 * Split out from `handleSave` because the category-switch flush below saves
	 * the edits captured at the moment of the switch, not whatever is in state by
	 * the time the write lands. Invalid entries are dropped here rather than
	 * refused: `handleSave` still refuses the whole batch (the Save button is
	 * disabled while any value is invalid and the inline error says why), but a
	 * flush has no screen left to show that error on, so it saves what it can.
	 */
	const saveEntries = useCallback(
		async (entries: Record<string, EditedValue>) => {
			const updates: Record<string, string> = {};
			const restartKeys: string[] = [];

			for (const [key, edited] of Object.entries(entries)) {
				if (!edited.isValid) continue;
				updates[key] = edited.value;

				// Check if this config requires restart
				const entry = configResponse?.entries.find((e) => e.key === key);
				if (entry && isRestartRequired(entry)) {
					restartKeys.push(key);
				}
			}
			if (Object.keys(updates).length === 0) return;

			// From here the status sequence (saving -> saved -> idle) is this
			// function's; the pending effect above must keep its hands off it, or
			// a category switch would idle away the "saving" it just started.
			markedPendingRef.current = false;
			startSaving();
			try {
				await updateConfigMutation.mutateAsync({ entries: updates });
				// Clear only what this write actually persisted, and only where the
				// value is still the one that was written. A category switch flushes
				// asynchronously, so the user can be typing in the *next* category
				// by the time this resolves - clearing wholesale took those edits
				// with it.
				setEditedValues((prev) => {
					const next = { ...prev };
					for (const key of Object.keys(updates)) {
						if (next[key]?.value === updates[key]) delete next[key];
					}
					return next;
				});
				completeSaveThenIdle();

				// Track restart-required configs
				for (const key of restartKeys) {
					addRestartRequiredKey(key);
				}
			} catch (err) {
				console.error("Failed to save settings:", err);
				failSave(err instanceof Error ? err.message : "Failed to save settings");
			}
		},
		[
			configResponse,
			updateConfigMutation,
			startSaving,
			completeSaveThenIdle,
			failSave,
			addRestartRequiredKey,
		]
	);

	// Save changes - MUST be defined before early returns (Rules of Hooks)
	const handleSave = useCallback(async () => {
		if (hasInvalidValues || !hasChanges) return;
		await saveEntries(editedValues);
	}, [hasInvalidValues, hasChanges, editedValues, saveEntries]);

	useEffect(() => {
		saveEntriesRef.current = saveEntries;
	}, [saveEntries]);

	/**
	 * Leaving a category saves its edits instead of dropping them.
	 *
	 * This effect used to be a bare `setEditedValues({})`: picking another
	 * category in the sidebar - or navigating away from Settings entirely, which
	 * runs the same cleanup - discarded whatever had been typed, with no save, no
	 * prompt, and nothing on screen to say it had happened. Engine settings are
	 * cheap merge-patches, so they are saved rather than confirmed; the switch is
	 * not itself a destructive act.
	 *
	 * The cleanup reads the edits through a ref because it runs before this
	 * commit's effect bodies, so the ref still holds the *outgoing* category's
	 * values - which is exactly what needs writing.
	 */
	const [editedCategory, setEditedCategory] = useState(selectedCategory);
	if (editedCategory !== selectedCategory) {
		// Dropping the outgoing category's edits belongs to the category change
		// itself, so it is adjusted here rather than in the effect below - which
		// keeps the flush in the cleanup, where the ref still holds those edits.
		setEditedCategory(selectedCategory);
		setEditedValues({});
	}

	useEffect(() => {
		return () => {
			const pending = editedValuesRef.current;
			if (Object.keys(pending).length > 0) void saveEntriesRef.current?.(pending);
		};
	}, [selectedCategory]);

	// Keep handleSave ref updated
	useEffect(() => {
		handleSaveRef.current = handleSave;
	}, [handleSave]);

	// Register save context when settings are ready (not loading, no error, category selected)
	const contextId = "settings";
	useEffect(() => {
		// Only register when we have a valid settings view (not loading, no error, category selected, not a client-side category)
		if (isLoading || error || !selectedCategory || isClientCategory(selectedCategory)) {
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
		if (isLoading || error || !selectedCategory || isClientCategory(selectedCategory)) {
			return;
		}
		updateContext(contextId, {
			hasPendingChanges: hasChanges && !hasInvalidValues,
			save: () => handleSaveRef.current?.() ?? Promise.resolve(),
		});
	}, [isLoading, error, selectedCategory, hasChanges, hasInvalidValues, updateContext]);

	if (!selectedCategory) {
		return (
			<EmptyState
				icon={Settings}
				title="No category selected"
				description="Pick a category from the sidebar to edit its settings."
			/>
		);
	}

	// Client (app) categories are rendered by their registered panel, wrapped in
	// the shared shell (no Save/Reset bar - these prefs auto-persist).
	const appPanel = getAppPanel(selectedCategory);
	if (appPanel) {
		const Panel = appPanel.Component;
		return (
			<ClientSettingsPanel title={appPanel.label} description={appPanel.description}>
				<Panel />
			</ClientSettingsPanel>
		);
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
			<div className="flex-1 flex flex-col items-center justify-center text-destructive-text gap-4 p-8">
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
	const validateValue = (
		entry: ConfigEntry,
		value: string
	): { isValid: boolean; error?: string } => {
		if (entry.type === "enum") {
			// The value comes from a Select populated with `entry.options`, so it
			// is never free text - no numeric parsing applies here, unlike the
			// integer/number branch below.
			return { isValid: true };
		}
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
					<div className="flex items-center justify-between max-w-3xl mx-auto w-full">
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
												await new Promise((resolve) =>
													setTimeout(
														resolve,
														TIMING.ENGINE_RESTART_WAIT_MS
													)
												);
												// Invalidate all queries to refresh data from the new engine instance
												await queryClient.invalidateQueries();
												clearRestartRequired();
											} else {
												window.alert(
													`Failed to restart engine: ${result.error}`
												);
											}
										} finally {
											setIsRestarting(false);
										}
									} else {
										// Running in browser (dev mode without electron)
										window.alert(
											"Engine restart is only available in the desktop app. Please restart the engine manually."
										);
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
				<div className="flex items-center justify-between max-w-3xl mx-auto w-full">
					<div>
						<h1 className="text-xl font-semibold">{categoryConfig?.title}</h1>
						<p className="text-sm text-muted-foreground mt-1">
							{categoryConfig?.description}
						</p>
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
							disabled={
								!hasChanges || hasInvalidValues || updateConfigMutation.isPending
							}
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
				<div className="grid gap-4 max-w-3xl mx-auto">
					{categoryEntries.map((entry) => {
						const currentValue = getCurrentValue(entry);
						const edited = editedValues[entry.key];
						const isModified = edited !== undefined;
						const hasError = edited?.error;
						// Per entry, so `aria-describedby` never points at another
						// setting's message - and only rendered when there is one,
						// so the reference is never dangling.
						const errorId = `setting-${entry.key}-error`;
						const needsRestart = isRestartRequired(entry);
						const isPendingRestart = restartRequiredKeys.includes(entry.key);

						return (
							<Card
								key={entry.key}
								className={cn(
									"transition-colors",
									isModified && !hasError && "border-primary/50",
									hasError && "border-destructive/50",
									isPendingRestart &&
										"border-amber-400/50 bg-amber-50/30 dark:bg-amber-950/10"
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
													<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
														<RefreshCw className="w-2.5 h-2.5" />
														Restart Required
													</span>
												)}
												{isPendingRestart && (
													/*
													 * White on a solid `amber-500` measured 2.14 - the
													 * worst text contrast in the app, and at 10px. It
													 * failed in *both* themes, because a raw palette
													 * fill and white are the same two colours whatever
													 * the surface underneath.
													 *
													 * Now the wash pattern the sibling "Restart
													 * Required" chip beside it already uses, on warning
													 * tokens: 4.87 light / 7.45 dark. It keeps a
													 * stronger border than that sibling so the two stay
													 * distinguishable - "Pending" is the more urgent of
													 * the pair and should not read as identical.
													 */
													<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-warning/50 bg-warning/15 text-[10px] font-medium text-warning-text">
														Pending
													</span>
												)}
											</div>
											<CardDescription className="mt-1">
												{entry.description}
											</CardDescription>
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
												onCheckedChange={(checked) =>
													handleBooleanToggle(entry, checked)
												}
												// The setting's name lives in the CardTitle above
												// and is not associated with the control, so
												// without this the switch announced as a bare
												// "switch" - and every engine setting renders
												// one of these.
												aria-label={entry.label}
											/>
											<Label className="text-sm text-muted-foreground">
												{currentValue === "true" ? "Enabled" : "Disabled"}
											</Label>
										</div>
									) : entry.type === "enum" ? (
										// The engine omits `options` entirely when a stored row's
										// options fail to parse (logged there, not here) - render
										// nothing rather than a select with no items, and never
										// fall back to a label map kept in this file: labels come
										// from the payload so the two sides of the boundary cannot
										// drift apart.
										entry.options && entry.options.length > 0 ? (
											<Select
												value={currentValue}
												onValueChange={(value) =>
													handleValueChange(entry, value)
												}
											>
												<SelectTrigger
													className="max-w-xs"
													aria-label={entry.label}
												>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{entry.options.map((option) => (
														<SelectItem
															key={option.value}
															value={option.value}
														>
															{option.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										) : null
									) : (
										<div className="space-y-2">
											<div className="flex items-center gap-2">
												<div className="relative">
													<Input
														type={
															entry.type === "integer" ||
															entry.type === "number"
																? "number"
																: "text"
														}
														value={currentValue}
														onChange={(e) =>
															handleValueChange(entry, e.target.value)
														}
														className={cn(
															"max-w-xs",
															hasError && "border-destructive",
															isSizeConfig(entry.key) && "pr-16"
														)}
														placeholder={
															isSizeConfig(entry.key)
																? "Enter bytes"
																: undefined
														}
														// Same as the Switch above: the name is in
														// the CardTitle, which nothing links to this
														// input.
														aria-label={entry.label}
														/*
														 * Out-of-range values were signalled by a
														 * red border and a line of text sitting
														 * loose beside the field - colour alone,
														 * and a message the field did not point
														 * at. `aria-invalid` states it, and
														 * `aria-describedby` reads the reason out
														 * with the field instead of leaving it to
														 * be found.
														 *
														 * `|| undefined` so valid fields carry no
														 * attribute at all, rather than a
														 * misleading aria-invalid="false" on every
														 * setting on the screen.
														 */
														aria-invalid={hasError ? true : undefined}
														aria-describedby={
															hasError ? errorId : undefined
														}
														min={entry.min}
														max={entry.max}
													/>
													{isSizeConfig(entry.key) &&
														getFormattedSize(entry) && (
															<span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
																{getFormattedSize(entry)}
															</span>
														)}
												</div>
												{(entry.min || entry.max) && (
													<span className="text-xs text-muted-foreground whitespace-nowrap">
														{isSizeConfig(entry.key)
															? formatSizeRange(
																	entry.min,
																	entry.max
																) || ""
															: entry.min && entry.max
																? `${entry.min} - ${entry.max}`
																: entry.min
																	? `Min: ${entry.min}`
																	: `Max: ${entry.max}`}
													</span>
												)}
											</div>
											{hasError && (
												<p
													id={errorId}
													className="text-xs text-destructive-text"
												>
													{edited.error}
												</p>
											)}
											{currentValue !== entry.default && (
												<p className="text-xs text-muted-foreground">
													Default:{" "}
													{isSizeConfig(entry.key)
														? formatBytes(
																parseInt(entry.default, 10) || 0
															)
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
