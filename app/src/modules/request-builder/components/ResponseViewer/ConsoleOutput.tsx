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

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui";
import { EmptyState } from "@/components/shared";
import type { ConsoleLogEntry } from "@/types";
import { parseConsoleLogs, splitBySource } from "./console/parse-logs";
import { ScriptError, ScriptLogs } from "./console/ScriptSection";

export interface ConsoleOutputProps {
	/** A `string` is the pre-structured engine shape - see `parse-logs.ts`. */
	logs: Array<ConsoleLogEntry | string>;
	errors: {
		pre?: string;
		post?: string;
	};
}

export default function ConsoleOutput({ logs, errors }: ConsoleOutputProps) {
	const [filter, setFilter] = useState("");

	/*
	 * The filter runs over *every* log, not over what is currently rendered.
	 *
	 * That distinction is the whole point: the list renders progressively, so a
	 * filter applied to the rendered slice would search only the part you had
	 * already scrolled past - which is the same trap as searching a virtualised
	 * list's DOM. Matching happens on the parsed lines, before the window is
	 * taken, so a match ten thousand lines down is found without being visited.
	 */
	const bySource = useMemo(() => {
		const parsed = parseConsoleLogs(logs);
		const needle = filter.trim().toLowerCase();
		return splitBySource(
			needle ? parsed.filter((l) => l.message.toLowerCase().includes(needle)) : parsed
		);
	}, [logs, filter]);

	const matched = bySource.pre.length + bySource.test.length;
	const filtering = filter.trim().length > 0;

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
					<div className="relative">
						<Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter logs"
							aria-label="Filter console output"
							// `md:text-xs` as well as `text-xs`: the Input primitive's base
							// classes carry `md:text-sm`, and tailwind-merge keeps a
							// responsive variant in its own group - so an unqualified
							// `text-xs` loses to it above 768px and the field renders a
							// step larger than everything around it.
							className="h-7 pl-7 text-xs md:text-xs"
						/>
					</div>

					{filtering && matched === 0 ? (
						<EmptyState variant="inline" title="No log matches that filter" />
					) : (
						<>
							<ScriptLogs which="pre" logs={bySource.pre} />
							<ScriptLogs which="test" logs={bySource.test} />
						</>
					)}
				</div>
			)}
		</div>
	);
}
