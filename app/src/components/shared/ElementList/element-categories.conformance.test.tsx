/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Pins `element-categories.ts`'s known-category set to the engine fixture's
 * own categories, both directions (issue #1604's own stated test plan): every
 * category the live registry produces (after folding `control.transaction`
 * into `controller`, the one deliberate exception) has a label and a position
 * here, and the map declares nothing beyond that set.
 *
 * Mutation check: add a category to `element-categories.ts` that the fixture
 * does not produce, and this reddens. A category the fixture adds that this
 * map does not know about still renders in the picker - `categoryLabel`
 * falls back to the raw, capitalized name - but that fallback is a deliberate
 * placeholder, not a substitute for updating the map, which is what failing
 * loudly here is for.
 *
 * `engine/tests/fixtures/element-kinds.json` is not hand-maintained - see
 * `element-kinds.conformance.test.tsx`'s own doc comment. Held in
 * `ENGINE_READING_GUARDS` (`@/lib/routed-inputs.testkit`) so CI routes an
 * edit to the fixture back to this suite too.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { render, screen, fireEvent } from "@testing-library/react";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";
import { KNOWN_CATEGORIES, categoryLabel, effectiveCategory } from "./element-categories";
import { ElementList } from "./index";
import type { ElementKindSchema } from "@/types";

const [FIXTURE_PATH] = ENGINE_READING_GUARDS.elementCategoryLabels.paths.map(fromRepoRoot);

const fixtureExists = existsSync(FIXTURE_PATH);

describe.runIf(fixtureExists)("element category labels conformance (fixture present)", () => {
	const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ElementKindSchema[];

	it("scanned a non-empty fixture (guards the scan itself)", () => {
		expect(Array.isArray(fixture)).toBe(true);
		expect(fixture.length).toBeGreaterThan(0);
	});

	it("declares exactly the fixture's effective categories, both directions", () => {
		// `inherit.disable` never reaches the picker (ElementList filters it by
		// kind, not by category), so its category is not part of this contract.
		const effectiveCategories = new Set(
			fixture
				.filter((k) => k.kind !== "inherit.disable")
				.map((k) => effectiveCategory(k.category))
		);

		expect(new Set(KNOWN_CATEGORIES)).toEqual(effectiveCategories);
	});

	it("folds control.transaction's category into controller", () => {
		const transaction = fixture.find((k) => k.kind === "control.transaction");
		expect(transaction, "fixture no longer has control.transaction").toBeTruthy();
		expect(transaction!.category).toBe("transaction");
		expect(effectiveCategory(transaction!.category)).toBe("controller");
	});

	// The unit tests in `ElementList.test.tsx` cover ordering against a small,
	// hand-written fixture with only three categories present; this is the
	// same claim against the live registry's full set, so a category that
	// exists only in the real catalogue (timer, controller, metric) is
	// actually exercised end to end, not just implied by `categoryOrder`'s
	// array position.
	it("renders every known category as a heading, in family order, against the live registry", async () => {
		render(<ElementList elements={[]} onChange={() => {}} kinds={fixture} />);
		fireEvent.click(screen.getByRole("button", { name: /add element/i }));

		const expectedHeadings = KNOWN_CATEGORIES.map((category) => categoryLabel(category));
		await screen.findByText(expectedHeadings[0]);

		const namePattern = new RegExp(`^(${expectedHeadings.join("|")})$`);
		const renderedHeadings = screen.getAllByText(namePattern).map((el) => el.textContent);
		expect(renderedHeadings).toEqual(expectedHeadings);
	});
});

describe.skipIf(fixtureExists)("element category labels conformance (fixture missing)", () => {
	it("is skipped: engine/tests/fixtures/element-kinds.json was not found in this checkout", () => {
		expect(fixtureExists).toBe(false);
	});
});
