/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import {
	Circle,
	CircleAlert,
	CircleCheck,
	CircleQuestionMark,
	CircleSlash,
	CircleX,
	Loader2,
	type LucideIcon,
} from "lucide-react";
import type { Run } from "@/types";
import type { RunOutcome } from "./run-outcome";

/**
 * How a run's status is drawn, once: the history row's glyph and the dashboard header's pill read
 * this map, so a status cannot be green in one and neutral in the other (#1932). One glyph per
 * status, shape first, colour second (#1691): a coloured dot made colour the whole message, which a
 * red/green confusion, a monochrome display or a greyscale screenshot flattens. `text` is the
 * `-text` token, as small glyphs and words fail AA on the bare token
 * (`status-color-tokens.test.ts`); `tint` is the pill's fill and edge, an area of colour, where the
 * bare token is right.
 */
export interface RunStatusDisplay {
	label: string;
	icon: LucideIcon;
	text: string;
	tint: string;
	spin?: boolean;
}

export const RUN_STATUS: Record<Run["status"], RunStatusDisplay> = {
	completed: {
		label: "Completed",
		icon: CircleCheck,
		text: "text-status-success-text",
		tint: "bg-status-success/15 border-status-success/25",
	},
	failed: {
		label: "Failed",
		icon: CircleX,
		text: "text-status-error-text",
		tint: "bg-status-error/15 border-status-error/25",
	},
	running: {
		label: "Running",
		icon: Loader2,
		text: "text-status-running-text",
		tint: "bg-status-running/15 border-status-running/25",
		spin: true,
	},
	stopped: {
		label: "Stopped",
		icon: CircleSlash,
		text: "text-status-stopped-text",
		tint: "bg-status-stopped/15 border-status-stopped/25",
	},
	pending: {
		label: "Pending",
		icon: Circle,
		text: "text-muted-foreground",
		tint: "bg-muted border-border",
	},
};

/**
 * A `completed` run is not necessarily good (#2130), so once it has a verdict the tick is only for
 * one that earned it: a failed verdict is a ringed exclamation (error family), an unjudged one a
 * ringed question mark (neutral). Neither is the `failed` status's cross, as the run did finish,
 * and neither shares the tick's shape.
 */
const COMPLETED_OUTCOME: Record<Exclude<RunOutcome, "passed">, RunStatusDisplay> = {
	failed: {
		label: RUN_STATUS.completed.label,
		icon: CircleAlert,
		text: "text-status-error-text",
		tint: "bg-status-error/15 border-status-error/25",
	},
	"not-judged": {
		label: RUN_STATUS.completed.label,
		icon: CircleQuestionMark,
		text: "text-muted-foreground",
		tint: "bg-muted border-border",
	},
};

/**
 * How a run is drawn: its status, refined by its verdict when it has one. Only `completed` is
 * refined: every other status says more than a verdict could (`failed` is a failure, `stopped`
 * never judged, a live run has none yet), and `passed` keeps the tick.
 */
export function runStatusDisplay(status: Run["status"], outcome?: RunOutcome): RunStatusDisplay {
	if (status === "completed" && outcome && outcome !== "passed") {
		return COMPLETED_OUTCOME[outcome];
	}
	return RUN_STATUS[status];
}
