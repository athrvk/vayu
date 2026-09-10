/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Add-element picker's group labels and order (issue #1604).
 *
 * `control.transaction` registers its own engine-side category, `"transaction"`,
 * distinct from its five `control.*` siblings' `"controller"` -
 * `TransactionHistograms`' plan scan and the `includeTimers` fold
 * (`engine/src/core/transaction_histograms.cpp`, `engine/src/core/elements/
 * pipeline.cpp`) both key off that string instead of a `kind ==` comparison,
 * per the engine's own "never compare kind == outside core/elements" rule
 * (`control_transaction.cpp`'s doc comment). Grouping it under "Controller" in
 * the picker is a display concern only, so `effectiveCategory` folds it here
 * rather than the engine's registration changing what the string means.
 *
 * A category this module does not know still renders - last, under its own
 * raw name, capitalized - so a kind the engine adds ships visible the day it
 * lands rather than needing an app change first (the #1512 contract). The
 * conformance test pins the *known* set to the fixture's effective categories
 * exactly, so a genuinely new category is a visible, deliberate addition
 * here rather than a silent trailing group forever.
 *
 * The element card's icon (issue #1608, per-kind since #1651) draws from the
 * same file, one level further: `kindIcon()` is what both the card and the
 * picker call, so the two can never show a different glyph for the same kind.
 * `KIND_ICONS` has no entry for `inherit.disable` - it never reaches a
 * rendered card or the picker, the same exclusion the picker's own kind
 * filter and this file's category map apply.
 */

import {
	Activity,
	Braces,
	Clock,
	FileJson,
	FileSearch,
	Flag,
	Gauge,
	GitBranch,
	Hash,
	Hourglass,
	Layers,
	LineChart,
	LogOut,
	Percent,
	Regex,
	Repeat,
	Rocket,
	Ruler,
	Scissors,
	ShieldCheck,
	Split,
	SquareTerminal,
	Tag,
	Terminal,
	Timer as TimerIcon,
	Type,
	type LucideIcon,
} from "lucide-react";
import type { ElementKindSchema } from "@/types";

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
	extract: "Extract",
	assert: "Assert",
	timer: "Timer",
	controller: "Controller",
	script: "Script",
	metric: "Metric",
};

const CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
	extract: FileSearch,
	assert: ShieldCheck,
	timer: TimerIcon,
	controller: GitBranch,
	script: Terminal,
	metric: Gauge,
};

/** Display order, ascending. A category not listed sorts after all of these. */
const CATEGORY_ORDER: readonly string[] = Object.keys(CATEGORY_LABELS);

/** Every category the picker's map has a label and a position for. */
export const KNOWN_CATEGORIES: readonly string[] = CATEGORY_ORDER;

/** The category a kind groups under for display, folding `transaction` into `controller`. */
export function effectiveCategory(category: string): string {
	return category === "transaction" ? "controller" : category;
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/** The group heading for an already-`effectiveCategory`'d category. */
export function categoryLabel(category: string): string {
	return CATEGORY_LABELS[category] ?? capitalize(category);
}

/** Sort key for an already-`effectiveCategory`'d category; unknown categories sort last. */
export function categoryOrder(category: string): number {
	const index = CATEGORY_ORDER.indexOf(category);
	return index === -1 ? CATEGORY_ORDER.length : index;
}

/** The family icon for an already-`effectiveCategory`'d category; unknown, none. */
export function categoryIcon(category: string): LucideIcon | undefined {
	return CATEGORY_ICONS[category];
}

/**
 * One glyph per kind, distinct within a category (and across the two kinds
 * named "Throughput" - `timer.throughput` and `control.throughput` mean a
 * target rate and a percentage share respectively, so `Gauge` and `Percent`
 * are the only thing that tells them apart in the picker). A kind the engine
 * adds tomorrow has no entry here and falls through to `kindIcon()`'s
 * category fallback, never a blank row - the same #1512 contract
 * `categoryLabel`'s fallback keeps for an unknown category.
 */
const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
	"script.pre": Terminal,
	"script.post": SquareTerminal,
	"script.setup": Rocket,
	"script.teardown": LogOut,
	"extract.json": FileJson,
	"extract.regex": Regex,
	"extract.header": Tag,
	"extract.boundary": Scissors,
	"assert.status": Hash,
	"assert.jsonpath": Braces,
	"assert.contains": Type,
	"assert.duration": Clock,
	"assert.size": Ruler,
	"timer.think": Hourglass,
	"timer.pacing": Activity,
	"timer.throughput": Gauge,
	"control.if": GitBranch,
	"control.once": Flag,
	"control.switch": Split,
	"control.throughput": Percent,
	"control.loop": Repeat,
	"control.transaction": Layers,
	"metric.record": LineChart,
};

/**
 * The icon for one kind: its own glyph if `KIND_ICONS` has one, else its
 * family's. The one function both `ElementRow` and the Add-element picker
 * call, so they cannot drift into naming the same kind two different icons.
 */
export function kindIcon(
	kind: Pick<ElementKindSchema, "kind" | "category"> | undefined
): LucideIcon | undefined {
	if (!kind) return undefined;
	return KIND_ICONS[kind.kind] ?? categoryIcon(effectiveCategory(kind.category));
}
