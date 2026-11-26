/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "Stop the run happening now", one treatment wherever a run can be cancelled (the load-test
 * dashboard header, the collection-run tab). A primitive, not markup each view repeats: the
 * treatment is no `Button` variant (a destructive *outline* over `ghost`, plus the in-flight swap
 * to a spinner and "Stopping…"), and a hand-rolled copy would miss its fixes. `destructive-text`,
 * not `destructive`, for the label: the bare fill token as a foreground is the repo's most frequent
 * colour bug (`docs/design-system/chart-colors.md`). The caller owns the request and the failure
 * path; this says only what pending looks like, not what stopping means.
 */

import { StopCircle, Loader2 } from "lucide-react";
import { Button, LabelSwap } from "@/components/ui";
import { cn } from "@/lib/utils";

const DEFAULT_LABEL = "Stop";

interface StopRunButtonProps {
	onStop: () => void;
	/** True while the stop request is in flight; the button disables and says so. */
	isStopping?: boolean;
	/**
	 * The idle word: "Stop waiting" while a run only drains its in-flight requests (#3568), with no
	 * load left to stop.
	 */
	label?: string;
	className?: string;
}

export function StopRunButton({
	onStop,
	isStopping = false,
	label = DEFAULT_LABEL,
	className,
}: StopRunButtonProps) {
	return (
		<Button
			size="sm"
			variant="ghost"
			onClick={onStop}
			disabled={isStopping}
			className={cn(
				"h-control-sm px-2.5 text-xs text-destructive-text hover:bg-destructive/10 hover:text-destructive-text border border-destructive/30 shrink-0",
				className
			)}
		>
			{/*
			 * No `mr-*`: the `Button` base sets `gap-2`, and a margin on top would double the
			 * icon-to-label gap to 8px + 6px.
			 */}
			{isStopping ? (
				<Loader2 className="size-icon-sm animate-spin" />
			) : (
				<StopCircle className="size-icon-sm" />
			)}
			<LabelSwap label={isStopping ? "Stopping…" : label} states={[label, "Stopping…"]} />
		</Button>
	);
}
