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
 * a foreground is the colour bug this repo hits most (`docs/design-system.md`).
 *
 * The caller owns the request and the failure path. This is a button: it says
 * what the pending state looks like and nothing about what stopping means.
 */

import { StopCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

interface StopRunButtonProps {
	onStop: () => void;
	/** True while the stop request is in flight; the button disables and says so. */
	isStopping?: boolean;
	className?: string;
}

export function StopRunButton({ onStop, isStopping = false, className }: StopRunButtonProps) {
	return (
		<Button
			size="sm"
			variant="ghost"
			onClick={onStop}
			disabled={isStopping}
			className={cn(
				"h-7 px-2.5 text-xs text-destructive-text hover:bg-destructive/10 hover:text-destructive-text border border-destructive/30 shrink-0",
				className
			)}
		>
			{isStopping ? (
				<>
					<Loader2 className="w-3 h-3 animate-spin mr-1.5" />
					Stopping…
				</>
			) : (
				<>
					<StopCircle className="w-3 h-3 mr-1.5" />
					Stop
				</>
			)}
		</Button>
	);
}
