/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One rule for which error presentation a message gets (issue #1688).
 *
 * Error *text* had three presentations and nothing saying which to reach for:
 * `Callout` in twenty files, a full-pane `ErrorState`, and hand-written
 * `text-destructive-text` paragraphs in between at three different sizes. The
 * rule now (`docs/design-system.md`, Component Patterns):
 *
 * - field-level - one control refused one value: `FieldError`
 * - block-level - a condition about the form or the pane: `Callout`
 * - pane-level - the thing you came to look at did not load: `ErrorState`
 *
 * **What this guard can and cannot see.** `text-destructive-text` is the
 * foreground token for the destructive colour, and a *message* is not the only
 * thing it is right for: a failure count, a "Not saved" status, a metric that
 * is red because of what it says. Those are data in red, not a sentence about
 * what went wrong, and no scan can tell them apart. So the rule is narrowed to
 * the shape a message actually takes - the token on the opening tag of a
 * text-bearing element (`<p>`, `<span>`, `<div>`, `<small>`, `<label>`, a list
 * item, a table cell, a heading) - and every site that is deliberately not a
 * message is named below with its reason, rather than the guard being widened
 * until it passes.
 * A new red sentence has to either use a primitive or argue itself onto this
 * list.
 *
 * Source-scanned: the claim is about every file in the tree, which no render
 * reaches.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "@/lib/strip-comments.testkit";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The three primitives, plus the severity table `Callout` reads. */
const PRIMITIVES = new Set([
	"components/shared/FieldError.tsx",
	"components/shared/Callout.tsx",
	"components/shared/ErrorState.tsx",
	"components/shared/callout-severity.ts",
]);

/**
 * Deliberately not messages. Each line says what the red text is instead;
 * "it was already there" is not one of the reasons.
 */
const NOT_A_MESSAGE: Record<string, string> = {
	"modules/history/main/components/OverviewTab.tsx":
		"an error *count* and its rate, inside the error summary card - the number is the content, not a sentence about a failure",
	"modules/dashboard/components/RequestResponseView.tsx":
		"the run's total-errors figure in a definition row; the label beside it is muted and only the value is red",
	"components/shared/ContractCoverage.tsx":
		"the per-operation 'N failed' tally in a coverage row, beside its 'N off-range' sibling",
	"components/shared/TestValidationSummary.tsx":
		"the failed-assertions figure in a four-up stat row, beside Passed and Success rate",
	"components/shared/response-viewer/SampledExchange.tsx":
		"a sampled exchange's own error string, rendered as the row's trailing value and as the expanded mono block - the exchange is the subject, so this is its data",
	"components/layout/context-bar/VariablesSection.tsx":
		"the 'not defined' state chip on a variable reference row, and the reference's own name in red",
	"components/layout/Dock.tsx":
		"the Dock's save status reads 'Not saved' - a persistent state label in the footer strip, not a message about an event",
	"modules/request-builder/components/ResponseViewer/console/ScriptSection.tsx":
		"the console's script-failure block builds its own section (heading plus a mono <pre> of the engine's text); a Callout's single line of prose cannot hold a stack trace",
};

/**
 * `<p className="… text-destructive-text …">`, `<div …>` and the other text
 * elements, across newlines. `<div>` is in the set since #1683's closing audit:
 * five hand-rolled messages (a settings pane that failed to load, a variable
 * table that failed to load, the editor's load failure, two token-state
 * sentences in the variable popover, a slow-request warning) sat on a `<div>`
 * and the `<p>`/`<span>`-only scan waved every one of them through.
 *
 * A *literal* class string only. The token also turns up inside `cn()` and
 * template ternaries that pick red or green from a boolean - a threshold
 * verdict, a schema-status chip, a delta - and that is state colour on a value,
 * never a sentence about a failure. A conditional pair is what distinguishes
 * the two, so the regex simply does not look inside one.
 */
const RED_TEXT_TAG =
	/<(p|span|div|small|label|li|td|th|h[1-6])\b[^>]*?className="[^"]*\btext-destructive-text\b[^"]*"[^>]*?>/g;

describe("error text has one presentation per level", () => {
	const files = globSync("**/*.tsx", { cwd: srcRoot }).filter((f) => !f.includes(".test."));

	it("scans a real tree", () => {
		expect(files.length).toBeGreaterThan(100);
		// And the token is genuinely in it - a scan that matched nothing would
		// satisfy every assertion below.
		const anywhere = files.filter((f) =>
			readFileSync(join(srcRoot, f), "utf8").includes("text-destructive-text")
		);
		expect(anywhere.length).toBeGreaterThan(10);
	});

	it("keeps red prose inside FieldError, Callout or ErrorState", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const normalized = file.split("\\").join("/");
			if (PRIMITIVES.has(normalized) || normalized in NOT_A_MESSAGE) continue;
			const source = stripComments(readFileSync(join(srcRoot, file), "utf8"));
			for (const m of source.matchAll(RED_TEXT_TAG)) {
				offenders.push(`${normalized}: ${m[0].replace(/\s+/g, " ")}`);
			}
		}
		expect(
			offenders,
			`use FieldError (a field refused a value), Callout (a block-level condition) or ErrorState (the pane did not load) - or name the site in NOT_A_MESSAGE with what the red text is instead:\n${offenders.join("\n")}`
		).toEqual([]);
	});

	it("keeps the exemption list honest", () => {
		// An exemption that no longer matches anything is a line nobody will
		// delete on their own, and it quietly widens the rule for whatever lands
		// in that file next.
		for (const [file, reason] of Object.entries(NOT_A_MESSAGE)) {
			const source = stripComments(readFileSync(join(srcRoot, file), "utf8"));
			expect(
				[...source.matchAll(RED_TEXT_TAG)].length,
				`${file} no longer needs its exemption`
			).toBeGreaterThan(0);
			expect(reason.length, `${file} needs a real reason`).toBeGreaterThan(40);
		}
	});
});
