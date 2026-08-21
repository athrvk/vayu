/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Progress } from "@/components/ui";
import { formatBytes } from "@/modules/settings/utils/format-size";
import { IMPORT_STAGE_LABELS } from "@/constants/import";

/**
 * What the import dialog is doing, and how far through it is (issue #882).
 *
 * Four stages, and they are four genuinely different waits: a download from a
 * URL, a `$ref` walk across disk or the network, one engine round trip per
 * document to read it, and one atomic write per document to store it. Naming
 * which one is running is half the report - "Importing" during a two-minute
 * download would be a lie about what is taking the time.
 *
 * `fetching` counts bytes and the rest count documents, which is why this is a
 * union rather than a `{done, total}` with a label: bytes and files format
 * differently, and `total` can be *unknown* for bytes and never is for files.
 */
export type ImportProgress =
	/**
	 * Picked files coming off disk, before anything has looked at them. The one
	 * stage with no figures: `FileReader` is local and effectively instant, so a
	 * counter here would be motion without information - but the *name* still
	 * belongs on screen, because a folder of large specs spends a real moment
	 * here and "Reading files" is what is happening.
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
	const unit = progress.total === 1 ? "file" : "files";
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
		<div className="space-y-2">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-xs font-medium">{label}</span>
				{detail && (
					<span className="font-mono text-[11px] text-muted-foreground">{detail}</span>
				)}
			</div>
			<Progress value={fractionOf(progress)} label={label} />
		</div>
	);
}
