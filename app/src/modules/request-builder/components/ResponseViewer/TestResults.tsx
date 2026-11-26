/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/** Test results with pass/fail status, grouped by the script that made them. */

import { CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScriptSource, TestResult } from "@/types";
import { SCRIPT_SECTIONS } from "./console/script-sections";
import { EYEBROW_XS_CLASS } from "@/components/ui/eyebrow";
import { Heading } from "@/components/ui/heading";
import ScopeTag from "./ScopeTag";

export interface TestResultsProps {
	results: readonly TestResult[];
	/**
	 * Whether this owns its padding and scroll box. False when the Tests tab stacks it under a
	 * schema verdict (#628), which owns both: two scroll boxes scroll independently, two paddings
	 * indent twice.
	 */
	inset?: boolean;
}

/** In execution order, as the engine lists them. */
const SOURCES: readonly ScriptSource[] = ["pre", "test"];

/**
 * No `source` means an engine or trace older than #810, which listed only the post-request script's
 * assertions, so `"test"` is what it meant.
 */
function sourceOf(test: TestResult): ScriptSource {
	return test.source === "pre" ? "pre" : "test";
}

export default function TestResults({ results, inset = true }: TestResultsProps) {
	const passedCount = results.filter((t) => t.passed).length;
	const failedCount = results.length - passedCount;

	/*
	 * Grouped by script, a heading over each non-empty group (#810), always: assertions made
	 * *before* the request are a different claim from ones about the response, and a
	 * pre-request-only list would otherwise read as the latter. Labels come from `SCRIPT_SECTIONS`,
	 * as the Console's sections do, so the panes cannot name scripts differently. Neutral, not that
	 * table's tones: here colour is a verdict, and a green heading over a failed card would
	 * contradict it. An inherited assertion's level (#2522) is a `ScopeTag` for the same reason.
	 */
	const groups = SOURCES.map((source) => ({
		source,
		label: SCRIPT_SECTIONS[source].label,
		tests: results.filter((test) => sourceOf(test) === source),
	})).filter((group) => group.tests.length > 0);

	return (
		<div className={inset ? "p-4 overflow-auto h-full" : undefined}>
			{/*
			 * The summary is text, not a chip: the content is the results, and the tab trigger
			 * above already carries a pass/fail chip. Failures keep a colour: "2 failed" is the
			 * part worth finding unread.
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

			{/* `text-xs` and 14px icons, matching the pane and its 12px tables. */}
			<div className="space-y-3">
				{groups.map((group) => (
					<section key={group.source} className="space-y-1.5">
						{/* The level is the host's: the response pane, a run's step in History. */}
						<Heading outside="h3" className={EYEBROW_XS_CLASS}>
							{group.label}
						</Heading>
						{group.tests.map((test, i) => (
							<div
								key={i}
								className={cn(
									// `rounded-md`, so the cards follow the Roundedness setting.
									"p-2.5 rounded-md border",
									test.passed
										? "bg-status-success/10 border-status-success/20"
										: "bg-status-error/10 border-status-error/20"
								)}
							>
								<div className="flex items-start gap-2">
									{test.passed ? (
										<CheckCircle className="size-icon-sm text-status-success-text mt-px shrink-0" />
									) : (
										<XCircle className="size-icon-sm text-status-error-text mt-px shrink-0" />
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
										<ScopeTag scope={test.scope} className="block" />
										{test.error && (
											<pre className="text-label text-status-error-text mt-1 font-mono whitespace-pre-wrap break-words">
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
