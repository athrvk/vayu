/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Logs tab's controls (#3635): the filters, the search box, Follow, Jump to
 * time, Export and the folder button. Each filter writes `logs-store`'s
 * `controls`, and main evaluates it.
 */

import { useEffect, useState } from "react";
import { Download, FolderOpen, Search } from "lucide-react";
import {
	Button,
	Input,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
	TooltipIconButton,
} from "@/components/ui";
import { TIMING } from "@/config/timing";
import { downloadTextFile, saveFailedMessage } from "@/lib/download-text-file";
import { formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import { useToastStore } from "@/stores";
import { exportLine } from "./log-entry";
import { useLogsStore, type LogLevelName } from "./logs-store";

/** The Select's stand-in for "no filter": an item cannot carry an empty value. */
const ANY = "any";

const LEVEL_OPTIONS: { value: LogLevelName; label: string }[] = [
	{ value: "debug", label: "All levels" },
	{ value: "info", label: "Info and above" },
	{ value: "warn", label: "Warnings and above" },
	{ value: "error", label: "Errors only" },
];

/** `src` as `docs/engine/log-record.schema.json` names the writers, verbatim. */
const SOURCES = ["engine", "cli", "app", "mcp", "renderer"];

const EXPORT_FILE_NAME = "vayu-logs.jsonl";

interface FilterSelectProps {
	label: string;
	allLabel: string;
	value: string | null;
	options: readonly string[];
	onChange: (value: string | null) => void;
}

function FilterSelect({ label, allLabel, value, options, onChange }: FilterSelectProps) {
	// A selected value the list has not seen (a search turned it up) still has an item to show.
	const items = value !== null && !options.includes(value) ? [...options, value] : options;
	return (
		<Select value={value ?? ANY} onValueChange={(next) => onChange(next === ANY ? null : next)}>
			<SelectTrigger aria-label={label} className="w-36 shrink-0">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ANY}>{allLabel}</SelectItem>
				{items.map((item) => (
					<SelectItem key={item} value={item}>
						{item}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** Level, source and component, and the search box that waits for typing to stop. */
function Filters() {
	const controls = useLogsStore((s) => s.controls);
	const knownCategories = useLogsStore((s) => s.knownCategories);
	const setControls = useLogsStore((s) => s.setControls);
	const [draft, setDraft] = useState(controls.search);

	useEffect(() => {
		const timer = setTimeout(
			() => setControls({ search: draft }),
			TIMING.LOG_SEARCH_DEBOUNCE_MS
		);
		return () => clearTimeout(timer);
	}, [draft, setControls]);

	return (
		<>
			<Select
				value={controls.minLevel}
				onValueChange={(minLevel) => setControls({ minLevel: minLevel as LogLevelName })}
			>
				<SelectTrigger aria-label="Level" className="w-40 shrink-0">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{LEVEL_OPTIONS.map(({ value, label }) => (
						<SelectItem key={value} value={value}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<FilterSelect
				label="Source"
				allLabel="All sources"
				value={controls.source}
				options={SOURCES}
				onChange={(source) => setControls({ source })}
			/>
			<FilterSelect
				label="Component"
				allLabel="All components"
				value={controls.category}
				options={knownCategories}
				onChange={(category) => setControls({ category })}
			/>
			<div className="relative min-w-40 flex-1">
				<Search
					className="pointer-events-none absolute left-3 top-1/2 size-icon -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					type="text"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					aria-label="Search logs"
					placeholder="Search text or field:value"
					className="pl-10"
				/>
			</div>
		</>
	);
}

/** The instant a `datetime-local` value names in the user's zone; null for an empty or invalid one. */
function parseLocalTime(local: string): Date | null {
	const instant = new Date(local);
	return local === "" || Number.isNaN(instant.getTime()) ? null : instant;
}

/** The platform's own date-time control, and the read it asks for. */
function JumpToTime() {
	const jumpTo = useLogsStore((s) => s.jumpTo);
	const [local, setLocal] = useState("");
	const instant = parseLocalTime(local);

	return (
		<div className="flex shrink-0 items-center gap-1">
			<Input
				type="datetime-local"
				value={local}
				onChange={(event) => setLocal(event.target.value)}
				aria-label="Jump to time"
				className="w-48"
			/>
			<Button
				type="button"
				variant="outline"
				disabled={instant === null}
				onClick={() => instant && void jumpTo(instant.toISOString())}
			>
				Jump
			</Button>
		</div>
	);
}

/** Save the held lines, which are exactly the lines that match the filter, as JSON lines. */
function ExportButton() {
	const held = useLogsStore((s) => s.records.length);
	const showToast = useToastStore((s) => s.showToast);

	const exportLines = async () => {
		const { records } = useLogsStore.getState();
		const text = `${records.map(exportLine).join("\n")}\n`;
		const saved = await downloadTextFile(text, EXPORT_FILE_NAME, "application/x-ndjson");
		if (saved.outcome === "failed") {
			showToast(saveFailedMessage(EXPORT_FILE_NAME, saved), "error");
		} else if (saved.outcome === "saved") {
			const count = records.length;
			showToast(
				`Exported ${formatNumber(count)} ${pluralize(count, "line")} to ${saved.fileName}`,
				"success"
			);
		}
	};

	return (
		<Button
			type="button"
			variant="outline"
			disabled={held === 0}
			className="shrink-0 gap-1.5"
			onClick={() => void exportLines()}
		>
			<Download className="size-icon" aria-hidden="true" />
			Export
		</Button>
	);
}

/** `electronAPI.openLogsFolder` resolves with a non-empty string only on failure. */
function OpenLogsFolderButton() {
	const showToast = useToastStore((s) => s.showToast);
	const open = async () => {
		const failure = await window.electronAPI?.openLogsFolder();
		if (failure) showToast(`Couldn't open the logs folder - ${failure}`, "error");
	};
	return (
		<TooltipIconButton
			type="button"
			label="Open logs folder"
			icon={<FolderOpen className="size-icon" />}
			onClick={() => void open()}
		/>
	);
}

export function LogsToolbar() {
	const follow = useLogsStore((s) => s.follow);
	const setFollow = useLogsStore((s) => s.setFollow);

	return (
		<div className="flex flex-wrap items-center gap-2 border-b border-rule px-3 py-1.5">
			<Filters />
			<JumpToTime />
			<div className="flex shrink-0 items-center gap-2">
				<Switch id="logs-follow" checked={follow} onCheckedChange={setFollow} />
				<Label htmlFor="logs-follow">Follow</Label>
			</div>
			<ExportButton />
			<OpenLogsFolderButton />
		</div>
	);
}
