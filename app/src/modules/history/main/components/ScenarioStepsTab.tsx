/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ScenarioStepsTab - the per-step breakdown of a scenario load run (issue #357).
 *
 * A scenario load run stores no per-step `results` rows, and deliberately so:
 * one row per step per iteration per virtual user is the shape a load run
 * exists not to keep. The engine keeps one latency histogram per plan step
 * instead, and this table *is* how the run says what each step did - there is
 * no `results[]` to fall back to, which is why a design-mode collection run
 * renders `ScenarioRunView` and this one renders here.
 *
 * `executed` per step is the number worth reading first: a step that got no
 * response ends its iteration, so a sequence whose counts fall away after step 3
 * is telling you step 3 got nothing back. `errors` is wider than that - it also
 * counts 4xx/5xx responses, which do not end the iteration - so its tooltip
 * splits the two.
 *
 * The Tests column is the deferred per-step validation (issue #450): each
 * step's own post-request script replayed after the run against that step's
 * sampled responses. A step that asserted nothing shows a dash rather than a
 * zero - "no assertions" and "no failures" are different answers, and the
 * engine keeps them apart by omitting the object.
 */

import { Fragment } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { ElementTally, TruncatedText } from "@/components/shared";
import { formatLatency, formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RunScenarioStepStat } from "@/types";

export interface ScenarioStepsTabProps {
	steps: RunScenarioStepStat[];
	/** Virtual users the run held, for the line above the table. */
	virtualUsers?: number;
	iterationsCompleted?: number;
	iterationsAbandoned?: number;
}

/**
 * The Errors tally, with its split on hover. `httpErrors` and `noResponse` are
 * absent from a report stored before the engine reported them, and a tally with
 * no split is shown as the bare count rather than as a split of zeros.
 */
function ErrorsCell({ step }: { step: RunScenarioStepStat }) {
	const count = <span>{formatNumber(step.errors)}</span>;
	const { httpErrors, noResponse } = step;
	if (step.errors === 0 || httpErrors === undefined || noResponse === undefined) return count;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{count}</TooltipTrigger>
			<TooltipContent>
				{formatNumber(httpErrors)} {pluralize(httpErrors, "HTTP error")},{" "}
				{formatNumber(noResponse)} no response
			</TooltipContent>
		</Tooltip>
	);
}

export default function ScenarioStepsTab({
	steps,
	virtualUsers,
	iterationsCompleted,
	iterationsAbandoned,
}: ScenarioStepsTabProps) {
	if (steps.length === 0) return null;

	// The count the whole table is read against: with every iteration reaching
	// every step, each row's `executed` equals it. A row below it is a step the
	// sequence stopped short of.
	const expectedPerStep = steps[0]?.executed ?? 0;

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm p-3 border rounded-md bg-background/50">
				{virtualUsers !== undefined && (
					<div className="flex items-center gap-2">
						<span className="text-muted-foreground">Virtual users:</span>
						<span className="text-foreground font-mono">
							{formatNumber(virtualUsers)}
						</span>
					</div>
				)}
				{iterationsCompleted !== undefined && (
					<div className="flex items-center gap-2">
						<span className="text-muted-foreground">Iterations completed:</span>
						<span className="text-foreground font-mono">
							{formatNumber(iterationsCompleted)}
						</span>
					</div>
				)}
				{/* Only when non-zero: a run that lost nothing should not be made to
				    display a zero next to a word like "abandoned". */}
				{!!iterationsAbandoned && (
					<div className="flex items-center gap-2">
						<AlertTriangle className="size-icon shrink-0 text-status-warning-text" />
						<span className="text-muted-foreground">Iterations abandoned:</span>
						<span className="text-foreground font-mono">
							{formatNumber(iterationsAbandoned)}
						</span>
					</div>
				)}
			</div>

			{/* Wide content scrolls inside its own box rather than pushing the
			    page sideways. */}
			<div className="overflow-x-auto border rounded-md">
				<table className="w-full text-sm">
					<caption className="sr-only">
						Per-step latency and counts for this scenario load run
					</caption>
					<thead>
						<tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
							<th scope="col" className="px-3 py-2 font-medium">
								Step
							</th>
							<th scope="col" className="px-3 py-2 font-medium text-right">
								Executed
							</th>
							<th scope="col" className="px-3 py-2 font-medium text-right">
								Errors
							</th>
							<th scope="col" className="px-3 py-2 font-medium text-right">
								Tests
							</th>
							<th scope="col" className="px-3 py-2 font-medium text-right">
								p50
							</th>
							<th scope="col" className="px-3 py-2 font-medium text-right">
								p95
							</th>
							<th scope="col" className="px-3 py-2 font-medium text-right">
								p99
							</th>
							<th scope="col" className="px-3 py-2 font-medium text-right">
								Max
							</th>
						</tr>
					</thead>
					<tbody>
						{steps.map((step) => (
							<Fragment key={step.index}>
								<tr className="border-b last:border-b-0">
									<th scope="row" className="px-3 py-2 font-normal text-left">
										<div className="flex items-center gap-2 min-w-0">
											<span className="text-xs text-muted-foreground font-mono shrink-0">
												{step.index + 1}
											</span>
											<Badge
												variant="outline"
												className="font-mono text-micro shrink-0"
											>
												{step.method}
											</Badge>
											<TruncatedText className="text-foreground min-w-0">
												{step.name || step.requestId}
											</TruncatedText>
										</div>
									</th>
									<td className="px-3 py-2 text-right font-mono">
										{formatNumber(step.executed)}
										{/* A step the sequence reached fewer times than the
										    first one did is the visible shape of an earlier
										    step erroring out. */}
										{step.executed < expectedPerStep && (
											<span
												className="ml-1 text-xs text-muted-foreground"
												title={`${formatNumber(
													expectedPerStep - step.executed
												)} iterations ended before reaching this step`}
											>
												({formatNumber(expectedPerStep - step.executed)}{" "}
												short)
											</span>
										)}
									</td>
									<td
										className={
											step.errors > 0
												? "px-3 py-2 text-right font-mono text-status-error-text"
												: "px-3 py-2 text-right font-mono text-muted-foreground"
										}
									>
										<ErrorsCell step={step} />
									</td>
									<td className="px-3 py-2 text-right font-mono">
										{step.tests ? (
											<span
												title={`${formatNumber(
													step.tests.passed
												)} passed, ${formatNumber(
													step.tests.failed
												)} failed across ${formatNumber(
													step.tests.sampled
												)} sampled ${pluralize(step.tests.sampled, "response")}`}
											>
												{formatNumber(step.tests.passed)}
												{step.tests.failed > 0 && (
													<span className="text-status-error-text">
														{" / "}
														{formatNumber(step.tests.failed)}
													</span>
												)}
											</span>
										) : (
											// A step that asserted nothing. A zero here would read as
											// "nothing failed", which is a claim the run never made.
											<span
												className="text-muted-foreground"
												title="No assertions"
											>
												-
											</span>
										)}
									</td>
									<td className="px-3 py-2 text-right font-mono">
										{formatLatency(step.latency.p50)}
									</td>
									<td className="px-3 py-2 text-right font-mono">
										{formatLatency(step.latency.p95)}
									</td>
									<td className="px-3 py-2 text-right font-mono">
										{formatLatency(step.latency.p99)}
									</td>
									<td className="px-3 py-2 text-right font-mono">
										{formatLatency(step.latency.max)}
									</td>
								</tr>
								{/* One row per non-script element this step compiled and
								    ran - extractors, assertions, timers - tallied across
								    every virtual user and iteration the way the Tests
								    column already is for scripts (issue #1516). */}
								{step.elements?.map((element) => (
									<tr
										key={`${step.index}-${element.id}`}
										className="border-b last:border-b-0 bg-muted/20"
									>
										<td colSpan={8} className="px-3 py-1.5 pl-9">
											<ElementTally element={element} className="text-xs" />
										</td>
									</tr>
								))}
							</Fragment>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
