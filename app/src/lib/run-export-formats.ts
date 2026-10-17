/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The formats a finished load run can be exported in (#2139).
 *
 * The engine owns the bytes (`RUN_EXPORT_FORMATS` in
 * `engine/include/vayu/core/run_export.hpp`); this registry owns what the app
 * says and does about each one. A row is added here only once the engine writes
 * it, and `run-export-formats.test.ts` holds the two to
 * `engine/tests/fixtures/run-export-formats.json`.
 */

export interface RunExportFormat {
	/** The `format` member of `POST /export/run-report`. */
	readonly id: string;
	/**
	 * What the format is called in a label: "Save as JSON", and the palette's
	 * `Save "<run>" as JSON`. Never the label itself, so the two cannot drift.
	 */
	readonly name: string;
	readonly mimeType: string;
	/** Including the leading dot: the suffix the saved file's name ends in. */
	readonly extension: string;
	/** Whether the text is also offered on the clipboard. */
	readonly copyable: boolean;
	/** Whether the MCP `export_run_report` tool offers it. */
	readonly mcp: boolean;
}

export const RUN_EXPORT_FORMATS = [
	{
		id: "json",
		name: "JSON",
		mimeType: "application/json",
		extension: ".run.json",
		copyable: false,
		mcp: true,
	},
] as const satisfies readonly RunExportFormat[];

export type RunExportFormatId = (typeof RUN_EXPORT_FORMATS)[number]["id"];

export type RunExportFormatEntry = (typeof RUN_EXPORT_FORMATS)[number];

/** Where an exported document goes: a file on disk, or the clipboard. */
export type RunExportDelivery = "save" | "copy";

/** One thing a user can do with a finished run's report: a format and where it goes. */
export interface RunExportAction {
	/** Stable, for a menu key and the palette command's id: `save-json`. */
	readonly id: string;
	readonly delivery: RunExportDelivery;
	readonly format: RunExportFormatEntry;
	/** The menu entry: "Save as JSON", "Copy as Markdown". */
	readonly label: string;
}

const DELIVERY_VERB: Record<RunExportDelivery, string> = { save: "Save", copy: "Copy" };

/** The verb an action's labels open with: "Save", "Copy". */
export function runExportVerb(delivery: RunExportDelivery): string {
	return DELIVERY_VERB[delivery];
}

/**
 * Every action the formats offer, in menu order: a save per format, then a copy
 * per format the clipboard can hold. The export menu and the palette both draw
 * from this, so a format added to the table appears in both without an edit.
 */
export function runExportActions(
	formats: readonly RunExportFormatEntry[] = RUN_EXPORT_FORMATS
): RunExportAction[] {
	const action = (delivery: RunExportDelivery, format: RunExportFormatEntry) => ({
		id: `${delivery}-${format.id}`,
		delivery,
		format,
		label: `${runExportVerb(delivery)} as ${format.name}`,
	});
	return [
		...formats.map((format) => action("save", format)),
		...formats.filter((format) => format.copyable).map((format) => action("copy", format)),
	];
}
