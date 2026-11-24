/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What `script.setup` / `script.teardown` did, once each, at the run's boundary rather than a step
 * (#1499). Shared by the history Overview and a scenario run's live view, as `ContractCoverage` and
 * `SampledSchemaValidation` are. **Silent when the collection declared neither**: an absent
 * `lifecycle` claims something other than "declared one and it did nothing".
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ElementMessages } from "./ElementMessages";
import { ScriptRequestRow } from "./response-viewer/ScriptRequestRow";
import type { LifecycleElementOutcome, RunReport } from "@/types/domain";

const PHASE_LABELS: Record<"setup" | "teardown", string> = {
	setup: "Setup",
	teardown: "Teardown",
};

export interface ScriptLifecycleSummaryProps {
	lifecycle: RunReport["lifecycle"];
	className?: string;
}

/**
 * `skipped` is the run's Stop cancelling the script's `pm.sendRequest`: the run ended under it, so
 * neither pass nor failure (#3371).
 */
function isFailure(outcome: LifecycleElementOutcome): boolean {
	return outcome.outcome !== "ok" && outcome.outcome !== "skipped";
}

const ROW_TONES: Record<"ran" | "skipped" | "failed", { className: string; fallback: string }> = {
	ran: { className: "text-status-success-text", fallback: "Ran" },
	skipped: { className: "text-muted-foreground", fallback: "Skipped" },
	failed: { className: "text-destructive-text", fallback: "Failed" },
};

function LifecycleRow({
	phase,
	outcome,
}: {
	phase: "setup" | "teardown";
	outcome: LifecycleElementOutcome;
}) {
	const ran = outcome.outcome === "ok";
	const tone = ROW_TONES[ran ? "ran" : isFailure(outcome) ? "failed" : "skipped"];
	// A passing script has nothing to say; the other two carry the engine's reason, and a blank one
	// reads as none (#3455).
	const reason = outcome.message?.trim();
	const label = ran || !reason ? tone.fallback : reason;
	return (
		<li className="text-sm">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-muted-foreground">{PHASE_LABELS[phase]}</span>
				<span className={cn("font-medium", tone.className)}>{label}</span>
			</div>
			<ElementMessages element={outcome} />
			{/*
			 * Listed apart, in call order: the `console` sample folds repeats, so no line stands
			 * for a record (#3633).
			 */}
			{outcome.scriptRequests && outcome.scriptRequests.length > 0 && (
				<ul aria-label={`${PHASE_LABELS[phase]} script requests`} className="mt-1">
					{outcome.scriptRequests.map((record, index) => (
						<li key={index}>
							<ScriptRequestRow record={record} />
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

export function ScriptLifecycleSummary({ lifecycle, className }: ScriptLifecycleSummaryProps) {
	if (!lifecycle || (!lifecycle.setup?.length && !lifecycle.teardown?.length)) return null;

	const anyFailed = lifecycle.setup?.some(isFailure) || lifecycle.teardown?.some(isFailure);

	return (
		<Card className={className}>
			<CardHeader className="space-y-0">
				<CardTitle>Setup / teardown</CardTitle>
			</CardHeader>
			<CardContent>
				<ul className="space-y-1.5">
					{/*
					 * A collection may declare several setup or teardown elements; each gets a row,
					 * not one folded verdict.
					 */}
					{lifecycle.setup?.map((outcome, index) => (
						<LifecycleRow key={`setup-${index}`} phase="setup" outcome={outcome} />
					))}
					{lifecycle.teardown?.map((outcome, index) => (
						<LifecycleRow
							key={`teardown-${index}`}
							phase="teardown"
							outcome={outcome}
						/>
					))}
				</ul>
				{anyFailed && (
					<p className="mt-3 text-xs text-muted-foreground">
						A failed teardown does not change the run's status; a failed setup already
						kept it from sending anything.
					</p>
				)}
			</CardContent>
		</Card>
	);
}
