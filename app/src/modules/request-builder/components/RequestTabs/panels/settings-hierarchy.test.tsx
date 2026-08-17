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
 * The Settings tab's hierarchy, and where its rows come from (issue #702).
 *
 * Two defects are pinned here. A section heading that is typed exactly like the
 * control labels under it is not a heading - the tab rendered `h3` and `Label`
 * both as `text-sm font-medium`, so six sibling lines read where three groups
 * were meant, and "Protocol" appeared twice in a row above one dropdown. And
 * the rows were hand-rolled copies of shapes `SettingControls` already defines,
 * which is how a copy stops receiving the primitive's fixes.
 *
 * Rendered rather than reasoned about for the class rule - the label classes
 * arrive from inside the primitives, so no scan of this panel's own source
 * could see them. Scanned for the second rule, because "the panel does not roll
 * its own row" is a statement about the file, and a rendered switch cannot say
 * which component wrote it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { RequestBuilderContextValue } from "../../../types";
import { createDefaultRequestState } from "../../../utils/request-state";

const PANEL_SOURCE = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "SettingsPanel.tsx"),
	"utf8"
);

vi.mock("../../../context", () => ({
	useRequestBuilderContext: () => ctx,
}));

const ctx = {
	request: { ...createDefaultRequestState(), id: "req_1" },
	setRequest: vi.fn(),
	updateField: vi.fn(),
	getAutoAccept: () => null,
	setAutoAccept: vi.fn(),
} as unknown as RequestBuilderContextValue;

const { default: SettingsPanel } = await import("./SettingsPanel");

/** The class strings as they land in the DOM, one per element. */
function classesOf(elements: Iterable<Element>): string[] {
	return [...elements].map((el) => el.className);
}

/**
 * The classes that decide what tier a line reads as: its size, its weight, its
 * casing and its tracking.
 *
 * Comparing whole class strings would pass on anything - `Label` carries
 * `leading-none` and a `peer-disabled:` pair that a heading never has, so two
 * lines set in the *same* type still differ as sets. Comparing exact values
 * instead would rot on the next token change. What has to hold is that the two
 * tiers are not set the same way.
 */
const TYPOGRAPHY =
	/^(text-(xs|sm|base|lg|xl|\[[^\]]+\])|font-(thin|light|normal|medium|semibold|bold|extrabold)|uppercase|lowercase|capitalize|tracking-.+)$/;

function typography(className: string): Set<string> {
	return new Set(className.split(/\s+/).filter((token) => TYPOGRAPHY.test(token)));
}

describe("the Settings tab's hierarchy", () => {
	it("types section headings differently from the rows under them", () => {
		const { container } = render(<SettingsPanel />);

		// Whatever the section calls itself - the `Eyebrow` it is now, or the
		// heading element it was. Querying only for the fixed shape would make
		// the defect's own markup invisible to the guard.
		const headings = classesOf(
			container.querySelectorAll('[data-slot="eyebrow"], h1, h2, h3, h4')
		);
		const labels = classesOf(container.querySelectorAll("label"));

		// A guard that read nothing would pass forever: the tab has one grouped
		// section (Redirects) and three labelled rows.
		expect(headings.length).toBeGreaterThan(0);
		expect(labels.length).toBeGreaterThanOrEqual(3);

		// The defect: `h3` and `Label` both `text-sm font-medium`.
		for (const heading of headings) {
			const headingType = typography(heading);
			expect(headingType.size).toBeGreaterThan(0);
			for (const label of labels) {
				const labelType = typography(label);
				expect(labelType.size).toBeGreaterThan(0);
				expect(headingType).not.toEqual(labelType);
			}
		}
	});

	it("gives no section its own name a second time", () => {
		render(<SettingsPanel />);

		// "Protocol" was the `h3` and the `Label` immediately below it. A section
		// holding one row is that row.
		expect(screen.getAllByText("Protocol")).toHaveLength(1);
	});

	it("states the scope once, and only where it is not the rule", () => {
		render(<SettingsPanel />);

		// It was on all three sections, in two variants. The exception - a load
		// test never streams - still says so, on the row it is about.
		expect(screen.getAllByText(/every Send and every load test/)).toHaveLength(1);
		expect(screen.getByText(/a load test always buffers/)).toBeTruthy();
	});

	it("builds its rows on the shared primitives instead of rolling them", () => {
		expect(PANEL_SOURCE.length).toBeGreaterThan(1000);
		expect(PANEL_SOURCE).toContain("SettingControls");

		// The controls the primitives own. A panel reaching for one of these
		// directly is re-rolling a row that already exists.
		for (const rolled of ["<Switch", "<Input", "<SelectTrigger", "<h3"]) {
			expect(PANEL_SOURCE).not.toContain(rolled);
		}
	});

	it("names every row's box, so the rows really are the primitives'", () => {
		const { container } = render(<SettingsPanel />);

		// `data-setting-row` is written by ToggleRow / NumberSettingRow /
		// SelectSettingRow from the same string that names their control - a
		// hand-rolled row would carry none.
		const named = [...container.querySelectorAll("[data-setting-row]")].map((el) =>
			el.getAttribute("data-setting-row")
		);
		expect(named).toEqual([
			"Protocol",
			"Follow redirects",
			"Maximum redirects",
			"Verify TLS certificate",
			"Event stream",
		]);
	});
});
