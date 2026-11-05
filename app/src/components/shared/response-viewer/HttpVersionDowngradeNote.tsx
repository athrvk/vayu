/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "HTTP/1.1, not HTTP/2": the one line that says an exchange asked for HTTP/2
 * and negotiated something older (issue #215).
 *
 * Shared by the status bar above a response and by a collection run's step
 * card, whose viewer has no status bar (#3262) - a second hand-written line
 * would not receive this one's wording or its hover. Draw it only when the
 * response is flagged: a note on every response is a note nobody reads.
 *
 * Text, not a `Badge`: it paints no background, and the variant="chip" rule in
 * badge-hover.test.tsx exists for the ones that do.
 */

import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HttpVersionDowngradeNoteProps {
	/**
	 * What the connection negotiated, as a display string ("HTTP/1.1"). Falls back
	 * to "HTTP/1.1" in the label and "an older protocol" in the hover when the
	 * engine recorded none.
	 */
	httpVersion?: string;
	className?: string;
}

export function HttpVersionDowngradeNote({
	httpVersion,
	className,
}: HttpVersionDowngradeNoteProps) {
	return (
		<div
			className={cn("flex items-center gap-1.5 text-xs text-status-warning-text", className)}
			title={
				`HTTP/2 was requested, but the connection negotiated ` +
				`${httpVersion || "an older protocol"}.\n` +
				`Timings and throughput below describe that connection, not HTTP/2.`
			}
		>
			<AlertTriangle className="size-icon-sm" />
			<span>{httpVersion || "HTTP/1.1"}, not HTTP/2</span>
		</div>
	);
}
