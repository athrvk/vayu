/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RunExportMenu Component
 *
 * A finished load run as a file to share (#2139): the run tab's header and the
 * post-run dashboard's both mount it, and each mounts it only for a finished
 * load run - the engine refuses any other (`read_exportable_run`).
 *
 * The engine writes the document, names the file and picks its type; this menu
 * asks, then hands the answer to `downloadTextFile` untouched. A failed export
 * downloads nothing and says why, in the engine's words.
 *
 * The items are `runExportActions`, the list the palette's export commands are
 * generated from, and the palette reaches them through this menu's own handler
 * (`useRegisterExportRunSurface`): the comparison toggle below decides what a
 * palette export carries too.
 */

import { useId, useState } from "react";
import { Copy, Download } from "lucide-react";
import {
	Button,
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui";
import { useCopy } from "@/hooks/useCopy";
import { useRegisterExportRunSurface } from "@/lib/commands";
import { downloadTextFile } from "@/lib/download-text-file";
import { formatNumber } from "@/lib/format-number";
import { runExportActions, type RunExportAction } from "@/lib/run-export-formats";
import { pluralize } from "@/modules/dashboard/utils/format";
import { useRunReportExport } from "@/queries/exports";
import { useToastStore } from "@/stores";
import type { RunReportExportResponse } from "@/types";
import { usePinnedBaseline } from "./usePinnedBaseline";

export interface RunExportMenuProps {
	/** A finished load run. The caller gates on that; this menu does not. */
	runId: string;
	/**
	 * The report's `metadata.requestUrl` / `requestMethod`, which find the
	 * baseline of a run whose row names no saved request. Primitives, so the
	 * memo'd dashboard header can pass them through.
	 */
	requestUrl?: string | null;
	requestMethod?: string | null;
}

/** "Exported <file>", plus what the URL lost on the way out when it lost anything. */
function savedMessage({ fileName, notes }: RunReportExportResponse): string {
	const omitted = notes.urlCredentialsOmitted;
	if (omitted <= 0) return `Exported ${fileName}`;
	return `Exported ${fileName} - ${formatNumber(omitted)} URL ${pluralize(omitted, "credential")} left out`;
}

export default function RunExportMenu({ runId, requestUrl, requestMethod }: RunExportMenuProps) {
	const { baselineId } = usePinnedBaseline(runId, requestUrl, requestMethod);
	const [includeComparison, setIncludeComparison] = useState(true);
	const { mutateAsync, isPending } = useRunReportExport();
	const showToast = useToastStore((s) => s.showToast);
	const { copy } = useCopy();
	const noteId = useId();

	const baseRunId = includeComparison ? baselineId : null;

	const deliver = async (action: RunExportAction) => {
		let result: RunReportExportResponse;
		try {
			result = await mutateAsync({
				runId,
				format: action.format.id,
				...(baseRunId ? { baseRunId } : {}),
			});
		} catch (error) {
			showToast(
				error instanceof Error
					? `Couldn't export the run - ${error.message}`
					: "Couldn't export the run",
				"error"
			);
			return;
		}
		if (action.delivery === "copy") {
			await copy(result.text, `${action.format.name} report`);
			return;
		}
		downloadTextFile(result.text, result.fileName, result.mimeType);
		showToast(savedMessage(result), "success");
	};

	// Withdrawn while one export is in flight, as the items are disabled: a
	// second would download the file twice.
	useRegisterExportRunSurface(isPending ? null : (action) => void deliver(action));

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="h-control-sm shrink-0 gap-1.5 px-2 text-xs"
				>
					<Download className="size-icon-sm" aria-hidden="true" />
					Export
				</Button>
			</DropdownMenuTrigger>
			{/* `bg-card surface-card`: `--popover` and `--card` are one colour, and
			    only the card declares the `--rule` the note's divider reads. */}
			<DropdownMenuContent
				align="end"
				aria-describedby={noteId}
				className="w-[17rem] bg-card surface-card text-card-foreground"
			>
				{runExportActions().map((action) => (
					<DropdownMenuItem
						key={action.id}
						disabled={isPending}
						onSelect={() => void deliver(action)}
					>
						{action.delivery === "save" ? (
							<Download aria-hidden="true" />
						) : (
							<Copy aria-hidden="true" />
						)}
						{action.label}
					</DropdownMenuItem>
				))}
				{baselineId && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuCheckboxItem
							checked={includeComparison}
							onCheckedChange={setIncludeComparison}
							// A toggle, not an action: the menu stays open for the
							// export it qualifies.
							onSelect={(e) => e.preventDefault()}
						>
							Include comparison with baseline
						</DropdownMenuCheckboxItem>
					</>
				)}
				<div
					id={noteId}
					className="mt-1 space-y-0.5 border-t border-rule px-2 pb-1 pt-2 text-xs text-muted-foreground"
				>
					<p>Includes the target URL, names, and comments you wrote.</p>
					<p>Leaves out request and response data.</p>
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
