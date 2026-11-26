/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Progress } from "@/components/ui";
import { formatBytes } from "@/lib/format-number";
import { IMPORT_STAGE_LABELS } from "@/constants/import";
import { pluralize } from "@/modules/dashboard/utils/format";

/**
 * What the import dialog is doing, and how far through it is (issue #882). Four genuinely different
 * waits: a URL download, a `$ref` walk across disk or the network, one engine round trip per
 * document to read it, and one atomic write per document to store it. Naming the running one is
 * half the report: "Importing" during a two-minute download would lie about what takes the time.
 *
 * `fetching` counts bytes and the rest count documents, hence a union rather than a `{done, total}`
 * with a label: bytes and files format differently, and `total` can be *unknown* for bytes, never
 * for files.
 */
export type ImportProgress =
	/**
	 * Picked files coming off disk, before anything has looked at them. No figures: `FileReader` is
	 * local and effectively instant, so a counter would be motion without information, but the
	 * *name* shows, as a folder of large specs spends a real moment here.
	 */
	| { stage: "reading" }
	| { stage: "fetching"; received: number; total: number | null }
	| { stage: "bundling" | "parsing" | "applying"; done: number; total: number };

/** The figures under the bar - the part that proves a stalled bar has moved. */
function detailOf(progress: ImportProgress): string {
	if (progress.stage === "reading") return "";
	if (progress.stage === "fetching") {
		return progress.total === null
			? `${formatBytes(progress.received)} received`
			: `${formatBytes(progress.received)} of ${formatBytes(progress.total)}`;
	}
	const unit = pluralize(progress.total, "file");
	return `${progress.done} of ${progress.total} ${unit}`;
}

/** 0..1, or null when nothing stated a total to be a fraction of. */
function fractionOf(progress: ImportProgress): number | null {
	if (progress.stage === "reading") return null;
	if (progress.stage === "fetching") {
		return progress.total === null || progress.total === 0
			? null
			: progress.received / progress.total;
	}
	return progress.total === 0 ? null : progress.done / progress.total;
}

export function ImportProgressView({ progress }: { progress: ImportProgress }) {
	const label = IMPORT_STAGE_LABELS[progress.stage];
	const detail = detailOf(progress);
	return (
		<div className="enter-fade space-y-2">
			{/*
			 * The one line saying what is happening, announced (#1691), as the shorter operations
			 * either side of it (the export dialog, the tree's busy states) announce with
			 * `role="status"`. The region is the visible line itself, not an off-screen copy, so
			 * one string stays in step.
			 *
			 * The byte counter is left out: a polite region re-announces every text change, and a
			 * download ticking several times a second would talk over everything else in the
			 * dialog; the file counts, moving once per document, stay in.
			 */}
			<div
				role="status"
				aria-live="polite"
				className="flex items-baseline justify-between gap-3"
			>
				<span className="text-xs font-medium">{label}</span>
				{detail && (
					<span
						aria-hidden={progress.stage === "fetching"}
						className="font-mono text-label text-muted-foreground"
					>
						{detail}
					</span>
				)}
			</div>
			<Progress value={fractionOf(progress)} label={label} />
		</div>
	);
}
