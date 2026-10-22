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
 * auto-save behavior, start at login, data management (clear stored run
 * history), on-disk storage locations, and a reset-to-defaults for every
 * renderer preference. Client-side; the data actions talk to the engine's run
 * store via the existing API.
 */

import { useState, useEffect } from "react";
import { FolderOpen, Save, Database, RotateCcw, Loader2 } from "lucide-react";
import { pickByCount, pluralize } from "@/modules/dashboard/utils/format";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Button,
	DisabledHint,
	Eyebrow,
	Kbd,
	DeleteConfirmDialog,
	ICON_MOTION,
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
import { StartAtLoginCard } from "./StartAtLoginCard";
import { CookiesCard } from "./CookiesCard";
import { WorkspaceBackupCard } from "./WorkspaceBackupCard";
import { useSettingsStore } from "@/modules/settings/settings-store";
import type { EngineSettingsCategory, Run } from "@/types";

/** Where the retention knobs the runs on this card obey actually live. */
const RETENTION_CATEGORY: EngineSettingsCategory = "data_retention";

// Headings come from the catalogue so search cannot offer a name this panel
// does not print - see `app-settings.ts`.
const AUTO_SAVE = appSetting("auto-save");
const DATA_MANAGEMENT = appSetting("data-management");
const STORAGE_PATHS = appSetting("storage-paths");
const RESET = appSetting("reset-app-settings");
const SAVE_DELAY_LABEL = "Save delay";

/**
 * What `DELETE /runs` will do with the stored runs, read ahead of the call so
 * the dialog and the button say only what is true. The engine keeps a pinned
 * baseline and a run still running or pending (#2429); the engine's own pass
 * has the last word, since either can change between this read and the call.
 */
function planClear(runs: readonly Run[]) {
	const pinned = runs.filter((r) => r.baseline).length;
	const inFlight = runs.filter(
		(r) => !r.baseline && (r.status === "running" || r.status === "pending")
	).length;
	return { pinned, inFlight, clearable: runs.length - pinned - inFlight };
}

type ClearPlan = ReturnType<typeof planClear>;

/** Why Clear run history is unavailable, or `false` when it is not. */
function clearBlockedReason(stored: number, plan: ClearPlan, clearing: boolean) {
	if (clearing) return "Clearing the run history";
	if (stored === 0) return "No stored runs to clear";
	return plan.clearable === 0 && "Only pinned baselines and runs in progress are stored";
}

