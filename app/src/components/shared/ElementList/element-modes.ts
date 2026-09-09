/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The five kinds whose config schema declares **mutually exclusive strategies
 * as independent optional siblings**, and the one place the app records which
 * sibling belongs to which strategy.
 *
 * The engine picks exactly one of them per element, by an if/else-if chain or
 * a fixed-priority loop over the keys it finds present - it never combines
 * two. JSON Schema does not say so: `assert.status` declares `in` and `range`
 * as two optional properties, so the schema-driven {@link GenericElementForm}
 * renders both at once, with nothing marking which one the engine would
 * actually run. `metric.record`'s schema even says out loud why it is not a
 * `oneOf` (valijson reports "matched N schemas" without naming one), so the
 * whole fix belongs on this side of the wire.
 *
 * **`detectionOrder` is the engine's own priority, transcribed.** It is the
 * load-bearing half of this table: if it disagreed with the C++, the card
 * would announce one strategy while the engine ran another. Each entry names
 * the function it was read from - re-check that function when the kind
 * changes, not this comment.
 *
 * **`modes` is display order**, and is deliberately allowed to differ from
 * `detectionOrder`: `timer.think` resolves gaussian first but reads
 * fixed-first, simplest strategy to most elaborate. It cannot be taken from
 * the catalogue - the engine serialises a schema through nlohmann, which sorts
 * object keys alphabetically, so the registration order the C++ is written in
 * does not survive the wire. `element-kinds.conformance.test.tsx` holds the
 * two orders to being permutations of each other, and holds every id here to a
 * property the live catalogue actually declares.
 *
 * A mode's `label` is app-side copy, not a schema `title`: a strategy is a
 * grouping the schema does not name (`minMs` + `maxMs` are one mode with two
 * titles, and `ms`'s own title, "Wait", says nothing about it being the fixed
 * one). Every *field* label, hint and unit still comes from the schema, read
 * by `GenericElementForm` exactly as it always has.
 */

/** One strategy: the keys it owns at its level, and how its fields render. */
export interface ElementMode {
	/**
	 * The config key whose *presence* selects this mode - the same key the
	 * engine's `contains` test reads.
	 */
	id: string;
	/** The picker's segment/option text. */
	label: string;
	/**
	 * Further keys this mode owns at the same level, cleared with `id` when
	 * another mode is chosen. Only `timer.think`'s uniform range has one.
	 */
	also?: string[];
	/**
	 * - `fields`: render this mode's own properties as rows.
	 * - `nested`: `id` is an `object` property; render its children directly,
	 *   without the generic form's fieldset - the picker already names it.
	 * - `marker`: the engine reads the key's *presence*, never its value, so
	 *   there is nothing to render and a toggle would offer an "off" that
	 *   turns nothing off. Choosing the mode writes `true`.
	 */
	render: "fields" | "nested" | "marker";
}

export interface ElementModeSpec {
	/**
	 * The sub-object the modes live in, when they are not top-level keys.
	 * `metric.record`'s six sources sit under `source`.
	 */
	path?: string;
	/** Top-level properties rendered above the picker (the mode's subject). */
	leadNames?: string[];
	/** Top-level properties rendered below the active mode's own fields. */
	trailNames?: string[];
	/** Names the choice the picker makes. */
	pickerLabel: string;
	/**
	 * The mode a blank config starts on. Never a `marker` mode: a marker only
	 * becomes real when the picker is *used*, so defaulting to one would leave
	 * a fresh element with a strategy on screen and none in `config`.
	 */
	defaultMode: string;
	/** The engine's resolution priority, first match wins. */
	detectionOrder: string[];
	/** Display order: how the picker reads, simplest strategy first. */
	modes: ElementMode[];
}

