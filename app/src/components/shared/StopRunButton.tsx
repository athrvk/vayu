/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * StopRunButton
 *
 * "Stop the run that is happening right now" - the one treatment, wherever a
 * run can be cancelled. Two places call it: the load-test dashboard header and
 * the collection-run tab.
 *
 * It exists as a primitive rather than as markup each view repeats because the
 * treatment is not a `Button` variant: a destructive *outline* over `ghost`,
 * which no variant paints, plus the in-flight swap to a spinner and
 * "Stopping…". A second hand-rolled copy of that would not receive this one's
 * fixes.
 *
 * `destructive-text`, not `destructive`, for the label - the bare fill token as
 * a foreground is the colour bug this repo hits most (`docs/design-system/chart-colors.md`).
 *
 * The caller owns the request and the failure path. This is a button: it says
 * what the pending state looks like and nothing about what stopping means.
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
	 * The word for the idle state. "Stop waiting" while a run only drains its
	 * in-flight requests (#3568): there is no load left to stop.
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
			 * No `mr-*` here: the `Button` primitive's base string already sets
			 * `gap-2` on its flex children, so a margin on top of it doubled the
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
