/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What happens once an import has been applied (issue #2109): the report of
 * what each file lost is kept, the new collections are revealed, and one toast
 * says what arrived.
 *
 * Outside the dialog on purpose. The dialog closes first, so none of this can
 * live in its state, and the stores it writes are the ones the rest of the app
 * already reads.
 */

import { useCollectionsStore } from "./collections-store";
import {
	environmentAction,
	environmentClause,
	type EnvironmentOutcome,
} from "./import-environment";
import { fileReferenceNeeds, importNotices } from "./import-notices";
import {
	hasReport,
	useImportReportStore,
	useTabSelectionStore,
	useTabsStore,
	useToastStore,
	type ImportReport,
} from "@/stores";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { ImportResult } from "@/services/importers/types";

/** The report for one applied file; `rootIds` are the real ids the apply returned. */
export function buildImportReport(result: ImportResult, rootIds: string[]): ImportReport {
	const { meta } = result;
	return {
		title:
			result.collections.length === 1
				? result.collections[0].name
				: (meta.fileName ?? meta.format),
		fileName: meta.fileName ?? null,
		notices: importNotices(meta),
		fileNeeds: fileReferenceNeeds([result]),
		counts: {
			requests: meta.requestCount,
			folders: meta.folderCount,
			environments: meta.environmentCount,
			globals: meta.globalCount,
		},
		rootIds,
	};
}

/** Lines the user has to finish by hand: each action-tier notice and each kind of file reference. */
function thingsToFinish(report: ImportReport): number {
	const { folders, bodiesWithoutFile } = report.fileNeeds;
	return (
		report.notices.filter((notice) => notice.tier === "action").length +
		(folders.length > 0 ? 1 : 0) +
		(bodiesWithoutFile > 0 ? 1 : 0)
	);
}

/** "60 requests, 4 folders": what arrived, leaving out what the file did not carry. */
function countsPhrase({ counts }: ImportReport): string {
	const parts = [
		{ n: counts.requests, one: "request", other: "requests" },
		{ n: counts.folders, one: "folder", other: "folders" },
		{ n: counts.environments, one: "environment", other: "environments" },
		{ n: counts.globals, one: "global", other: "globals" },
	]
		.filter(({ n }) => n > 0)
		.map(({ n, one, other }) => `${n} ${pluralize(n, one, other)}`);
	return parts.length > 0 ? parts.join(", ") : "0 requests";
}

/**
 * One sentence for the whole apply: the file by name, or the files by count,
 * then what became of the active environment, if the import touched it.
 */
export function importToastMessage(
	reports: readonly ImportReport[],
	environment?: EnvironmentOutcome
): string {
	const imported =
		reports.length === 1
			? `Imported "${reports[0].title}" - ${countsPhrase(reports[0])}`
			: `Imported ${reports.length} files`;
	const toFinish = reports.reduce((sum, report) => sum + thingsToFinish(report), 0);
	const finish = toFinish > 0 ? `; ${toFinish} ${pluralize(toFinish, "thing")} to finish` : "";
	const activation = environment ? `; ${environmentClause(environment)}` : "";
	return `${imported}${finish}${activation}.`;
}

/** Open a collection on its Info tab, where the report it carries is shown. */
function openImportNotes(rootId: string): void {
	useTabSelectionStore.getState().setCollectionTab(rootId, "info");
	useTabsStore.getState().openTab({ type: "collection", entityId: rootId });
}

/**
 * Keep every file's report, expand and open what was created, and raise the toast.
 *
 * The first new collection becomes the active tab - two imports are not two
 * things to look at - while every new root is expanded so the sidebar shows
 * all of them.
 *
 * The toast has one action slot. "Review import notes" holds it whenever there
 * is a report to read, and the environment outcome (#2115) then rides in the
 * message alone; otherwise the outcome's own action, if it has one, takes it.
 */
export function announceImport(
	reports: readonly ImportReport[],
	environment?: EnvironmentOutcome
): void {
	if (reports.length === 0) return;
	for (const report of reports) useImportReportStore.getState().record(report);

	const rootIds = reports.flatMap((report) => report.rootIds);
	useCollectionsStore.getState().expandCollections(rootIds);
	if (rootIds.length > 0) {
		useTabsStore.getState().openTab({ type: "collection", entityId: rootIds[0] });
	}

	const noted = reports.find((report) => hasReport(report) && report.rootIds.length > 0);
	const action = noted
		? { label: "Review import notes", onClick: () => openImportNotes(noted.rootIds[0]) }
		: environment && environmentAction(environment);
	useToastStore.getState().showToast({
		message: importToastMessage(reports, environment),
		variant: "success",
		...(action ? { action } : {}),
	});
}
