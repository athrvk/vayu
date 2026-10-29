/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type { ResolvedElement } from "@/types";
import {
	validateCapacityRange,
	validateRampDuration,
	validateStartConcurrency,
	validateStartConcurrencyFloor,
} from "../../utils/loadTestValidation";
import {
	budgetError,
	customBudgetsError,
	type BudgetDraft,
	type CustomBudgetDraft,
} from "./budgets";
import { monitorError, type MonitorDraft } from "./monitor";
import { scenarioOnlyError } from "./scenario-only";
import type { LoadTestProfile } from "./useSavedLoadTestConfig";

/** Each rule's message, or null when the draft passes it. */
export interface DraftErrors {
	rampDurationError: string | null;
	startFloorError: string | null;
	startConcurrencyError: string | null;
	capacityRangeError: string | null;
	budgetsError: string | null;
	monitoringError: string | null;
	/** An enabled element only a scenario can run (#3050); no field in the dialog fixes it. */
	scenarioOnlyError: string | null;
}

interface DraftToValidate {
	profile: LoadTestProfile;
	budgets: BudgetDraft;
	customBudgets: CustomBudgetDraft[];
	monitor: MonitorDraft;
	/** The engine's `monitorMaxSeries` setting. */
	maxSeries: number;
	/** The enabled scenario-only elements the run would carry (`scenarioOnlyElements`). */
	scenarioOnly: readonly ResolvedElement[];
}

export function validateLoadTestDraft({
	profile,
	budgets,
	customBudgets,
	monitor,
	maxSeries,
	scenarioOnly,
}: DraftToValidate): DraftErrors {
	const { mode, duration, concurrency, rampDuration, startConcurrency } = profile;
	return {
		rampDurationError: validateRampDuration(mode, duration, rampDuration),
		// Checked before the two range rules, which both compare the start against
		// the target: a start below the floor is wrong on its own terms, and saying
		// so is more useful than "this would ramp down".
		startFloorError: validateStartConcurrencyFloor(mode, startConcurrency),
		startConcurrencyError: validateStartConcurrency(mode, startConcurrency, concurrency),
		capacityRangeError: validateCapacityRange(mode, startConcurrency, concurrency),
		// One message slot for both budget families: a custom row is refused on the
		// same terms a fixed field is, so the notice reads the same either way.
		budgetsError: budgetError(budgets) ?? customBudgetsError(customBudgets),
		monitoringError: monitorError(monitor, maxSeries),
		scenarioOnlyError: scenarioOnlyError(scenarioOnly),
	};
}

/** The message that stops Start, in the order the rules are reported. */
export function firstBlockingError(errors: DraftErrors): string | null {
	return (
		errors.rampDurationError ??
		errors.startFloorError ??
		errors.startConcurrencyError ??
		errors.capacityRangeError ??
		errors.budgetsError ??
		errors.monitoringError ??
		errors.scenarioOnlyError
	);
}
