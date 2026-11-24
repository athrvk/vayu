/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The console output of a request's two scripts: one `ScriptError` and one `ScriptLogs`, each
 * rendered twice, the differences in a table. Every box has a radius class, so it follows the
 * Roundedness setting.
 *
 * The log slabs are `surface-sunken`, not a border token: measured in the running app, no token
 * outlines a `bg-muted` box in both themes:
 *
 * light    dark --border       on --muted    1.105    1.157 --border-strong on --muted   1.317
 * 1.108
 *
 * `--border-strong`, the usual escape hatch on `--card`, is the worse in dark, since `--muted` (L
 * 16%) sits between `--border` (L 10%) and `--border-strong` (L 18%): strengthening the border
 * fades it. `surface-sunken` is an alpha of `--foreground`, flipping with the theme, at 1.356 light
 * / 1.343 dark, a parity no single token gives.
 */

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { EmptyState } from "@/components/shared";
import type { ConsoleLogEntry, ScriptRequestRecord } from "@/types";
import { consoleRows, rowMatches } from "./console/console-rows";
import { parseConsoleLogs, splitBySource } from "./console/parse-logs";
import { ScriptError, ScriptLogs } from "./console/ScriptSection";

export interface ConsoleOutputProps {
	/** A `string` is the engine's pre-structured shape; see `parse-logs.ts`. */
	logs: Array<ConsoleLogEntry | string>;
	/** The scripts' `pm.sendRequest` records (#3633), drawn among the lines. */
	scriptRequests?: ScriptRequestRecord[];
	errors: {
		pre?: string;
		post?: string;
	};
}

export default function ConsoleOutput({ logs, scriptRequests, errors }: ConsoleOutputProps) {
	const [filter, setFilter] = useState("");

	/*
	 * The filter runs over *every* log, not what is rendered: the list renders progressively, so
	 * filtering the rendered slice would search only what was scrolled past (the virtualised-DOM
	 * trap). Matching runs on the parsed lines before the window is taken, so a match ten thousand
	 * lines down is found unvisited; a script request is a row like a line.
	 */
	const rows = useMemo(
		() => consoleRows(parseConsoleLogs(logs), scriptRequests),
		[logs, scriptRequests]
	);
	const bySource = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return splitBySource(needle ? rows.filter((row) => rowMatches(row, needle)) : rows);
	}, [rows, filter]);

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

			{rows.length === 0 ? (
				<EmptyState variant="inline" title="No console output" />
			) : (
				<div className="space-y-3">
					<div className="relative">
						<Search className="pointer-events-none absolute left-2 top-1/2 size-icon-sm -translate-y-1/2 text-muted-foreground" />
						<Input
							size="sm"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter logs"
							aria-label="Filter console output"
							// `md:text-xs` as well: the Input primitive carries `md:text-sm`, and
							// tailwind-merge keeps a responsive variant in its own group, so a bare
							// `text-xs` loses above 768px.
							className="pl-7 text-xs md:text-xs"
						/>
					</div>

					{filtering && matched === 0 ? (
						<EmptyState
							variant="inline"
							title="No log matches that filter"
							action={
								<Button variant="link" onClick={() => setFilter("")}>
									Clear the filter
								</Button>
							}
						/>
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
