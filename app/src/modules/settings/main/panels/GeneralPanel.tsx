/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * GeneralPanel
 *
 * System-level app settings: the installed version and a manual update check,
 * auto-save behavior, data management (clear stored run history), on-disk
 * storage locations, and a reset-to-defaults for every renderer preference. Client-side; the data actions talk to the engine's run
 * store via the existing API.
 */

import { useState, useEffect } from "react";
import { FolderOpen, Save, Database, RotateCcw, Loader2 } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Button,
	Eyebrow,
	Kbd,
	DeleteConfirmDialog,
} from "@/components/ui";
import { modKey } from "@/lib/platform";
import { useClientSettingsStore } from "@/stores";
import { useToastStore, useTabsStore } from "@/stores";
import { useAllRunsQuery, useInvalidateRuns } from "@/queries/runs";
import { apiService } from "@/services";
import { AUTO_SAVE_DELAY_OPTIONS } from "@/constants/client-settings";
import { appSetting } from "../app-settings";
import { OptionButtons, ToggleRow } from "./SettingControls";
import { UpdatesCard } from "./UpdatesCard";
import { CookiesCard } from "./CookiesCard";
import { useSettingsStore } from "@/modules/settings/settings-store";
import type { EngineSettingsCategory } from "@/types";

/** Where the retention knobs the runs on this card obey actually live. */
const RETENTION_CATEGORY: EngineSettingsCategory = "data_retention";

// Headings come from the catalogue so search cannot offer a name this panel
// does not print - see `app-settings.ts`.
const AUTO_SAVE = appSetting("auto-save");
const DATA_MANAGEMENT = appSetting("data-management");
const STORAGE_PATHS = appSetting("storage-paths");
const RESET = appSetting("reset-app-settings");

interface AppPaths {
	appDir: string;
	dataDir: string;
	logsPath: string;
	dbPath: string;
}

