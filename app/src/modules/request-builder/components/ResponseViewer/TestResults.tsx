/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * TestResults Component
 *
 * Displays test execution results with pass/fail status.
 */

import { CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TestResultsProps {
	results: Array<{ name: string; passed: boolean; error?: string }>;
}

export default function TestResults({ results }: TestResultsProps) {
	const passedCount = results.filter((t) => t.passed).length;
	const failedCount = results.length - passedCount;

	return (
		<div className="p-4 overflow-auto h-full">
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
			<div className="space-y-1.5">
				{results.map((test, i) => (
					<div
						key={i}
						className={cn(
							// `rounded-md`: these were the only square-cornered cards
							// in the response pane, and they ignored the Roundedness
							// setting entirely.
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
			</div>
		</div>
	);
}
