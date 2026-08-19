/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TestResults Component
 *
 * Displays test execution results with pass/fail status, grouped by the script
 * that made them.
 */

import { CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScriptSource, TestResult } from "@/types";
import { SCRIPT_SECTIONS } from "./console/ScriptSection";

export interface TestResultsProps {
	results: readonly TestResult[];
	/**
	 * Whether this component owns its padding and scroll box. False when the
	 * Tests tab is stacking it under a schema verdict (issue #628), which owns
	 * both for the pair - two scroll boxes in one pane scroll independently, and
	 * two paddings indent the list twice.
	 */
	inset?: boolean;
}

/** In execution order, which is the order the engine lists them in. */
const SOURCES: readonly ScriptSource[] = ["pre", "test"];

/**
 * An entry with no `source` came from an engine - or a stored trace - older
 * than issue #810, which listed the post-request script's assertions and
 * nothing else. Reading it as `"test"` is what that list meant, not a guess.
 */
function sourceOf(test: TestResult): ScriptSource {
	return test.source === "pre" ? "pre" : "test";
}

export default function TestResults({ results, inset = true }: TestResultsProps) {
	const passedCount = results.filter((t) => t.passed).length;
	const failedCount = results.length - passedCount;

	/*
	 * Grouped by script, with a heading over each group that has anything in it
	 * (issue #810).
	 *
	 * The heading is on every group rather than only when both are present: a
	 * list of assertions made *before* the request went out is a different claim
	 * from one made about the response, and a run whose only assertions are
	 * pre-request ones would otherwise read as the latter with nothing to say
	 * so. The labels come from `SCRIPT_SECTIONS`, the same table the Console
	 * tab's sections use, so the two panes cannot name the scripts differently.
	 *
	 * Neutral text rather than that table's identity tones: in this list colour
	 * already means a verdict, and a green section heading over a failed
	 * assertion would be saying the opposite of the card under it.
	 */
	const groups = SOURCES.map((source) => ({
		source,
		label: SCRIPT_SECTIONS[source].label,
		tests: results.filter((test) => sourceOf(test) === source),
	})).filter((group) => group.tests.length > 0);

	return (
		<div className={inset ? "p-4 overflow-auto h-full" : undefined}>
			{/*
			 * The summary reads as text, not a chip.
			 *
			 * It was a `text-sm` Badge, which made it the loudest thing in a panel
			 * whose *content* is the results - and the tab trigger directly above
			 * already carries a pass/fail chip, so a second one restated it more
			 * loudly than the thing it summarised. Failures keep a colour, because
			 * "2 failed" is the one part worth finding without reading.
			 */}
			<p className="mb-3 text-xs text-muted-foreground">
				<span className="text-foreground font-medium tabular-nums">{passedCount}</span>{" "}
				passed
				{failedCount > 0 && (
					<>
						{", "}
						<span className="text-status-error-text font-medium tabular-nums">
							{failedCount}
						</span>{" "}
						failed
					</>
				)}
			</p>

			{/*
			 * `text-xs` and 14px icons, matching the pane. This ran at `text-sm`
			 * with `w-5 h-5` icons - a ~52px row in the one tab whose job is
			 * listing every assertion a script made, while the tables beside it
			 * had just been taken to 12px.
			 */}
			<div className="space-y-3">
				{groups.map((group) => (
					<section key={group.source} className="space-y-1.5">
						<h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
							{group.label}
						</h3>
						{group.tests.map((test, i) => (
							<div
								key={i}
								className={cn(
									// `rounded-md`: these were the only square-cornered
									// cards in the response pane, and they ignored the
									// Roundedness setting entirely.
									"p-2.5 rounded-md border",
									test.passed
										? "bg-status-success/10 border-status-success/20"
										: "bg-status-error/10 border-status-error/20"
								)}
							>
								<div className="flex items-start gap-2">
									{test.passed ? (
										<CheckCircle className="w-3.5 h-3.5 text-status-success-text mt-px shrink-0" />
									) : (
										<XCircle className="w-3.5 h-3.5 text-status-error-text mt-px shrink-0" />
									)}
									<div className="flex-1 min-w-0">
										<p
											className={cn(
												"text-xs font-medium",
												test.passed
													? "text-status-success-text"
													: "text-status-error-text"
											)}
										>
											{test.name}
										</p>
										{test.error && (
											<pre className="text-[11px] text-status-error-text mt-1 font-mono whitespace-pre-wrap break-words">
												{test.error}
											</pre>
										)}
									</div>
								</div>
							</div>
						))}
					</section>
				))}
			</div>
		</div>
	);
}
