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
 * The row that Params, Headers, Form Data and URL Encoded are all built from -
 * so it is the densest, most-repeated surface in the app, and the one where an
 * unstyled control is most visible.
 *
 * Two things were wrong with it, both invisible to a source scan of the kind
 * that has already passed over a live bug twice on this branch:
 *
 *   - The enable checkbox carried `rounded-md border-input`, neither of which a
 *     native checkbox honours without `appearance-none`. What it did *not*
 *     carry was `accent-color`, so it painted in the browser's fixed blue -
 *     ignoring both the theme and the user's accent scheme - while the
 *     variables table next door has always set `accent-scope-*`.
 *   - The resolved-value preview had no radius class at all, pinning it square
 *     at every Roundedness setting, and paired `truncate` with `overflow-x-auto`,
 *     which contradict: `truncate` sets `overflow: hidden`.
 *
 * That preview has since been replaced - it was a column taking an equal third
 * of the table to echo the two cells beside it - so those two guards are gone
 * with the element. What replaced them is below: *when* the resolved marker
 * appears, and the row's height.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import KeyValueRow from "./KeyValueRow";

vi.mock("../../context/RequestBuilderContext", () => ({
	useRequestBuilderContext: () => ({
		resolveString: (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_m, n) => `resolved-${n}`),
		getAllVariables: () => ({}),
		getVariableOrigins: () => [],
		writableScopes: [],
		updateVariable: () => {},
	}),
}));

function row(overrides: Partial<Parameters<typeof KeyValueRow>[0]> = {}) {
	const { container } = render(
		// The `{{format}}` token renders a variable chip, which hovers to a
		// tooltip - Radix requires the provider the app mounts at its root.
		<TooltipProvider>
			<KeyValueRow
				item={{ id: "r1", key: "Accept", value: "{{format}}", enabled: true }}
				keyPlaceholder="Header"
				valuePlaceholder="Value"
				showResolved={true}
				allowDisable={true}
				readOnly={false}
				onUpdate={() => {}}
				onRemove={() => {}}
				{...overrides}
			/>
		</TooltipProvider>
	);
	return container;
}

describe("the enable checkbox", () => {
	it("paints in the app's accent, not the browser default", () => {
		const box = row().querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(box).toBeTruthy();
		expect(box!.className).toMatch(/\baccent-primary\b/);
	});

	it("carries no properties a native checkbox silently ignores", () => {
		// `rounded-md` and `border-input` need `appearance-none` to do anything.
		// Leaving them on read as "this control is styled" when it was not.
		const box = row().querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(box!.className).not.toMatch(/\brounded-|\bborder-input\b/);
	});

	it("still names the row it governs", () => {
		const box = row().querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(box!.getAttribute("aria-label")).toBe("Enable Accept");
	});
});

describe("the resolved value", () => {
	/*
	 * It used to be a column holding an equal third of the table, printing
	 * `key=value` on every row whether or not anything resolved. Most rows have
	 * no variable, so most of that third echoed the two cells beside it.
	 *
	 * It is a marker now, on the rows that have something to show. The two
	 * guards that block replaced - a missing radius class and `truncate` paired
	 * with a contradicting `overflow-x-auto` - died with the element they were
	 * about; what matters here is *when* the marker appears, because a marker
	 * that shows on every row is the old column with extra steps, and one that
	 * never shows is the feature silently gone.
	 */
	const peek = (container: HTMLElement) =>
		container.querySelector<HTMLElement>('[aria-label^="Resolved value of"]');

	it("appears on a row that contains a variable", () => {
		expect(peek(row())).not.toBeNull();
	});

	it("stays away from a row with nothing to resolve", () => {
		const container = row({
			item: { id: "r1", key: "Accept", value: "application/json", enabled: true },
		});
		expect(peek(container)).toBeNull();
	});

	it("is a real control, so the resolved value is reachable without a mouse", () => {
		// Row-hover was the alternative and would have had nothing on screen to
		// say it existed - and would have fired underneath the variable token's
		// own tooltip.
		expect(peek(row())!.tagName).toBe("BUTTON");
	});

	it("names the row it belongs to", () => {
		expect(peek(row())!.getAttribute("aria-label")).toBe("Resolved value of Accept");
	});

	it("says nothing once the row is disabled", () => {
		// A disabled row is not sent, so there is no resolved value to report.
		const container = row({
			item: { id: "r1", key: "Accept", value: "{{format}}", enabled: false },
		});
		expect(peek(container)).toBeNull();
	});

	it("is withheld entirely when the caller turns resolution off", () => {
		const container = row({ showResolved: false });
		expect(peek(container)).toBeNull();
	});
});

describe("row density", () => {
	/*
	 * 48px per row in the densest table in the app: `h-9` fields, `p-1` on the
	 * row, `space-y-1` between. Eight headers cost 384px beside a 24px tab band.
	 */
	it("sizes both fields on the app's own step", () => {
		const fields = row().querySelectorAll<HTMLElement>('[class*="h-8"]');
		expect(fields.length).toBeGreaterThanOrEqual(2);
	});

	it("does not put the old h-9 back", () => {
		/*
		 * `String.raw`, deliberately - the same trap `no-dead-handlers.test.ts`
		 * records. Written as a plain regex literal through a generating
		 * script, the word-boundary escape collapsed to a backspace character
		 * and the pattern matched nothing - so the guard passed against its own
		 * mutation, which is the one failure a guard cannot have.
		 */
		expect(row().innerHTML).not.toMatch(new RegExp(String.raw`\bh-9\b`));
	});
});
