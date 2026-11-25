/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Turns the engine's run report into the app's shape: `statusCodes` and `errors.byStatusCode` from
 * arrays of pairs to objects.
 */

import type { RunReport, GetRunReportResponse } from "@/types";

/** Engine run reports to the app's shape; see the file comment. */
export class RunReportTransformer {
	/**
	 * Transform a run report to the app's shape. The engine sends `statusCodes` as `[code, count]`
	 * pairs (`[[200, 50], [404, 10]]`); the app reads `{ "200": 50, "404": 10 }`.
	 */
	static toFrontend(backendReport: GetRunReportResponse): RunReport {
		const report = { ...backendReport };

		// Transform statusCodes from array to object
		if (Array.isArray(report.statusCodes)) {
			const statusCodesObj: Record<string, number> = {};
			for (const entry of report.statusCodes) {
				if (Array.isArray(entry) && entry.length >= 2) {
					statusCodesObj[String(entry[0])] = entry[1];
				}
			}
			report.statusCodes = statusCodesObj;
		}

		// Transform errors.byStatusCode from array to object
		if (report.errors && Array.isArray(report.errors.byStatusCode)) {
			const byStatusCodeObj: Record<string, number> = {};
			for (const entry of report.errors.byStatusCode) {
				if (Array.isArray(entry) && entry.length >= 2) {
					byStatusCodeObj[String(entry[0])] = entry[1];
				}
			}
			report.errors.byStatusCode = byStatusCodeObj;
		}

		return report as RunReport;
	}
}
