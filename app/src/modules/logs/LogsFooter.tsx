/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the Logs tab is holding and what it is not showing (#3635): the held
 * lines and their estimated size, the lines the tail left out of a burst, and
 * the engine's log level, which decides what there is to see. Requests answered
 * 2xx and database writes are `debug`, so a quiet default level shows no
 * request lines at all - which reads as a broken tab without this line.
 */

import { Button } from "@/components/ui";
import { formatBytes, formatNumber } from "@/lib/format-number";
import { revealSettingsCategory } from "@/lib/commands/reveal-settings";
import { pluralize } from "@/modules/dashboard/utils/format";
import { useConfigQuery } from "@/queries";
import { useEngineStore } from "@/stores/engine-store";
import { useLogsStore } from "./logs-store";

/** The engine's `logLevel` entry, which also sets the app's and the CLI's files. */
const LOG_LEVEL_KEY = "logLevel";

function HeldCount() {
	const held = useLogsStore((s) => s.records.length);
	const bytes = useLogsStore((s) => s.bytes);
	return (
		<span className="tabular-nums">
			{formatNumber(held)} {pluralize(held, "line")}, about {formatBytes(bytes)}
		</span>
	);
}

function DroppedCount() {
	const dropped = useLogsStore((s) => s.dropped);
	if (dropped === 0) return null;
	return (
		<span
			className="tabular-nums"
			title="Following shows at most 500 lines every half second. The lines left out are in the log files."
		>
			{formatNumber(dropped)} {pluralize(dropped, "line")} skipped in a burst
		</span>
	);
}

function LogLevelHint() {
	const { data: config } = useConfigQuery();
	const level = config?.entries?.find((entry) => entry.key === LOG_LEVEL_KEY)?.value;
	// The saved value is what the next start writes at; until then the files
	// keep the level the engine started with (#3681).
	const pending = useEngineStore((s) => s.restartRequiredKeys.includes(LOG_LEVEL_KEY));
	return (
		<span>
			{level !== undefined &&
				(pending
					? `Log level: ${level} after the restart; the running engine keeps its current level until then. `
					: `Log level: ${level}. `)}
			Requests answered 2xx and database writes are logged at debug. Change the level in{" "}
			<Button
				type="button"
				variant="link"
				className="h-auto p-0 align-baseline text-xs"
				onClick={() => revealSettingsCategory("observability")}
			>
				Settings › Observability
			</Button>
			; it applies after a restart.
		</span>
	);
}

export function LogsFooter() {
	return (
		<div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-t border-rule px-3 py-1 text-xs text-muted-foreground">
			<HeldCount />
			<DroppedCount />
			<LogLevelHint />
		</div>
	);
}
