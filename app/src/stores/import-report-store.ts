/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";
import type { FileReferenceNeeds, ImportNotice } from "@/modules/collections/import-notices";

/**
 * What one applied file lost or changed, kept after the import dialog is gone
 * (issue #2109).
 *
 * The preview shows this ledger before the apply and the dialog then discards
 * it; this is the copy that outlives it. It holds the lines `importNotices`
 * wrote and the file-reference needs read off the drafts, not the drafts: those
 * carry every request body and the spec document.
 */
export interface ImportReport {
	/** What the toast calls the import: the collection's name, else the file's. */
	title: string;
	/** The picked file's name; null for a pasted document or a URL without one. */
	fileName: string | null;
	notices: ImportNotice[];
	fileNeeds: FileReferenceNeeds;
	counts: {
		requests: number;
		folders: number;
		environments: number;
		globals: number;
	};
	/** The real ids of the root collections this file created, in file order. */
	rootIds: string[];
}

/** Whether there is anything to finish or to know about. */
export function hasReport(report: ImportReport): boolean {
	return (
		report.notices.length > 0 ||
		report.fileNeeds.folders.length > 0 ||
		report.fileNeeds.bodiesWithoutFile > 0
	);
}

interface ImportReportState {
	/**
	 * Reports by root collection id. A file that created several roots is
	 * stored under each of them, as one report.
	 */
	reports: Record<string, ImportReport>;
	/**
	 * Keep a file's report under each of its roots. A report with nothing in it,
	 * or a file that created no collection, has nowhere to be shown and is not
	 * stored.
	 */
	record: (report: ImportReport) => void;
	/** Drop the report `rootId` carries, and with it the copy under the file's other roots. */
	dismiss: (rootId: string) => void;
}

/** In memory only: a report is about the import just made, not about the workspace. */
export const useImportReportStore = create<ImportReportState>((set) => ({
	reports: {},
	record: (report) => {
		if (!hasReport(report) || report.rootIds.length === 0) return;
		set((state) => ({
			reports: {
				...state.reports,
				...Object.fromEntries(report.rootIds.map((rootId) => [rootId, report])),
			},
		}));
	},
	dismiss: (rootId) =>
		set((state) => {
			const report = state.reports[rootId];
			if (!report) return state;
			const remaining = { ...state.reports };
			for (const id of report.rootIds) delete remaining[id];
			return { reports: remaining };
		}),
}));

/** Selector for the report a collection carries, if any. */
export const selectImportReport =
	(rootId: string | null) =>
	(state: ImportReportState): ImportReport | undefined =>
		rootId ? state.reports[rootId] : undefined;
