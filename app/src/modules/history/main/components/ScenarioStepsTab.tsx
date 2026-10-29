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
	ExtractorMisses,
	ScenarioFacts,
	StepLabelCell,
	deferredResponsesOf,
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
	/** Iterations started; with the two below it gives the ones the end of the run cut off. */
	iterations?: number;
	iterationsCompleted?: number;
	iterationsAbandoned?: number;
	/** The sampled-replay card a deferred element row points at (`testValidationTitleOf`). */
	replayCard?: string;
}

/**
 * The Tests tally. With the step's replay population known (`deferred` on its
 * script elements, #2824) the cell leads with the scope, "23 of 2,270", and
 * keeps the assertion split in the title; the failed count stays in the cell,
 * since a failure should not need a hover. A report stored before the engine
 * counted `deferred` has no population, so it keeps the passed / failed form.
 */
function TestsCell({ step }: { step: RunScenarioStepStat }) {
	const { tests } = step;
	if (!tests) {
		// A step that asserted nothing. A zero here would read as
		// "nothing failed", which is a claim the run never made.
		return (
			<span className="text-muted-foreground" title="No assertions">
				-
			</span>
		);
	}
	const population = deferredResponsesOf(step);
	const split = `${formatNumber(tests.passed)} passed, ${formatNumber(
		tests.failed
	)} failed across ${formatNumber(tests.sampled)} sampled ${pluralize(tests.sampled, "response")}`;
	if (population === 0) {
		return (
			<span title={split}>
				{formatNumber(tests.passed)}
				{tests.failed > 0 && (
					<span className="text-status-error-text">
						{" / "}
						{formatNumber(tests.failed)}
					</span>
				)}
			</span>
		);
	}
	return (
		<span title={`${split}, of ${formatNumber(population)} that carried a test script`}>
			{formatNumber(tests.sampled)} of {formatNumber(population)}
			{tests.failed > 0 && (
				<span className="text-status-error-text">
					{" / "}
					{formatNumber(tests.failed)} failed
				</span>
			)}
		</span>
	);
}

/**
 * Iterations the deadline or a Stop cut off: started, and neither completed nor
 * abandoned by a step that got no response or set a jump the run could not honour. Derived, so there is no engine key to go stale;
 * clamped, so a report whose counts disagree reads as none rather than negative.
 */
function iterationsCutShortOf(
	iterations: number | undefined,
	completed: number | undefined,
	abandoned: number | undefined
): number {
	if (iterations === undefined || completed === undefined) return 0;
	return Math.max(0, iterations - completed - (abandoned ?? 0));
}

export default function ScenarioStepsTab({
	steps,
	virtualUsers,
	iterations,
	iterationsCompleted,
	iterationsAbandoned,
	replayCard,
}: ScenarioStepsTabProps) {
	if (steps.length === 0) return null;

	// The count the whole table is read against: with every iteration reaching
	// every step, each row's `executed` equals it. A row below it is a step the
	// sequence stopped short of.
	const expectedPerStep = steps[0]?.executed ?? 0;
	const iterationsCutShort = iterationsCutShortOf(
		iterations,
		iterationsCompleted,
		iterationsAbandoned
	);

	return (
		<div className="space-y-4">
			<ScenarioFacts
				virtualUsers={virtualUsers}
				iterationsCompleted={iterationsCompleted}
				iterationsAbandoned={iterationsAbandoned}
				iterationsCutShort={iterationsCutShort}
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
										<TestsCell step={step} />
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
								{/* The step's extractor misses (issue #3053), after its element
								    rows: each is one of an extractor row's `missing`, summed here
								    because each also left a later step sending that name
								    unresolved. */}
								{!!step.extractorMisses && (
									<TableRow className="bg-muted/20">
										<TableCell colSpan={8} className="py-1.5 pl-9">
											<ExtractorMisses count={step.extractorMisses} />
										</TableCell>
									</TableRow>
								)}
							</Fragment>
						))}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
