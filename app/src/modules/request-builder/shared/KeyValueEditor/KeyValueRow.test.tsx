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
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import KeyValueRow from "./KeyValueRow";

vi.mock("../../context/RequestBuilderContext", () => ({
	useRequestBuilderContext: () => ({
		resolveString: (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_m, n) => `resolved-${n}`),
		getAllVariables: () => ({}),
		updateVariable: () => {},
	}),
}));

function row(overrides: Partial<Parameters<typeof KeyValueRow>[0]> = {}) {
	const { container } = render(
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

describe("the resolved-value preview", () => {
	/** The preview box: the only `bg-muted/50` element in the row. */
	const preview = (container: HTMLElement) =>
		Array.from(container.querySelectorAll<HTMLElement>("*")).find((el) =>
			/\bbg-muted\/50\b/.test(el.className)
		)!;

	it("follows the roundedness setting", () => {
		expect(preview(row()).className).toMatch(/\brounded-md\b/);
	});

	it("does not pair truncate with an overflow rule that contradicts it", () => {
		const cls = preview(row()).className;
		expect(cls).toMatch(/\btruncate\b/);
		expect(cls).not.toMatch(/\boverflow-x-auto\b/);
	});

	it("still shows the resolved value", () => {
		expect(preview(row()).textContent).toContain("resolved-format");
	});

	it("shows a dash rather than a stale value once the row is disabled", () => {
		const container = row({
			item: { id: "r1", key: "Accept", value: "{{format}}", enabled: false },
		});
		expect(preview(container).textContent).toBe("-");
	});
});
