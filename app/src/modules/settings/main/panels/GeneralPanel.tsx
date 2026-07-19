/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * GeneralPanel
 *
 * System-level app settings: auto-save behavior, data management (clear stored
 * run history), on-disk storage locations, and a reset-to-defaults for every
 * renderer preference. Client-side; the data actions talk to the engine's run
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
	Kbd,
} from "@/components/ui";
import { modKey } from "@/lib/platform";
import { useClientSettingsStore } from "@/stores";
import { useToastStore } from "@/stores";
import { useRunsQuery, useInvalidateRuns } from "@/queries/runs";
import { apiService } from "@/services";
import { AUTO_SAVE_DELAY_OPTIONS } from "@/constants/client-settings";
import { OptionButtons, ToggleRow } from "./SettingControls";

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

	const { data: runs = [] } = useRunsQuery();
	const invalidateRuns = useInvalidateRuns();
	const showToast = useToastStore((s) => s.showToast);
	const [clearing, setClearing] = useState(false);

	useEffect(() => {
		window.electronAPI
			?.getAppPaths()
			.then(setAppPaths)
			.catch(() => {});
	}, []);

	const clearHistory = async () => {
		if (runs.length === 0) return;
		if (
			!window.confirm(
				`Delete all ${runs.length} stored run${runs.length === 1 ? "" : "s"}? This cannot be undone.`
			)
		) {
			return;
		}
		setClearing(true);
		try {
			const results = await Promise.allSettled(runs.map((r) => apiService.deleteRun(r.id)));
			const failed = results.filter((r) => r.status === "rejected").length;
			invalidateRuns();
			showToast(
				failed === 0
					? "Run history cleared"
					: `Cleared history — ${failed} run${failed === 1 ? "" : "s"} could not be deleted`,
				failed === 0 ? "success" : "error"
			);
		} finally {
			setClearing(false);
		}
	};

	const resetSettings = () => {
		if (
			window.confirm(
				"Reset all appearance, editor, and dashboard settings to their defaults? The app will reload. Your collections, requests, and run history are not affected."
			)
		) {
			resetAll();
		}
	};

	return (
		<>
			{/* Auto-save */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Save className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Auto-save</CardTitle>
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
						checked={autoSave.enabled}
						onChange={(enabled) => setAutoSave({ enabled })}
					/>
					{autoSave.enabled && (
						<div>
							<p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
								Save delay
							</p>
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
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<Database className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Data management</CardTitle>
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
							onClick={clearHistory}
							disabled={runs.length === 0 || clearing}
							className="text-destructive hover:text-destructive"
						>
							{clearing ? (
								<Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
							) : (
								<Database className="w-4 h-4 mr-1.5" />
							)}
							Clear run history
						</Button>
					</div>
				</CardContent>
			</Card>

			{/* Storage paths */}
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<FolderOpen className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Storage Paths</CardTitle>
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
			<Card>
				<CardHeader className="pb-3">
					<div className="flex items-center gap-2">
						<RotateCcw className="w-5 h-5 text-muted-foreground" />
						<CardTitle className="text-base">Reset app settings</CardTitle>
					</div>
					<CardDescription>
						Restore appearance, editor, and dashboard preferences to their defaults.
						Collections, requests, and run history are not affected.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Button
						variant="outline"
						size="sm"
						onClick={resetSettings}
						className="text-destructive hover:text-destructive"
					>
						<RotateCcw className="w-4 h-4 mr-1.5" />
						Reset to defaults
					</Button>
				</CardContent>
			</Card>
		</>
	);
}
