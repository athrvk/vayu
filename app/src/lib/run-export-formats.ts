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
	/** The menu entry that saves the file. */
	readonly label: string;
	readonly mimeType: string;
	/** Including the leading dot: the suffix the saved file's name ends in. */
	readonly extension: string;
	/** Whether the text is also offered on the clipboard. */
	readonly copyable: boolean;
	/** Whether the MCP `export_run` tool offers it. */
	readonly mcp: boolean;
}

export const RUN_EXPORT_FORMATS = [
	{
		id: "json",
		label: "Save as JSON",
		mimeType: "application/json",
		extension: ".run.json",
		copyable: false,
		mcp: true,
	},
] as const satisfies readonly RunExportFormat[];

export type RunExportFormatId = (typeof RUN_EXPORT_FORMATS)[number]["id"];