export const ELEMENT_MODES: Record<string, ElementModeSpec> = {
	// `AssertStatusElement::apply` (engine/src/core/elements/assert_kinds.cpp):
	// `in` (as an array) first, then `range`, then the "needs an 'in' list or
	// a 'range'" error.
	"assert.status": {
		pickerLabel: "Match by",
		defaultMode: "in",
		detectionOrder: ["in", "range"],
		modes: [
			{ id: "in", label: "Set of codes", render: "fields" },
			{ id: "range", label: "Range", render: "nested" },
		],
	},

	// `TimerThinkElement::resolve_own_wait_ms` (timer_think.cpp): `gaussian`
	// first, then `minMs` **or** `maxMs` (either one alone selects the uniform
	// range, the other defaulting), and `ms` only as the fallback - which is
	// why `ms` is the default a blank element starts on but the last thing
	// detection considers.
	"timer.think": {
		pickerLabel: "Wait type",
		defaultMode: "ms",
		detectionOrder: ["gaussian", "minMs", "ms"],
		modes: [
			{ id: "ms", label: "Fixed", render: "fields" },
			{ id: "minMs", label: "Random range", also: ["maxMs"], render: "fields" },
			{ id: "gaussian", label: "Gaussian", render: "nested" },
		],
	},

	// `AssertJsonPathElement::apply` (assert_kinds.cpp): `exists`, then
	// `expected`, then `regex`. `path` is the subject of all three and
	// `negate` flips any of their verdicts, so neither is a mode.
	"assert.jsonpath": {
		leadNames: ["path"],
		trailNames: ["negate"],
		pickerLabel: "Check",
		defaultMode: "expected",
		detectionOrder: ["exists", "expected", "regex"],
		modes: [
			{ id: "expected", label: "Equals", render: "fields" },
			{ id: "regex", label: "Matches regex", render: "fields" },
			{ id: "exists", label: "Exists", render: "marker" },
		],
	},

	// `ControlThroughputElement::apply` and `::apply_shared`
	// (controller_kinds.cpp) are both `if (everyN) ... else if (percent)`.
	// `perUser` picks the counter either share, so it is not a mode - and it
	// carries `x-vayu-group: "advanced"`, which the trailing generic form
	// still folds under its own disclosure.
	"control.throughput": {
		trailNames: ["perUser"],
		pickerLabel: "Limit by",
		defaultMode: "percent",
		detectionOrder: ["everyN", "percent"],
		modes: [
			{ id: "percent", label: "Percent", render: "fields" },
			{ id: "everyN", label: "Every Nth", render: "fields" },
		],
	},

	// `source_kind` (metric_kinds.cpp) loops the six keys in exactly this
	// order and returns the first one present. `name` and `type` are the
	// metric itself, not the source, so they lead.
	"metric.record": {
		path: "source",
		leadNames: ["name", "type"],
		pickerLabel: "Source",
		defaultMode: "jsonpath",
		detectionOrder: ["jsonpath", "header", "latency", "status", "size", "condition"],
		modes: [
			{ id: "jsonpath", label: "JSONPath", render: "fields" },
			{ id: "header", label: "Header", render: "fields" },
			{ id: "latency", label: "Latency", render: "marker" },
			{ id: "status", label: "Status code", render: "marker" },
			{ id: "size", label: "Body size", render: "marker" },
			{ id: "condition", label: "Condition", render: "nested" },
		],
	},
};

/** Every key one mode owns at its level: its `id` plus any `also`. */
export function modeKeys(mode: ElementMode): string[] {
	return [mode.id, ...(mode.also ?? [])];
}

/**
 * The mode the engine would resolve for this config, or `null` when none of
 * the strategies has a key yet (a fresh element, or one whose mode was just
 * switched). Walks `detectionOrder`, so a config that somehow carries two
 * strategies at once reports the one that actually runs.
 */
export function detectMode(spec: ElementModeSpec, config: Record<string, unknown>): string | null {
	for (const id of spec.detectionOrder) {
		const mode = spec.modes.find((m) => m.id === id);
		if (!mode) continue;
		const present = modeKeys(mode).some(
			(key) => Object.prototype.hasOwnProperty.call(config, key) && config[key] !== undefined
		);
		if (present) return id;
	}
	return null;
}

/**
 * This level's config with every *other* mode's keys removed - what a mode
 * switch writes.
 *
 * Clearing is not tidiness. The engine resolves by key presence, so a `range`
 * left behind by a switch to `in` is data nobody can see or edit that the
 * engine may still prefer over the strategy on screen; and every one of these
 * five schemas declares `additionalProperties: false`, so a key the app leaves
 * in a place the schema does not allow fails the save outright.
 *
 * The chosen mode's own keys are kept, not reset: switching *to* `range` on a
 * config that carried a hidden `range` makes that data visible and editable in
 * the same move, rather than silently dropping it. A marker mode is written
 * `true`, because presence is the whole value.
 */
export function switchMode(
	spec: ElementModeSpec,
	config: Record<string, unknown>,
	nextId: string
): Record<string, unknown> {
	const next = { ...config };
	for (const mode of spec.modes) {
		if (mode.id === nextId) continue;
		for (const key of modeKeys(mode)) delete next[key];
	}
	if (spec.modes.find((m) => m.id === nextId)?.render === "marker") next[nextId] = true;
	return next;
}
