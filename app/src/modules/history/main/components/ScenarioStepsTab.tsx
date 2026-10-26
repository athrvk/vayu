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
import {
	Card,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui";
import {
	ElementTally,
	ErrorsCell,
	ExecutedCell,
	ScenarioFacts,
	StepLabelCell,
} from "@/components/shared";
import { formatLatency, formatNumber } from "@/lib/format-number";
import { pluralize } from "@/modules/dashboard/utils/format";
import type { RunScenarioStepStat } from "@/types";

/** The columns after Step, each right-aligned over its figures. */
const NUMERIC_COLUMNS = ["Executed", "Errors", "Tests", "p50", "p95", "p99", "Max"];

export interface ScenarioStepsTabProps {
	steps: RunScenarioStepStat[];
	/** Virtual users the run held, for the line above the table. */
	virtualUsers?: number;
	iterationsCompleted?: number;
	iterationsAbandoned?: number;
	/** The sampled-replay card a deferred element row points at (`testValidationTitleOf`). */
	replayCard?: string;
}

export default function ScenarioStepsTab({
	steps,
	virtualUsers,
	iterationsCompleted,
	iterationsAbandoned,
	replayCard,
}: ScenarioStepsTabProps) {
	if (steps.length === 0) return null;

	// The count the whole table is read against: with every iteration reaching
	// every step, each row's `executed` equals it. A row below it is a step the
	// sequence stopped short of.
	const expectedPerStep = steps[0]?.executed ?? 0;

	return (
		<div className="space-y-4">
			<ScenarioFacts
				virtualUsers={virtualUsers}
				iterationsCompleted={iterationsCompleted}
				iterationsAbandoned={iterationsAbandoned}
			/>

			{/* Wide content scrolls inside its own box rather than pushing the
			    page sideways. A `Card`, because the table's `border-rule` rows
			    read the surface the card declares. */}
			<Card className="overflow-x-auto">
				<Table>
					<caption className="sr-only">
						Per-step latency and counts for this load test
					</caption>
					<TableHeader>
						<TableRow>
							<TableHead scope="col">Step</TableHead>
							{NUMERIC_COLUMNS.map((head) => (
								<TableHead key={head} scope="col" className="text-right">
									{head}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{steps.map((step) => (
							<Fragment key={step.index}>
								<TableRow>
									<StepLabelCell
										index={step.index}
										method={step.method}
										name={step.name || step.requestId}
									/>
									<ExecutedCell
										executed={step.executed}
										expectedPerStep={expectedPerStep}
									/>
									<ErrorsCell
										errors={step.errors}
										httpErrors={step.httpErrors}
										noResponse={step.noResponse}
									/>
									<TableCell className="text-right font-mono">
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
									</TableCell>
									<TableCell className="text-right font-mono">
										{formatLatency(step.latency.p50)}
									</TableCell>
									<TableCell className="text-right font-mono">
										{formatLatency(step.latency.p95)}
									</TableCell>
									<TableCell className="text-right font-mono">
										{formatLatency(step.latency.p99)}
									</TableCell>
									<TableCell className="text-right font-mono">
										{formatLatency(step.latency.max)}
									</TableCell>
								</TableRow>
								{/* One row per non-script element this step compiled and
								    ran - extractors, assertions, timers - tallied across
								    every virtual user and iteration the way the Tests
								    column already is for scripts (issue #1516). */}
								{step.elements?.map((element) => (
									<TableRow
										key={`${step.index}-${element.id}`}
										className="bg-muted/20"
									>
										<TableCell colSpan={8} className="py-1.5 pl-9">
											<ElementTally
												element={element}
												replayCard={replayCard}
												className="text-xs"
											/>
										</TableCell>
									</TableRow>
								))}
							</Fragment>
						))}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
