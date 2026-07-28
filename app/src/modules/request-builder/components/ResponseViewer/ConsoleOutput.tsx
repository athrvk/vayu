/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The console output of a request's two scripts.
 *
 * This was 212 lines, roughly 120 of which were two pairs of near-identical
 * blocks - the pre/post error cards and the pre/test log sections - each pair
 * differing in a status token and a heading. They are one `ScriptError` and one
 * `ScriptLogs` now, rendered twice, with the differences in a table.
 *
 * The four boxes here were also the module's square-corner cluster: no radius
 * class at all, so they stayed sharp at every Roundedness setting while their
 * neighbours followed it.
 *
 * The log slabs additionally dropped `border border-border`. Measured in the
 * running app, no border token outlines a `bg-muted` box in both themes:
 *
 *                                  light    dark
 *     --border       on --muted    1.105    1.157
 *     --border-strong on --muted   1.317    1.108
 *
 * `--border-strong` is the usual escape hatch on `--card` - it is what fixed the
 * URL bar and the history rows - and here it is the *worse* of the two in dark,
 * because `--muted` (L 16%) sits between `--border` (L 10%) and
 * `--border-strong` (L 18%). Strengthening the border makes it fainter.
 * Whichever token is picked, one theme gets no edge at all.
 *
 * So there was no border *token* to pick, and the slabs went without one. That
 * is no longer the best available answer: `surface-sunken` is not a token but an
 * alpha of `--foreground`, which flips with the theme and lands on 1.356 light /
 * 1.343 dark - parity a single token cannot give. The reasoning above is kept
 * because it is still why every token was rejected; what changed is that the
 * surface contract arrived after it was written.
 */

import { useMemo } from "react";
import { EmptyState } from "@/components/shared";
import { parseConsoleLogs, splitBySource } from "./console/parse-logs";
import { ScriptError, ScriptLogs } from "./console/ScriptSection";

export interface ConsoleOutputProps {
	logs: string[];
	errors: {
		pre?: string;
		post?: string;
	};
}

export default function ConsoleOutput({ logs, errors }: ConsoleOutputProps) {
	const bySource = useMemo(() => splitBySource(parseConsoleLogs(logs)), [logs]);

	return (
		<div className="p-4 overflow-auto h-full space-y-4">
			{(errors.pre || errors.post) && (
				<div className="space-y-2">
					{errors.pre && <ScriptError which="pre" message={errors.pre} />}
					{errors.post && <ScriptError which="test" message={errors.post} />}
				</div>
			)}

			{logs.length === 0 ? (
				<EmptyState variant="inline" title="No console output" />
			) : (
				<div className="space-y-3">
					<ScriptLogs which="pre" logs={bySource.pre} />
					<ScriptLogs which="test" logs={bySource.test} />
				</div>
			)}
		</div>
	);
}
