/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DataFilePicker - choose a CSV/TSV/JSON/JSONL file for a collection run, and
 * see what it will actually do before starting one (issue #402).
 *
 * The preview is not decoration. The engine rejects a bad data set with a
 * `400`, which is correct but late: by then the user has clicked Run and is
 * reading a message about a file they cannot see. Everything the engine would
 * refuse - a ragged row, a duplicated column, a non-object, a set over
 * `maxScenarioDataRows` or `maxScenarioDataBytes` - is refused here first,
 * against the parsed file, with the row, line or setting named.
 *
 * The two caps are **fetched, never restated** ({@link useDataFileLimits}): a
 * user who raises one engine-side and still cannot pick the file would have no
 * way to tell which side refused it.
 *
 * The **resolved iteration count** is the other half, and it is the one that
 * surprises people: an explicit `iterations` wins over the row count and the
 * row index wraps, so a 500-row file with `iterations` left at 1 runs *once*.
 * That is stated here rather than discovered in the step list afterwards.
 *
 * The previewed rows and the rows that get sent are the same array - the
 * parent holds one `ParsedDataFile` and this component slices it for display.
 * Two sources would be the "written but never read" defect wearing its other
 * face: a preview describing a set the run did not use.
 */

import { useRef } from "react";
import { FileSpreadsheet, Upload, X } from "lucide-react";

import {
	Button,
	Label,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui";
import { Callout } from "@/components/shared";
import {
	DATA_FILE_ACCEPT,
	DataFileError,
	decodeDataFile,
	describeRowCapRefusal,
	parseDataFile,
	resolveIterationCount,
	type ParsedDataFile,
} from "@/services/data-files";
import { useDataFileLimits } from "@/hooks/useDataFileLimits";
import { formatBytes } from "@/modules/settings/utils/format-size";

/** A chosen file: its name, for the user, and its rows, for the payload. */
export interface SelectedDataFile {
	fileName: string;
	parsed: ParsedDataFile;
	/**
	 * Where the file is on this machine, when Electron could say (issue #599).
	 *
	 * Only ever used to *remember* the file - `data-file-store` keys it by
	 * collection so the Run dialog can pre-fill next time. Empty in a browser
	 * and for a drag-and-drop of remote content, which is why every reader of it
	 * has a no-path path.
	 */
	path?: string;
}

export interface DataFilePickerProps {
	selected: SelectedDataFile | null;
	onSelect: (file: SelectedDataFile | null) => void;
	/** Parse failures live with the parent, beside the engine's own errors. */
	error: string | null;
	onError: (message: string | null) => void;
	/**
	 * The dialog's `iterations` field, or undefined when the user has not set
	 * one. Only the resolved count is shown - the arithmetic is the engine's
	 * (`resolveIterationCount` mirrors it), not this component's.
	 *
	 * Ignored when {@link DataFilePickerProps.loadTest} is set: a load run is
	 * bounded by its duration, so there is no pass count to resolve against.
	 */
	iterations: number | undefined;
	/**
	 * Whether the run this file is for is a load test (issue #449).
	 *
	 * It changes what a row *means*, which is why the copy cannot be shared: in
	 * design mode a row is an iteration and the file's length is the run's
	 * length. Under load the rows are claimed from one cursor shared by every
	 * virtual user and wrap for as long as the duration lasts, so "12 rows" says
	 * nothing about how long the run is - only that no two users hold the same
	 * row at once.
	 */
	loadTest?: boolean;
	/**
	 * What the file is being picked *for* (issue #599).
	 *
	 * `"run"` is the original job and the default. `"declare"` is the Data tab:
	 * the same picker, the same parser and the same refusals, but the file is
	 * being read to declare a contract from, so there is no iteration count to
	 * resolve and nothing yet to say about how a row will be bound.
	 */
	mode?: "run" | "declare";
	/**
	 * Warnings from outside the parser, shown in the same slot as its own - the
	 * file-versus-contract diff is the caller that has them, and a user reading
	 * "here is what is odd about this file" should not have to look in two
	 * places for the list.
	 */
	additionalWarnings?: string[];
	disabled?: boolean;
}

/** Enough rows to see the shape of the file without turning the dialog into it. */
const PREVIEW_ROWS = 10;

/** A cell as the preview prints it. Objects and arrays show as compact JSON. */
function displayCell(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

export default function DataFilePicker({
	selected,
	onSelect,
	error,
	onError,
	iterations,
	loadTest,
	mode = "run",
	additionalWarnings,
	disabled,
}: DataFilePickerProps) {
	const inputRef = useRef<HTMLInputElement>(null);
	const { maxRows, maxBytes } = useDataFileLimits();

	/**
	 * A file that does not parse leaves no selection behind - a half-chosen file
	 * is how a run goes out with rows nobody saw.
	 */
	const refuse = (message: string) => {
		onSelect(null);
		onError(message);
	};

	const handleFile = (file: File) => {
		/*
		 * Checked against the file on disk, before a byte of it is read: a
		 * several-hundred-megabyte file would otherwise be pulled wholesale into
		 * a renderer string, and what failed then would be the transport rather
		 * than a message naming the setting. The engine measures the *serialized
		 * rows*, which for CSV are larger than the file (every row repeats the
		 * column names), so a file over the cap is a data set over it too.
		 */
		if (file.size > maxBytes) {
			refuse(
				`The file is ${formatBytes(file.size)}, over the ${formatBytes(maxBytes)} a run may carry. Raise the maxScenarioDataBytes engine setting, or split the file.`
			);
			return;
		}

		const reader = new FileReader();
		reader.onload = () => {
			try {
				const { text } = decodeDataFile(reader.result as ArrayBuffer);
				const parsed = parseDataFile(text, file.name);
				// The same sentence a re-read of a remembered path refuses with
				// (`read-declared.ts`), from one place - the two used to be one
				// refusal and one silent acceptance.
				const overRowCap = describeRowCapRefusal(parsed.rows.length, maxRows);
				if (overRowCap) {
					refuse(overRowCap);
					return;
				}
				// The path is Electron's to give (`webUtils`, inside the preload)
				// and is absent in a browser or for remote drag-and-drop, so it
				// is carried when there is one and simply not when there is not.
				const path = window.electronAPI?.getFilePath(file) || undefined;
				onSelect({ fileName: file.name, parsed, path });
				onError(null);
			} catch (e) {
				refuse(
					e instanceof DataFileError
						? e.message
						: `Could not read the file: ${(e as Error).message}`
				);
			}
		};
		reader.onerror = () => {
			refuse("Could not read the file.");
		};
		reader.readAsArrayBuffer(file);
	};

	const clear = () => {
		onSelect(null);
		onError(null);
		// Without this the same file cannot be re-picked: the input holds the
		// previous value and fires no change event for an identical selection.
		if (inputRef.current) inputRef.current.value = "";
	};

	const rowCount = selected?.parsed.rows.length ?? 0;
	const resolved = resolveIterationCount(rowCount, iterations);

	return (
		<div className="space-y-3">
			<div className="flex items-start justify-between gap-4">
				<Label htmlFor="run-collection-data-file" className="leading-snug">
					Data file
					<span className="block text-xs font-normal text-muted-foreground">
						{mode === "declare" ? (
							<>
								The file the contract is read from. Its columns become the declared{" "}
								{"{{data.column}}"} names; its rows stay on this machine and are
								never saved.
							</>
						) : loadTest ? (
							<>
								One row per iteration, claimed from a cursor every virtual user
								shares. Rows repeat once they run out, so users share a row past
								that point. Columns read as {"{{data.column}}"}.
							</>
						) : (
							<>
								One iteration per row. Columns read as {"{{data.column}}"} and
								pm.iterationData.
							</>
						)}
					</span>
				</Label>
				{selected ? (
					<Button
						variant="outline"
						size="sm"
						onClick={clear}
						disabled={disabled}
						className="shrink-0"
					>
						<X className="mr-1.5 h-3.5 w-3.5" />
						Remove
					</Button>
				) : (
					<Button
						id="run-collection-data-file"
						variant="outline"
						size="sm"
						onClick={() => inputRef.current?.click()}
						disabled={disabled}
						className="shrink-0"
					>
						<Upload className="mr-1.5 h-3.5 w-3.5" />
						Choose file
					</Button>
				)}
			</div>

			<input
				ref={inputRef}
				type="file"
				className="hidden"
				accept={DATA_FILE_ACCEPT}
				onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
			/>

			{error && (
				<Callout severity="blocking" title="Could not read the data file">
					{error}
				</Callout>
			)}

			{selected && (
				<div className="space-y-2 rounded-md border border-rule bg-card surface-card p-3">
					<div className="flex items-center gap-2 text-xs">
						<FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						<span className="truncate font-medium">{selected.fileName}</span>
						<span className="ml-auto shrink-0 text-muted-foreground">
							{selected.parsed.format.toUpperCase()} · {rowCount}{" "}
							{rowCount === 1 ? "row" : "rows"} · {selected.parsed.columns.length}{" "}
							{selected.parsed.columns.length === 1 ? "column" : "columns"}
						</span>
					</div>

					{/* A load run has no pass count to resolve against - it repeats for
					    its duration - so the resolved-iterations sentence would be
					    arithmetic about a number that does not exist. What it says
					    instead is the property the shared cursor buys. Declaring a
					    contract has no run behind it at all, so it says neither. */}
					{mode === "declare" ? (
						<p className="text-xs text-muted-foreground">
							{selected.parsed.columns.length}{" "}
							{selected.parsed.columns.length === 1 ? "column" : "columns"} to
							declare, read from {rowCount} {rowCount === 1 ? "row" : "rows"}.
						</p>
					) : (
						<p className="text-xs text-muted-foreground">
							{loadTest
								? `${rowCount} ${rowCount === 1 ? "row" : "rows"}, bound one per iteration across every virtual user - they repeat from the top once they run out.`
								: resolved === rowCount
									? `${resolved} ${resolved === 1 ? "iteration" : "iterations"}, one per row.`
									: resolved < rowCount
										? `${resolved} ${resolved === 1 ? "iteration" : "iterations"} - Iterations is set, so ${rowCount - resolved} of the ${rowCount} rows will not be used.`
										: `${resolved} iterations over ${rowCount} ${rowCount === 1 ? "row" : "rows"} - the rows repeat from the top once they run out.`}
						</p>
					)}

					{/* The grid scrolls rather than widening the dialog: a file
					    with twenty columns must not push the footer off-screen. */}
					<div className="max-h-56 overflow-auto rounded-md border border-rule">
						<Table>
							<TableHeader>
								<TableRow>
									{selected.parsed.columns.map((column) => (
										<TableHead key={column} className="whitespace-nowrap">
											{column}
										</TableHead>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								{selected.parsed.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
									<TableRow key={index}>
										{selected.parsed.columns.map((column) => (
											<TableCell key={column} className="whitespace-nowrap">
												{displayCell(row[column])}
											</TableCell>
										))}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>

					{rowCount > PREVIEW_ROWS && (
						<p className="text-xs text-muted-foreground">
							Showing the first {PREVIEW_ROWS} of {rowCount} rows.
						</p>
					)}

					{[...selected.parsed.warnings, ...(additionalWarnings ?? [])].map((warning) => (
						<p key={warning} className="text-xs text-muted-foreground">
							{warning}
						</p>
					))}
				</div>
			)}
		</div>
	);
}
