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
 */

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
	extract: "Extract",
	assert: "Assert",
	timer: "Timer",
	controller: "Controller",
	script: "Script",
	metric: "Metric",
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
