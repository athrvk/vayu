/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ReactNode } from "react";
import { Callout, SEVERITY_ORDER, type Severity } from "@/components/shared";
import { Button } from "@/components/ui";
import type { DraftErrors } from "./validation";

export interface Notice {
	key: string;
	severity: Severity;
	node: ReactNode;
}

/** The validation messages, plus the two facts that raise an advisory. */
export interface NoticeInputs extends DraftErrors {
	hasPreRequestScript: boolean;
	scriptsOverride: string;
	/** What differs between the design and load default headers, or null. */
	defaultHeaderDifference: string | null;
	/**
	 * Budgets the dialog opened with that the user did not type this time
	 * (issue #2194): the sentence naming them, and what clears exactly those.
	 */
	carriedBudgets?: { summary: string; onClear: () => void } | null;
}

/**
 * Up to five notices can be on screen at once. Severity is a prop and the
 * blocking ones sort above the advisory ones, because with a stack that is the
 * only thing saying which one is stopping you.
 */
export function buildNotices({
	rampDurationError,
	startFloorError,
	startConcurrencyError,
	capacityRangeError,
	budgetsError,
	monitoringError,
	hasPreRequestScript,
	scriptsOverride,
	defaultHeaderDifference,
	carriedBudgets,
}: NoticeInputs): Notice[] {
	const list: Notice[] = [];

	if (rampDurationError) {
		list.push({
			key: "ramp",
			severity: "blocking",
			node: (
				<Callout severity="blocking" title="Ramp is longer than the run">
					{rampDurationError}
				</Callout>
			),
		});
	}

	if (budgetsError) {
		list.push({
			key: "budgets",
			severity: "blocking",
			node: (
				<Callout severity="blocking" title="A budget is out of range">
					{budgetsError}
				</Callout>
			),
		});
	}

	if (monitoringError) {
		list.push({
			key: "monitor",
			severity: "blocking",
			node: (
				<Callout severity="blocking" title="Server monitoring is incomplete">
					{monitoringError}
				</Callout>
			),
		});
	}

	if (capacityRangeError) {
		list.push({
			key: "capacity-range",
			severity: "blocking",
			node: (
				<Callout severity="blocking" title="Start is at or above the maximum">
					{capacityRangeError}
				</Callout>
			),
		});
	}

	if (startFloorError) {
		list.push({
			key: "start-floor",
			severity: "blocking",
			node: (
				<Callout severity="blocking" title="Start is below one virtual user">
					{startFloorError}
				</Callout>
			),
		});
	}

	if (startConcurrencyError) {
		list.push({
			key: "start-concurrency",
			severity: "blocking",
			node: (
				<Callout severity="blocking" title="Ramp would run downwards">
					{startConcurrencyError}
				</Callout>
			),
		});
	}

	// Unconditional before issue #1594: the load path ran no element at all,
	// so a pre-request script never reached the wire regardless of what the
	// run asked for. Now `elements.scripts: "allInline"` makes it run per
	// submission, so the warning is only true at the other two settings.
	if (hasPreRequestScript && scriptsOverride !== "allInline") {
		list.push({
			key: "pre-script",
			severity: "warning",
			node: (
				<Callout severity="warning" title="Pre-request script won't run">
					Running JS per request would cap throughput, so the load engine skips it unless
					Scripts below is set to All inline. Your post-request script still runs once
					afterwards, against sampled responses.
				</Callout>
			),
		});
	}

	if (defaultHeaderDifference) {
		list.push({
			key: "default-headers",
			severity: "info",
			node: (
				<Callout severity="info" title="This load run's default headers differ">
					{defaultHeaderDifference}
				</Callout>
			),
		});
	}

	if (carriedBudgets) {
		list.push({
			key: "carried-budgets",
			severity: "info",
			node: (
				<Callout
					severity="info"
					action={
						<Button size="sm" variant="outline" onClick={carriedBudgets.onClear}>
							Clear carried-over budgets
						</Button>
					}
				>
					{carriedBudgets.summary}
				</Callout>
			),
		});
	}

	return list.sort(
		(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
	);
}
