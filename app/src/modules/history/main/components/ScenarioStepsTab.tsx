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
import {
	Card,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { ElementTally, MethodBadge, TruncatedText, deferredResponsesOf } from "@/components/shared";
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

/**
 * Iterations the deadline or a Stop cut off: started, and neither completed nor
 * abandoned by an errored step. Derived, so there is no engine key to go stale;
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
				{/* The third way an iteration ends: neither finished nor lost to an
				    errored step, but still running at the deadline or a Stop. Only
				    when non-zero, like the count above. */}
				{iterationsCutShort > 0 && (
					<div className="flex items-center gap-2">
						<span className="text-muted-foreground">Iterations cut short:</span>
						<span className="text-foreground font-mono">
							{formatNumber(iterationsCutShort)}
						</span>
					</div>
				)}
			</div>

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
									<TableHead scope="row" className="font-normal text-foreground">
										<div className="flex items-center gap-2 min-w-0">
											<span className="text-xs text-muted-foreground font-mono shrink-0">
												{step.index + 1}
											</span>
											<MethodBadge method={step.method} />
											<TruncatedText className="text-foreground min-w-0">
												{step.name || step.requestId}
											</TruncatedText>
										</div>
									</TableHead>
									<TableCell className="text-right font-mono">
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
									</TableCell>
									<TableCell
										className={
											step.errors > 0
												? "text-right font-mono text-status-error-text"
												: "text-right font-mono text-muted-foreground"
										}
									>
										<ErrorsCell step={step} />
									</TableCell>
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
							</Fragment>
						))}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
