/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { X } from "lucide-react";
import { Button } from "@/components/ui";
import { Callout } from "@/components/shared";
import { selectImportReport, useImportReportStore } from "@/stores/import-report-store";
import { FileReferenceNeedsView } from "../ImportFileFolders";
import { NoticeList } from "../NoticeList";

/**
 * What the import preview said was lost or changed, kept on the collection it
 * created until the user dismisses it (issue #2109).
 *
 * The toast that announces an import can expire, and the dialog that showed
 * the ledger is gone, so this is the copy that outlives both. It draws the same
 * `NoticeList` and file-reference list the preview does rather than a second
 * rendering of them. Renders nothing for a collection no import recorded a
 * report for, which is nearly every collection.
 */
export function ImportNotesCallout({ rootId }: { rootId: string }) {
	const report = useImportReportStore(selectImportReport(rootId));
	const dismiss = useImportReportStore((state) => state.dismiss);
	if (!report) return null;

	return (
		<Callout
			severity="info"
			action={
				<Button
					size="icon"
					variant="ghost"
					aria-label="Dismiss import notes"
					onClick={() => dismiss(rootId)}
				>
					<X className="size-icon-sm" />
				</Button>
			}
		>
			<div className="space-y-2">
				<div>
					<span className="font-semibold">Import notes</span>
					{report.fileName && (
						<span className="ml-2 font-mono text-label text-muted-foreground">
							{report.fileName}
						</span>
					)}
				</div>
				<NoticeList notices={report.notices} />
				<FileReferenceNeedsView needs={report.fileNeeds} />
			</div>
		</Callout>
	);
}
