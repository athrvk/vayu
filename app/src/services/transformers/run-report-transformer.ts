
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Run Report Transformer
 *
 * Transforms backend run report format to frontend format.
 * Handles array-to-object transformations for statusCodes and errors.byStatusCode.
 */

import type { RunReport, GetRunReportResponse } from "@/types";

/**
 * Run Report Transformer
 *
 * Handles transformation of run reports from backend format to frontend format.
 */
export class RunReportTransformer {
	/**
	 * Transform backend run report to frontend format
	 *
	 * Backend returns statusCodes as array of tuples: [[200, 50], [404, 10]]
	 * Frontend expects: { "200": 50, "404": 10 }
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