function clearDescription({ pinned, inFlight, clearable }: ClearPlan): string {
	const keptSentences = [
		pinned > 0 &&
			pickByCount(pinned, {
				one: "One pinned baseline is kept.",
				other: `${pinned} pinned baselines are kept.`,
			}),
		inFlight > 0 &&
			pickByCount(inFlight, {
				one: "One run still in progress is kept.",
				other: `${inFlight} runs still in progress are kept.`,
			}),
	].filter(Boolean);
	// "All" is true only when nothing is spared.
	const removed =
		keptSentences.length === 0
			? pickByCount(clearable, {
					one: "The one stored run and its metrics are removed permanently.",
					other: `All ${clearable} stored runs and their metrics are removed permanently.`,
				})
			: pickByCount(clearable, {
					one: "One stored run and its metrics are removed permanently.",
					other: `${clearable} stored runs and their metrics are removed permanently.`,
				});
	return [removed, ...keptSentences, "This can't be undone."].join(" ");
}

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
	const plan = planClear(runs);
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
		if (plan.clearable === 0) return;
		setClearing(true);
		try {
			const { deletedIds } = await apiService.clearRuns();
			// Only the tabs of runs the engine says went: tabs persist, so one left
			// open for a deleted run rehydrates as a dead pane, and one closed for a
			// kept baseline would hide a run that is still there.
			closeTabsForEntities(deletedIds, "run");
			showToast("Run history cleared", "success");
		} catch (error) {
			showToast(
				error instanceof Error
					? `Couldn't clear the run history - ${error.message}`
					: "Couldn't clear the run history",
				"error"
			);
		} finally {
			// A failure can still land after some batches were committed, so the
			// list is re-read either way.
			invalidateRuns();
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

	/** `electronAPI.openLogsFolder` resolves with a non-empty string only on failure. */
	const openLogsFolder = async () => {
		const result = await window.electronAPI?.openLogsFolder();
		if (result) showToast(`Couldn't open the logs folder - ${result}`, "error");
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
						<CardTitle>{AUTO_SAVE.label}</CardTitle>
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
						<div className="enter-fade">
							<Eyebrow className="mb-2">{SAVE_DELAY_LABEL}</Eyebrow>
							<OptionButtons
								label={SAVE_DELAY_LABEL}
								options={AUTO_SAVE_DELAY_OPTIONS}
								value={autoSave.delayMs}
								onChange={(delayMs) => setAutoSave({ delayMs })}
								columns="grid-cols-3"
							/>
						</div>
					)}
				</CardContent>
			</Card>

			{/* The OS-held login item (#2098): a preference, but the OS owns the
			    answer, which is why it is not one of the stored settings above. */}
			<StartAtLoginCard />

			{/* Data management */}
			<Card data-setting-anchor={DATA_MANAGEMENT.anchor}>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Database className="w-5 h-5 text-muted-foreground" />
						<CardTitle>{DATA_MANAGEMENT.label}</CardTitle>
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
								: `${runs.length} stored ${pluralize(runs.length, "run")}.`}
						</p>
						<DisabledHint reason={clearBlockedReason(runs.length, plan, clearing)}>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setConfirmClear(true)}
								disabled={plan.clearable === 0 || clearing}
								className="text-destructive-text hover:bg-destructive-text/10 hover:text-destructive-text"
							>
								{clearing ? (
									<Loader2 className="size-icon animate-spin" />
								) : (
									<Database className="size-icon" />
								)}
								Clear run history
							</Button>
						</DisabledHint>
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

			{/* A copy of the whole workspace the user controls (#987). Beside
			    Data management because it answers the question that card
			    raises - what happens to all this if the file is lost - and
			    above Storage paths, which prints the database it copies. */}
			<WorkspaceBackupCard />

			{/* The engine's cookie jar - engine-held state the user never typed,
			    which is why it sits beside run history rather than in a panel
			    of its own. */}
			<CookiesCard />

			{/* Storage paths */}
			<Card data-setting-anchor={STORAGE_PATHS.anchor}>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<FolderOpen className="w-5 h-5 text-muted-foreground" />
						<CardTitle>{STORAGE_PATHS.label}</CardTitle>
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
								<div
									key={label}
									className="flex items-center justify-between gap-2"
								>
									<div className="flex flex-col gap-0.5 min-w-0">
										<span className="text-xs font-medium text-muted-foreground">
											{label}
										</span>
										<span className="text-xs font-mono text-foreground break-all">
											{value}
										</span>
									</div>
									{label === "Logs" && window.electronAPI && (
										<Button
											variant="outline"
											size="sm"
											className="shrink-0"
											onClick={() => void openLogsFolder()}
										>
											<FolderOpen className="size-icon" />
											Open
										</Button>
									)}
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
						<CardTitle>{RESET.label}</CardTitle>
					</div>
					<CardDescription>
						Restore every app preference to its default: appearance, editor, dashboard,
						notifications, auto-save, start at login, and the load-test limits.
						Collections, requests, and run history are not affected.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setConfirmReset(true)}
						className="text-destructive-text hover:bg-destructive-text/10 hover:text-destructive-text"
					>
						<RotateCcw className="size-icon" data-icon-motion={ICON_MOTION.spinBack} />
						Reset to defaults
					</Button>
				</CardContent>
			</Card>

			<DeleteConfirmDialog
				open={confirmReset}
				onOpenChange={setConfirmReset}
				title="Reset app settings?"
				description="Every app preference goes back to its default - appearance, editor, dashboard, notifications, auto-save, start at login and the load-test limits - and the app reloads. Collections, requests and run history are not affected."
				onConfirm={resetSettings}
				confirmLabel="Reset"
				confirmVariant="default"
			/>

			<DeleteConfirmDialog
				open={confirmClear}
				onOpenChange={setConfirmClear}
				title="Clear run history?"
				confirmLabel="Clear history"
				description={clearDescription(plan)}
				onConfirm={clearHistory}
				isDeleting={clearing}
			/>
		</>
	);
}
