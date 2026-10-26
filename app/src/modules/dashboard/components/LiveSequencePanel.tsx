/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The sequence a scenario load run is running, between the hero row and the
 * charts (issue #2823): the SEQUENCE chip History's request bar wears, the
 * iterations so far, and each step's executed and error counts - the live
 * counterpart of History's Steps tab, drawn from the same cells.
 *
 * Its data is the gate frame's `scenario` block, which carries no latency: a
 * step's percentiles exist only in the finished report. `progress` is the block
 * itself (`utils/liveScenario.ts`), so this memo'd panel re-renders once a
 * second, when a new gate lands, and not on the frames between.
 */

import { memo } from "react";
import { Card, Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui";
import {
	ErrorsCell,
	ExecutedCell,
	ScenarioFacts,
	SequenceBadge,
	StepLabelCell,
} from "@/components/shared";
import { formatNumber } from "@/lib/format-number";
import type { LiveScenarioProgress } from "@/types";
import { pluralize } from "../utils/format";

function LiveSequencePanel({ progress }: { progress: LiveScenarioProgress }) {
	const { steps } = progress;
	return (
		<Card pad="sm" className="min-w-0 flex flex-col gap-3">
			<div className="flex items-center gap-3">
				<SequenceBadge />
				<span className="text-xs text-foreground">
					{formatNumber(steps.length)} {pluralize(steps.length, "step")} per iteration
				</span>
			</div>
			<ScenarioFacts
				iterationsStarted={progress.iterations}
				iterationsCompleted={progress.iterationsCompleted}
				iterationsAbandoned={progress.iterationsAbandoned}
			/>
			<div className="overflow-x-auto">
				<Table>
					<caption className="sr-only">Per-step counts so far for this load test</caption>
					<TableHeader>
						<TableRow>
							<TableHead scope="col">Step</TableHead>
							<TableHead scope="col" className="text-right">
								Executed
							</TableHead>
							<TableHead scope="col" className="text-right">
								Errors
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{steps.map((step) => (
							<TableRow key={step.index}>
								<StepLabelCell index={step.index} name={step.name} />
								<ExecutedCell executed={step.executed} />
								<ErrorsCell errors={step.errors} />
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</Card>
	);
}

export default memo(LiveSequencePanel);
