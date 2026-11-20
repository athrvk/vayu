/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A line a Send's script wrote, or the error it threw (#3673), in the session
 * Console (#3634): the time, the
 * level in the gutter the response pane's Console and the Logs tab draw
 * (`LEVEL_TONE`, `LogGutter`), the script that wrote it, and the message as
 * written. Nothing to open, so no button.
 */

import { memo } from "react";
import { LEVEL_TONE } from "@/components/shared/console-level";
import { LogGutter } from "@/components/shared/LogGutter";
import { TimeValue } from "@/components/shared/TimeValue";
import { cn } from "@/lib/utils";
import type { ConsoleLineRow, ConsoleRow } from "@/stores/console-store";
import ScopeTag from "@/modules/request-builder/components/ResponseViewer/ScopeTag";
import { SCRIPT_SECTIONS } from "@/modules/request-builder/components/ResponseViewer/console/script-sections";

export const LineRow = memo(function LineRow({ row }: { row: ConsoleRow & ConsoleLineRow }) {
	const tone = LEVEL_TONE[row.level];
	return (
		<div className="flex items-baseline gap-2 px-4 py-0.5 font-mono text-xs leading-5">
			<TimeValue value={row.at} style="time-ms" className="shrink-0 text-muted-foreground" />
			<LogGutter label={tone.gutter} labelClassName={tone.label} />
			<pre className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", tone.text)}>
				{row.message}
			</pre>
			<ScopeTag scope={row.scope} className="font-sans" />
			<span className="shrink-0 font-sans text-micro text-muted-foreground">
				{SCRIPT_SECTIONS[row.source].label}
			</span>
		</div>
	);
});
