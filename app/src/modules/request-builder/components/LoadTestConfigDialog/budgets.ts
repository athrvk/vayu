/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The dialog's pass/fail budgets: the fields, when a draft is unusable, and the payload it builds.
 * Component-free so the rules test without rendering, and one table because the same metrics drive
 * the fields, the validation and the payload: three lists would drift, into a budget the user typed
 * and the engine never judged.
 *
 * The ranges mirror `engine/src/core/threshold_eval.cpp` as a courtesy, not the gate: the engine
 * 400s an out-of-range budget regardless, and these tell the user before the run, not after it
 * fails to start.
 *
 * Beside the table is the family no table holds: a `custom.<name>.<stat>` ceiling on a metric the
 * plan records under a name only the user knows (#1500). A free-text row, not a picker, because the
 * engine checks only the key's *shape*, never `<name>` against the run's `metric.record` elements,
 * and an unmatched name is just `evaluated: false` in the report. MCP's `thresholdsInput` decided
 * the same (`electron/mcp/tools/input-schemas.ts`, `catchall`).
 */

import type { RunThresholdBudgets, RunThresholds } from "@/types";
import { generateId } from "@/lib/id";

/**
 * The fixed budgets only: `RunThresholdBudgets` is the half of `RunThresholds` that holds them, so
 * the table cannot pick up `failRun` (its own switch) or a `custom.<name>.<stat>` key (a free-text
 * row), and a fixed budget added to the type without a field here fails to compile.
 */
export type BudgetKey = keyof RunThresholdBudgets;

export interface BudgetField {
	key: BudgetKey;
	/** DOM id, so the label is associated rather than merely adjacent. */
	id: string;
	label: string;
	unit: string;
	min: number;
	/** Whether `min` is itself a legal budget - true only for the error rate. */
	minInclusive: boolean;
	max: number;
	hint?: string;
	/**
	 * Replaces `hint` where a setting seeds the field; the collection runner seeds nothing, so not
	 * there.
	 */
	seededHint?: string;
	/**
	 * Judged on a stream section, which only a streaming run has (a streaming request's load run,
	 * or a collection run with a streaming step); on any other run the engine reports it not
	 * evaluated, so failed. Both dialogs show these only then: use {@link budgetFieldsFor}, not the
	 * table.
	 */
	streamOnly?: boolean;
}

/** A day. Past it no request completes, so no ceiling above it is a budget. */
const MAX_LATENCY_MS = 86_400_000;

export const BUDGET_FIELDS: readonly BudgetField[] = [
	{
		key: "latencyP50Ms",
		id: "lt-budget-p50",
		label: "p50 latency at most",
		unit: "ms",
		min: 0,
		minInclusive: false,
		max: MAX_LATENCY_MS,
	},
	{
		key: "latencyP95Ms",
		id: "lt-budget-p95",
		label: "p95 latency at most",
		unit: "ms",
		min: 0,
		minInclusive: false,
		max: MAX_LATENCY_MS,
	},
	{
		key: "latencyP99Ms",
		id: "lt-budget-p99",
		label: "p99 latency at most",
		unit: "ms",
		min: 0,
		minInclusive: false,
		max: MAX_LATENCY_MS,
		seededHint:
			"Starts from Settings › Dashboard › p99 threshold. Clear it to run without a latency budget.",
	},
	{
		key: "maxErrorRatePct",
		id: "lt-budget-error-rate",
		label: "Error rate at most",
		unit: "%",
		// 0 is the one meaningful floor: "no request may fail" is a budget, where a latency ceiling
		// or a throughput floor of 0 is a typo.
		min: 0,
		minInclusive: true,
		max: 100,
		hint: "Counts every response outside 2xx/3xx, and the connection failures that never got one.",
	},
	{
		key: "minThroughputRps",
		id: "lt-budget-throughput",
		label: "Throughput at least",
		unit: "req/s",
		min: 0,
		minInclusive: false,
		max: 1_000_000_000,
	},
	{
		key: "maxAssertionFailureRatePct",
		id: "lt-budget-assertion-failure-rate",
		label: "Assertion failure rate at most",
		unit: "%",
		// As the error rate: "no assertion may fail" is a budget.
		min: 0,
		minInclusive: true,
		max: 100,
		hint: "Counts every assert.* element on every response, and pm.test calls in the responses the script ran on.",
	},
	{
		key: "streamTimeToFirstEventP95Ms",
		id: "lt-budget-stream-first-event",
		label: "Time to first event p95 at most",
		unit: "ms",
		min: 0,
		minInclusive: false,
		max: MAX_LATENCY_MS,
		hint: "From sending the request to a stream's first event, so a server that answers at once and then waits still counts. Streams that never delivered an event are left out. An API that opens with a preamble event (Anthropic's message_start, an OpenAI role-only chunk) reads near zero, so this is not time to first token and a budget on it passes falsely. Budget the first match instead, with a first content marker on the request.",
		streamOnly: true,
	},
	{
		key: "streamTimeToFirstMatchP95Ms",
		id: "lt-budget-stream-first-match",
		label: "Time to first match p95 at most",
		unit: "ms",
		min: 0,
		minInclusive: false,
		max: MAX_LATENCY_MS,
		hint: "From sending the request to the first appearance of the request's first content marker, which is the first token of an API that opens with a preamble event. Needs the marker set on the request: a run where no stream matched has no figure, and the budget fails.",
		streamOnly: true,
	},
	{
		key: "streamEventsPerSecondMin",
		id: "lt-budget-stream-event-rate",
		label: "Events per second at least",
		unit: "events/s",
		min: 0,
		minInclusive: false,
		max: 1_000_000_000,
		hint: "Events delivered by all streams together, per second of the run.",
		streamOnly: true,
	},
];

/**
 * The fields a run can declare: every fixed budget, less the stream ones unless it streams. A
 * stream budget elsewhere is "not evaluated" and counts as missed, so it is neither offered nor
 * sent.
 */
export function budgetFieldsFor(streaming: boolean): readonly BudgetField[] {
	return streaming ? BUDGET_FIELDS : BUDGET_FIELDS.filter((field) => !field.streamOnly);
}

/** The note under the latency budgets of a streaming run: what their clock measures. */
export const STREAM_LATENCY_NOTE =
	"For a streaming request, a latency budget is judged on each stream's full duration, from sending the request to the stream closing.";

/** The latency field the {@link STREAM_LATENCY_NOTE} sits under: the last of the three. */
export const STREAM_LATENCY_NOTE_AFTER = "latencyP99Ms" satisfies BudgetKey;

/** What the user has typed, per budget. Blank means "not declared". */
export type BudgetDraft = Record<BudgetKey, string>;

export function emptyBudgetDraft(): BudgetDraft {
	return {
		latencyP50Ms: "",
		latencyP95Ms: "",
		latencyP99Ms: "",
		maxErrorRatePct: "",
		minThroughputRps: "",
		maxAssertionFailureRatePct: "",
		streamTimeToFirstEventP95Ms: "",
		streamTimeToFirstMatchP95Ms: "",
		streamEventsPerSecondMin: "",
	};
}

/** The card's explainer, shared so the two dialogs that show it cannot drift apart. */
export const BUDGETS_EXPLAINER =
	"The run is judged against the budgets set here. Blank fields are skipped; with every field blank the run is measured but not judged.";

/**
 * Capacity discovery climbs past the limit on purpose, and latency is judged over every level
 * (#2816).
 */
export const CAPACITY_BUDGETS_NOTE =
	"In Capacity discovery a latency budget is judged over the whole run, every level the search climbed through included, so it measures how far the search went, not the capacity it found.";

/** The p99 field's hint while the Settings seed in it is not sent. */
export const CAPACITY_SEED_HINT =
	"Starts from Settings › Dashboard › p99 threshold, but a Capacity discovery run does not send it. Type a value to set a p99 budget for this run.";

/** The same hint on a streaming request, whose latency is the stream's whole duration (issue #3772). */
export const STREAM_SEED_HINT =
	"Starts from Settings › Dashboard › p99 threshold, but a streaming request does not send it. Type a value to set a p99 budget for this run.";

/**
 * The first budget the engine would reject, phrased for the dialog. Blank is always fine: budgets
 * are opt-in, and clearing a field declines one. Anything else must be a number in range, and a bad
 * value is said, not dropped, because silently sending most of what someone typed is worse. A field
 * the run cannot declare (a stream budget with `streaming` false) is not checked: it is neither
 * shown nor sent, so a remembered value there is no one's mistake.
 */
export function budgetError(draft: BudgetDraft, streaming = false): string | null {
	for (const field of budgetFieldsFor(streaming)) {
		const raw = draft[field.key].trim();
		if (raw === "") continue;

		const value = Number(raw);
		if (!Number.isFinite(value)) {
			return `${field.label} must be a number, or blank for no budget.`;
		}
		const underMin = field.minInclusive ? value < field.min : value <= field.min;
		if (underMin || value > field.max) {
			const lower = field.minInclusive ? `${field.min}` : `more than ${field.min}`;
			return `${field.label} must be ${lower} and at most ${field.max}${field.unit}, or blank for no budget.`;
		}
	}
	return null;
}

/**
 * The stats a `custom.<name>.<stat>` budget reads, as `threshold_eval.cpp`'s
 * `custom_metric_stats()` lists them: a trend's percentiles and `max`, `value` (a counter's total
 * or a rate's percentage) and `rate` (the same field, spelled for a rate metric).
 */
export const CUSTOM_BUDGET_STATS = ["p50", "p95", "p99", "max", "value", "rate"] as const;

export type CustomBudgetStat = (typeof CUSTOM_BUDGET_STATS)[number];

/**
 * `metric.record`'s bound on a name (`metric_kinds.cpp`: `minLength` 1, `maxLength` 100), so a name
 * too long to be recorded is refused as typed. No character rule: the engine has none, and one here
 * would refuse a name a run can record.
 */
export const MAX_CUSTOM_METRIC_NAME_LENGTH = 100;

/**
 * One `custom.<name>.<stat>` row being edited. `id` is its React and remove-button identity, from
 * `generateId` like every repeatable row (`KeyValueEditor`'s `createEmptyKeyValue`), never the
 * name, which starts blank and changes under the cursor.
 */
export interface CustomBudgetDraft {
	id: string;
	name: string;
	stat: CustomBudgetStat;
	/** Raw text, parsed like the fixed budgets above. Blank means "not declared". */
	value: string;
}

export function emptyCustomBudgetRow(): CustomBudgetDraft {
	return { id: generateId(), name: "", stat: CUSTOM_BUDGET_STATS[0], value: "" };
}

/** How a row's budget reads in a message, and travels on the wire. */
export function customBudgetKey(name: string, stat: CustomBudgetStat): `custom.${string}` {
	return `custom.${name}.${stat}`;
}

/**
 * What the engine would reject about one custom row, or `undefined`. A row with neither name nor
 * value is an unused slot, as a blank fixed field is; one with only half is *not*: half a budget is
 * the "typed but never judged" failure, so it is reported, not dropped.
 */
export function customBudgetRowError(row: CustomBudgetDraft): string | undefined {
	const name = row.name.trim();
	const raw = row.value.trim();
	if (name === "" && raw === "") return undefined;

	if (name === "") {
		return "A custom metric budget needs the name the metric is recorded under, or clear its value.";
	}
	if (name.length > MAX_CUSTOM_METRIC_NAME_LENGTH) {
		return `A custom metric name is at most ${MAX_CUSTOM_METRIC_NAME_LENGTH} characters.`;
	}

	const label = customBudgetKey(name, row.stat);
	if (raw === "" || !Number.isFinite(Number(raw))) {
		return `${label} must be a number, or clear the name to drop the budget.`;
	}
	// The engine's own bound and words: every custom stat is a ceiling, so a negative one is
	// unmeetable.
	if (Number(raw) < 0) {
		return `${label} must be zero or greater - it is a ceiling on a recorded metric.`;
	}
	return undefined;
}

/**
 * The first thing wrong with the custom rows as a set, or `null`, so both dialogs gate on one call,
 * as on {@link budgetError}. The duplicate check is what no per-row check can make: two rows with
 * the same metric and stat are one payload key, so the second would silently overwrite the first.
 */
export function customBudgetsError(rows: readonly CustomBudgetDraft[]): string | null {
	const seen = new Set<string>();
	for (const row of rows) {
		const rowError = customBudgetRowError(row);
		if (rowError) return rowError;

		const name = row.name.trim();
		if (name === "" || row.value.trim() === "") continue;
		const key = customBudgetKey(name, row.stat);
		if (seen.has(key)) {
			return `${key} is declared twice - one budget per metric and stat.`;
		}
		seen.add(key);
	}
	return null;
}

/**
 * The `thresholds` payload for `POST /runs`, or `undefined` when nothing was declared, never `{}`,
 * which the engine refuses rather than start an unjudged run. Assumes {@link budgetError} and
 * {@link customBudgetsError} passed; an unparseable field is skipped, not sent as `NaN`, as is a
 * half-blank custom row. `failRun` is folded in only with a budget: the engine refuses
 * `{ failRun: true }` alone, and a custom budget counts as one. A stream budget is sent only when
 * `streaming`: elsewhere it would be not evaluated, so missed.
 */
export function buildThresholds(
	draft: BudgetDraft,
	failRun = false,
	customBudgets: readonly CustomBudgetDraft[] = [],
	streaming = false
): RunThresholds | undefined {
	const thresholds: RunThresholds = {};
	for (const field of budgetFieldsFor(streaming)) {
		const raw = draft[field.key].trim();
		if (raw === "") continue;
		const value = Number(raw);
		if (!Number.isFinite(value)) continue;
		thresholds[field.key] = value;
	}
	for (const row of customBudgets) {
		const name = row.name.trim();
		const raw = row.value.trim();
		if (name === "" || raw === "") continue;
		const value = Number(raw);
		if (!Number.isFinite(value)) continue;
		thresholds[customBudgetKey(name, row.stat)] = value;
	}
	if (Object.keys(thresholds).length === 0) return undefined;
	if (failRun) thresholds.failRun = true;
	return thresholds;
}

/** One fixed budget as it reads in a sentence: "p99 latency at most 200 ms". */
export function describeFixedBudget(field: BudgetField, raw: string): string {
	const value = raw.trim();
	return `${field.label} ${value}${field.unit === "%" ? "%" : ` ${field.unit}`}`;
}

/** One custom row as it reads in a sentence: "custom.cart.p95 at most 5". */
export function describeCustomBudget(row: CustomBudgetDraft): string {
	return `${customBudgetKey(row.name.trim(), row.stat)} at most ${row.value.trim()}`;
}

/** A custom row the payload would carry: both halves filled, as `buildThresholds` requires. */
export function isDeclaredCustomBudget(row: CustomBudgetDraft): boolean {
	return row.name.trim() !== "" && row.value.trim() !== "";
}

/**
 * What the collapsed card says, so a closed card is not silent about what will judge the run: a
 * count, and the budget itself when there is one. Counts what the payload carries: filled fixed
 * fields plus fully filled custom rows.
 */
export function summariseBudgets(
	draft: BudgetDraft,
	customBudgets: readonly CustomBudgetDraft[] = [],
	streaming = false
): string {
	const declared = [
		...budgetFieldsFor(streaming)
			.filter((field) => draft[field.key].trim() !== "")
			.map((field) => describeFixedBudget(field, draft[field.key])),
		...customBudgets.filter(isDeclaredCustomBudget).map(describeCustomBudget),
	];
	if (declared.length === 0) return "No budgets";
	if (declared.length === 1) return `1 budget active - ${declared[0]}`;
	return `${declared.length} budgets active`;
}
