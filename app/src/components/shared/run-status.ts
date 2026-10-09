/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { Circle, CircleCheck, CircleSlash, CircleX, Loader2, type LucideIcon } from "lucide-react";
import type { Run } from "@/types";

/**
 * How a run's status is drawn, once: the history row's glyph and the dashboard
 * header's pill both read this map, so a status cannot be green in one and
 * neutral in the other (#1932, where a failed run showed as Completed).
 *
 * One glyph per status - shape first, colour second (#1691). A bare coloured dot
 * made the colour the whole message, and a red/green confusion, a monochrome
 * display or a pasted greyscale screenshot flattens five of them into one. The
 * shape and the word carry the status; the colour agrees with them.
 *
 * `text` is the `-text` token, not the bare fill: these are small glyphs and
 * words, and the bare token fails AA as a foreground
 * (`status-color-tokens.test.ts`). `tint` is the pill's own fill and edge, where
 * the bare token is correct because it is an area of colour.
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
