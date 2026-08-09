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
 * refuse - a ragged row, a duplicated column, a non-object - is refused here
 * first, against the parsed file, with the row or line named.
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
	parseDataFile,
	resolveIterationCount,
	type ParsedDataFile,
} from "@/services/data-files";

/** A chosen file: its name, for the user, and its rows, for the payload. */
export interface SelectedDataFile {
	fileName: string;
	parsed: ParsedDataFile;
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
	 */
	iterations: number | undefined;
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
	disabled,
}: DataFilePickerProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	const handleFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				onSelect({
					fileName: file.name,
					parsed: parseDataFile(String(reader.result), file.name),
				});
				onError(null);
			} catch (e) {
				// A file that does not parse leaves no selection behind - a
				// half-chosen file is how a run goes out with rows nobody saw.
				onSelect(null);
				onError(
					e instanceof DataFileError
						? e.message
						: `Could not read the file: ${(e as Error).message}`
				);
			}
		};
		reader.onerror = () => {
			onSelect(null);
			onError("Could not read the file.");
		};
		reader.readAsText(file);
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
						One iteration per row. Columns read as {"{{data.column}}"} and
						pm.iterationData.
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

					<p className="text-xs text-muted-foreground">
						{resolved === rowCount
							? `${resolved} ${resolved === 1 ? "iteration" : "iterations"}, one per row.`
							: resolved < rowCount
								? `${resolved} ${resolved === 1 ? "iteration" : "iterations"} - Iterations is set, so ${rowCount - resolved} of the ${rowCount} rows will not be used.`
								: `${resolved} iterations over ${rowCount} ${rowCount === 1 ? "row" : "rows"} - the rows repeat from the top once they run out.`}
					</p>

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

					{selected.parsed.warnings.map((warning) => (
						<p key={warning} className="text-xs text-muted-foreground">
							{warning}
						</p>
					))}
				</div>
			)}
		</div>
	);
}
