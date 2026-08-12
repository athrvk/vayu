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

/* global setTimeout, clearTimeout */

import { useState, useEffect, useRef, useCallback } from "react";
import { useEngineStore, useToastStore } from "@/stores";
import { useSaveStore } from "@/stores/save-store";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { useConfigQuery, useUpdateConfigMutation } from "@/queries";
import type { ConfigEntry } from "@/types";
import {
	Settings,
	Save,
	RotateCcw,
	Loader2,
	AlertCircle,
	ChevronRight,
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
import { DefaultValueLine, NumberSettingRow } from "./panels/SettingControls";
import { DEFAULT_SAVE_NOTE, getAppPanel, isClientCategory } from "./app-panels";
import { getEngineCategory } from "../engine-categories";
import { isSizeConfig, formatBytes, formatSizeRange } from "../utils/format-size";
import { useEngineRestart } from "@/hooks/useEngineRestart";

/** Stated beside the Save bar, so the engine view's save model is on screen too. */
const ENGINE_SAVE_NOTE = "Changes are staged here and written when you save.";

/** How long a searched-for setting stays outlined after the view scrolls to it. */
const HIGHLIGHT_MS = 2500;

/**
 * Check if a config entry requires a restart when changed
 *
 * `requiresRestart` is a typed field the engine serializes on every entry
 * (`engine/src/http/routes/config.cpp`). It replaced a "(Requires Restart)"
 * substring in the label, parsed here and again in the MCP tool surface - which
 * meant one stale label lied to both consumers at once, and said it three times
 * per card (suffix, chip, closing description sentence). The chip below is now
 * the single statement.
 */
const isRestartRequired = (entry: ConfigEntry): boolean => entry.requiresRestart;

interface EditedValue {
	value: string;
	isValid: boolean;
	error?: string;
}

/**
 * The banner over the settings list once a restart-required value is saved.
 *
 * Its own component so the restart machinery - the action, and the cache
 * invalidation that follows it - is mounted only while the banner is on
 * screen, the same split the Dock's pending signal uses. It shares that one
 * action through `useEngineRestart`; the two used to be a copy each.
 */
function RestartRequiredBanner({ labels, onDismiss }: { labels: string[]; onDismiss: () => void }) {
	const { restart, isRestarting } = useEngineRestart();

	return (
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
							Changes to <span className="font-medium">{labels.join(", ")}</span> will
							take effect after restarting the engine
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={onDismiss}
						className="border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-900/50"
					>
						<X className="w-4 h-4 mr-1.5" />
						Dismiss
					</Button>
					<Button
						size="sm"
						className="bg-amber-600 hover:bg-amber-700 text-white"
						disabled={isRestarting}
						onClick={() => void restart()}
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
	);
}

export default function SettingsMain() {
	const { selectedCategory, highlightedKey, clearHighlight } = useSettingsStore();
	const { pendingRestart, restartRequiredKeys, addRestartRequiredKey, clearRestartRequired } =
		useEngineStore();
	const showToast = useToastStore((s) => s.showToast);
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
	const { data: configResponse, isLoading, error } = useConfigQuery();
	const updateConfigMutation = useUpdateConfigMutation();

	// Track edited values locally
	const [editedValues, setEditedValues] = useState<Record<string, EditedValue>>({});
	// Deliberately not persisted: the group is meant to be rediscovered rather
	// than left open from a session the user has forgotten about.
	const [advancedOpen, setAdvancedOpen] = useState(false);

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

	/*
	 * Filter entries by selected category (calculate before early returns).
	 *
	 * Sorted by label, not by key: the key is an internal name, so key order put
	 * `dbBusyTimeout` next to `dbCacheSize` but `maxScenarioSteps` nowhere near
	 * `maxStepsPerIteration`. Seed insertion order was the other candidate and
	 * cannot be trusted - the engine writes a changed setting with
	 * `INSERT OR REPLACE` (`Database::set_config`), which assigns the row a new
	 * rowid, so saving one value would reshuffle the screen.
	 */
	const categoryEntries =
		selectedCategory && configResponse?.entries
			? configResponse.entries
					.filter((entry) => entry.category === selectedCategory)
					.sort((a, b) => a.label.localeCompare(b.label))
			: [];
	// The engine marks its internals - a lock pragma, a watchdog's backoff -
	// with `advanced`. They stay reachable, but below the settings people
	// actually tune rather than interleaved with them by key order.
	const primaryEntries = categoryEntries.filter((entry) => !entry.advanced);
	const advancedEntries = categoryEntries.filter((entry) => entry.advanced);
	const categoryConfig = isClientCategory(selectedCategory)
		? undefined
		: getEngineCategory(selectedCategory);

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
	 * flush has no screen left to show that error on, so it saves what it can -
	 * and says so, because a value that was typed and then vanished with no
	 * explanation is the silent discard this replaces.
	 */
	const saveEntries = useCallback(
		async (entries: Record<string, EditedValue>) => {
			const updates: Record<string, string> = {};
			const restartKeys: string[] = [];
			let discarded = 0;

			for (const [key, edited] of Object.entries(entries)) {
				if (!edited.isValid) {
					discarded++;
					continue;
				}
				updates[key] = edited.value;

				// Check if this config requires restart
				const entry = configResponse?.entries.find((e) => e.key === key);
				if (entry && isRestartRequired(entry)) {
					restartKeys.push(key);
				}
			}
			if (discarded > 0) {
				showToast(
					`${discarded} invalid change${discarded === 1 ? " was" : "s were"} discarded.`,
					"warning"
				);
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
			showToast,
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
		setAdvancedOpen(false);
	}

	useEffect(() => {
		return () => {
			const pending = editedValuesRef.current;
			if (Object.keys(pending).length > 0) void saveEntriesRef.current?.(pending);
		};
	}, [selectedCategory]);

	/*
	 * Reveal the entry a sidebar search result picked.
	 *
	 * An entry inside the collapsed Advanced group has to be uncollapsed to be
	 * revealed at all, which is derived rather than pushed into state: a
	 * `setAdvancedOpen` here would fight the category switch that closes it.
	 */
	const highlightedRef = useRef<HTMLDivElement | null>(null);
	const highlightedIsAdvanced =
		highlightedKey !== null && advancedEntries.some((entry) => entry.key === highlightedKey);
	const showAdvanced = advancedOpen || highlightedIsAdvanced;

	useEffect(() => {
		if (!highlightedKey) return;
		// jsdom has no layout and does not implement this, hence the optional call.
		highlightedRef.current?.scrollIntoView?.({ block: "center" });
		const timer = setTimeout(clearHighlight, HIGHLIGHT_MS);
		return () => clearTimeout(timer);
	}, [highlightedKey, clearHighlight]);

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
			<ClientSettingsPanel
				title={appPanel.label}
				description={appPanel.description}
				saveNote={appPanel.saveNote ?? DEFAULT_SAVE_NOTE}
			>
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

	/**
	 * Drop a staged edit, putting the field back to the saved value.
	 *
	 * Called Revert on screen. It used to be called Reset, next to a "Default:"
	 * line it had nothing to do with - so the one control that looked like the
	 * way back to the default was the one control that was not.
	 */
	const handleRevert = (entry: ConfigEntry) => {
		setEditedValues((prev) => {
			const next = { ...prev };
			delete next[entry.key];
			return next;
		});
	};

	/** Stage the shipped default for one entry (written on the next save). */
	const handleResetToDefault = (entry: ConfigEntry) => {
		setEditedValues((prev) => ({
			...prev,
			[entry.key]: { value: entry.default, isValid: true },
		}));
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
			return entry?.label || key;
		});
	};

	/**
	 * One entry's card.
	 *
	 * Extracted so the everyday list and the collapsed Advanced section below
	 * render from one definition: an advanced setting is the same control in a
	 * quieter place, not a second, thinner rendering of it.
	 */
	const renderEntryCard = (entry: ConfigEntry) => {
		const currentValue = getCurrentValue(entry);
		const edited = editedValues[entry.key];
		const isModified = edited !== undefined;
		const hasError = edited?.error;
		const needsRestart = isRestartRequired(entry);
		const isPendingRestart = restartRequiredKeys.includes(entry.key);
		const isHighlighted = highlightedKey === entry.key;
		const isNumeric = entry.type === "integer" || entry.type === "number";
		const defaultDisplay = isSizeConfig(entry.key)
			? formatBytes(parseInt(entry.default, 10) || 0)
			: undefined;

		return (
			<Card
				key={entry.key}
				ref={isHighlighted ? highlightedRef : undefined}
				className={cn(
					"transition-colors",
					isModified && !hasError && "border-primary/50",
					hasError && "border-destructive/50",
					isPendingRestart && "border-amber-400/50 bg-amber-50/30 dark:bg-amber-950/10",
					isHighlighted && "ring-2 ring-primary"
				)}
			>
				<CardHeader className="pb-3">
					<div className="flex items-start justify-between">
						<div>
							<div className="flex items-center gap-2">
								<CardTitle className="text-base">{entry.label}</CardTitle>
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
							<CardDescription className="mt-1">{entry.description}</CardDescription>
						</div>
						{isModified && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => handleRevert(entry)}
								className="text-xs h-7 px-2 shrink-0"
								title="Discard this staged change"
							>
								Revert
							</Button>
						)}
					</div>
				</CardHeader>
				<CardContent className="space-y-2">
					{entry.type === "boolean" ? (
						<div className="flex items-center gap-3">
							<Switch
								checked={currentValue === "true"}
								onCheckedChange={(checked) => handleBooleanToggle(entry, checked)}
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
								onValueChange={(value) => handleValueChange(entry, value)}
							>
								<SelectTrigger className="max-w-xs" aria-label={entry.label}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{entry.options.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : null
					) : isNumeric ? (
						/*
						 * `labelHidden`: the CardTitle above is the setting's name,
						 * so a visible second copy would say it twice - but the
						 * input still needs it as its accessible name.
						 */
						<NumberSettingRow
							label={entry.label}
							labelHidden
							value={currentValue}
							onDraftChange={(next) => handleValueChange(entry, next)}
							integer={entry.type === "integer"}
							min={entry.min}
							max={entry.max}
							unit={
								isSizeConfig(entry.key)
									? (getFormattedSize(entry) ?? undefined)
									: undefined
							}
							rangeHint={
								isSizeConfig(entry.key)
									? formatSizeRange(entry.min, entry.max) || undefined
									: undefined
							}
							error={hasError}
							defaultValue={entry.default}
							defaultDisplay={defaultDisplay}
							onResetToDefault={() => handleResetToDefault(entry)}
						/>
					) : (
						<Input
							type="text"
							value={currentValue}
							onChange={(e) => handleValueChange(entry, e.target.value)}
							className="max-w-xs"
							// Same as the Switch above: the name is in the
							// CardTitle, which nothing links to this input.
							aria-label={entry.label}
						/>
					)}
					{/* Numeric rows carry their own Default line (the primitive
					    renders it); the other three types get it here so every
					    engine setting has the same way back. */}
					{!isNumeric && (
						<DefaultValueLine
							defaultValue={entry.default}
							value={currentValue}
							onReset={() => handleResetToDefault(entry)}
						/>
					)}
				</CardContent>
			</Card>
		);
	};

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Restart Required Banner */}
			{pendingRestart && (
				<RestartRequiredBanner
					labels={getRestartRequiredLabels()}
					onDismiss={clearRestartRequired}
				/>
			)}

			{/* Header */}
			<div className="border-b border-border px-6 py-4 shrink-0">
				<div className="flex items-center justify-between max-w-3xl mx-auto w-full">
					<div>
						<h1 className="text-xl font-semibold">{categoryConfig?.label}</h1>
						<p className="text-sm text-muted-foreground mt-1">
							{categoryConfig?.description}
						</p>
						{/* The engine half of the save-model story the app panels
						    tell in their own header. */}
						<p className="text-xs text-muted-foreground mt-1.5">{ENGINE_SAVE_NOTE}</p>
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
					{primaryEntries.map(renderEntryCard)}

					{advancedEntries.length > 0 && (
						<section className="mt-2">
							<button
								type="button"
								onClick={() => setAdvancedOpen((open) => !open)}
								aria-expanded={showAdvanced}
								className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								<ChevronRight
									className={cn(
										"w-4 h-4 transition-transform",
										showAdvanced && "rotate-90"
									)}
									aria-hidden="true"
								/>
								Advanced
								<span className="text-xs font-normal">
									({advancedEntries.length})
								</span>
							</button>
							{showAdvanced && (
								<div className="grid gap-4 mt-4">
									{advancedEntries.map(renderEntryCard)}
								</div>
							)}
						</section>
					)}
				</div>
			</div>
		</div>
	);
}