export default function GeneralPanel() {
	const [appPaths, setAppPaths] = useState<AppPaths | null>(null);
	const autoSave = useClientSettingsStore((s) => s.autoSave);
	const setAutoSave = useClientSettingsStore((s) => s.setAutoSave);
	const resetAll = useClientSettingsStore((s) => s.resetAll);

	// The whole history (all pages) - this panel counts and clears every run,
	// not just a polled page.
	const { data: runs = [] } = useAllRunsQuery();
	const invalidateRuns = useInvalidateRuns();
	const closeTabsForEntities = useTabsStore((s) => s.closeTabsForEntities);
	const showToast = useToastStore((s) => s.showToast);
	const [clearing, setClearing] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const setSelectedCategory = useSettingsStore((s) => s.setSelectedCategory);

	useEffect(() => {
		window.electronAPI
			?.getAppPaths()
			.then(setAppPaths)
			.catch(() => {});
	}, []);

	/*
	 * Confirmed through the app's own DeleteConfirmDialog rather than
	 * `window.confirm`. The native dialog ignores the theme, the accent and the
	 * roundedness setting entirely, and - being modal to the whole renderer -
	 * it also blocks the JS thread, so the live dashboard stops updating behind
	 * it. Every other destructive action in the app (deleting a run, a
	 * collection, a request) already routes through this dialog, which also
	 * focuses Cancel first so a reflexive Enter does not wipe the history.
	 */
	const clearHistory = async () => {
		setConfirmClear(false);
		if (runs.length === 0) return;
		setClearing(true);
		try {
			const results = await Promise.allSettled(runs.map((r) => apiService.deleteRun(r.id)));
			const failed = results.filter((r) => r.status === "rejected").length;
			// Close the tab of every run that actually went away - by index, so a
			// run the engine refused (a 409 while it is still stopping) keeps its
			// tab. Without this the tabs persist and rehydrate as dead panes.
			closeTabsForEntities(
				runs.filter((_, i) => results[i].status === "fulfilled").map((r) => r.id),
				"run"
			);
			invalidateRuns();
			showToast(
				failed === 0
					? "Run history cleared"
					: `Cleared history - ${failed} run${failed === 1 ? "" : "s"} could not be deleted`,
				failed === 0 ? "success" : "error"
			);
		} finally {
			setClearing(false);
		}
	};

	/*
	 * Same in-app dialog as Clear run history, for the same reason: the native
	 * `window.confirm` ignores the theme, the accent and the roundedness that
	 * this panel exists to configure, and blocks the renderer thread while it is
	 * open. It also focuses Cancel first, so a reflexive Enter does not reset.
	 *
	 * `confirmVariant="default"` rather than destructive: this is irreversible
	 * but it removes nothing - a red button would overstate it next to the one
	 * that really does delete run history.
	 */
	const resetSettings = () => {
		setConfirmReset(false);
		resetAll();
	};

	return (
		<>
			{/* Version + manual update check - the first thing people open
			    General looking for. */}
			<UpdatesCard />

			{/* Auto-save */}
			<Card data-setting-anchor={AUTO_SAVE.anchor}>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Save className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">{AUTO_SAVE.label}</CardTitle>
					</div>
					<CardDescription>
						Automatically save edits to requests after you stop typing. Manual save{" "}
						<span className="inline-flex items-center gap-1 align-middle">
							<Kbd size="sm">{modKey}</Kbd>
							<Kbd size="sm">S</Kbd>
						</span>{" "}
						always works regardless.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<ToggleRow
						label="Auto-save edits"
						description="Off leaves an edited request marked unsaved until you save it"
						checked={autoSave.enabled}
						onChange={(enabled) => setAutoSave({ enabled })}
					/>
					{autoSave.enabled && (
						<div>
							<Eyebrow className="mb-2">Save delay</Eyebrow>
							<OptionButtons
								options={AUTO_SAVE_DELAY_OPTIONS}
								value={autoSave.delayMs}
								onChange={(delayMs) => setAutoSave({ delayMs })}
								columns="grid-cols-3"
							/>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Data management */}
			<Card data-setting-anchor={DATA_MANAGEMENT.anchor}>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Database className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">{DATA_MANAGEMENT.label}</CardTitle>
					</div>
					<CardDescription>
						Stored load-test runs and their metrics live in the engine database.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex items-center justify-between gap-4">
						<p className="text-sm text-muted-foreground">
							{runs.length === 0
								? "No stored runs."
								: `${runs.length} stored run${runs.length === 1 ? "" : "s"}.`}
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setConfirmClear(true)}
							disabled={runs.length === 0 || clearing}
							className="text-destructive-text hover:bg-destructive-text/10 hover:text-destructive-text"
						>
							{clearing ? (
								<Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
							) : (
								<Database className="w-4 h-4 mr-1.5" />
							)}
							Clear run history
						</Button>
					</div>
					{/* This card shows and clears the runs; how many are kept, and for
					    how long, are engine settings at the far end of the tree.
					    Nothing here said so, so the two halves of run retention were
					    findable only by already knowing both (#586). */}
					<p className="text-xs text-muted-foreground mt-3">
						How many runs are kept, and for how long, is set in{" "}
						<Button
							variant="link"
							size="sm"
							className="h-auto p-0 text-xs align-baseline"
							onClick={() => setSelectedCategory(RETENTION_CATEGORY)}
						>
							Engine &gt; Data &amp; retention
						</Button>
						.
					</p>
				</CardContent>
			</Card>

			{/* The engine's cookie jar - engine-held state the user never typed,
			    which is why it sits beside run history rather than in a panel
			    of its own. */}
			<CookiesCard />

			{/* Storage paths */}
			<Card data-setting-anchor={STORAGE_PATHS.anchor}>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<FolderOpen className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">{STORAGE_PATHS.label}</CardTitle>
					</div>
					<CardDescription>
						File system locations used by the application.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{appPaths ? (
						<div className="space-y-2">
							{(
								[
									["App directory", appPaths.appDir],
									["Data directory", appPaths.dataDir],
									["Database", appPaths.dbPath],
									["Logs", appPaths.logsPath],
								] as const
							).map(([label, value]) => (
								<div key={label} className="flex flex-col gap-0.5">
									<span className="text-xs font-medium text-muted-foreground">
										{label}
									</span>
									<span className="text-xs font-mono text-foreground break-all">
										{value}
									</span>
								</div>
							))}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							Storage paths are available in the desktop app.
						</p>
					)}
				</CardContent>
			</Card>

			{/* Reset */}
			<Card data-setting-anchor={RESET.anchor}>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<RotateCcw className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">{RESET.label}</CardTitle>
					</div>
					<CardDescription>
						Restore every app preference to its default: appearance, editor, dashboard,
						notifications, auto-save, and the load-test limits. Collections, requests,
						and run history are not affected.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setConfirmReset(true)}
						className="text-destructive-text hover:bg-destructive-text/10 hover:text-destructive-text"
					>
						<RotateCcw className="w-4 h-4 mr-1.5" />
						Reset to defaults
					</Button>
				</CardContent>
			</Card>

			<DeleteConfirmDialog
				open={confirmReset}
				onOpenChange={setConfirmReset}
				title="Reset app settings?"
				description="Every app preference goes back to its default - appearance, editor, dashboard, notifications, auto-save and the load-test limits - and the app reloads. Collections, requests and run history are not affected."
				onConfirm={resetSettings}
				confirmLabel="Reset"
				confirmVariant="default"
			/>

			<DeleteConfirmDialog
				open={confirmClear}
				onOpenChange={setConfirmClear}
				title="Clear run history?"
				description={`All ${runs.length} stored run${runs.length === 1 ? "" : "s"} and their metrics will be permanently removed. This cannot be undone.`}
				onConfirm={clearHistory}
				isDeleting={clearing}
			/>
		</>
	);
}
