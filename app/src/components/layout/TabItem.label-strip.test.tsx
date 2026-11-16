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
 * A tab name wider than the tab never runs under the close button (#3495).
 *
 * The button is absolute, so it is in nobody's way unless the label's own box
 * stops short of it: a name clamped at the width cap filled the tab to its
 * `px-3` padding and ran 14px under the button, with no ellipsis because the
 * label sits in `ScrollOnOverflow`'s `w-fit` track. jsdom has no layout, so the
 * rule is held as the reservation the label viewport carries, derived from the
 * button's and the row's own classes rather than restated beside them.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TabItemImpl } from "./TabItem";
import { useTabsStore } from "@/stores";
import type { TabDescriptor } from "./tab-descriptors";

const LONG = "Customers and their linked payment instruments, cards and bank accounts";
const DESCRIPTOR: TabDescriptor = { label: LONG, title: LONG };

function renderTab(descriptor: TabDescriptor = DESCRIPTOR) {
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "settings", entityId: null }],
		activeTabId: "t1",
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<TabItemImpl
				tab={{ id: "t1", type: "settings", entityId: null }}
				isActive
				isRovingStop
				width={220}
				descriptor={descriptor}
			/>
		</QueryClientProvider>
	);
	const tab = screen.getByRole("tab");
	const closeButton = tab.querySelector<HTMLElement>("[data-tab-close]")!;
	// label span -> the track -> the viewport.
	const viewport = screen.getByText(descriptor.label).parentElement!.parentElement!;
	return { tab, closeButton, viewport };
}

/** The number in the first class matching `prefix`, e.g. `right-` in `right-0.5`. */
function unitsOf(el: HTMLElement, prefix: string): number {
	const match = el.className.split(/\s+/).find((c) => new RegExp(`^${prefix}[\\d.]+$`).test(c));
	expect(match, `${prefix}N on ${el.className}`).toBeDefined();
	return Number(match!.slice(prefix.length));
}

afterEach(cleanup);

describe("TabItem label viewport", () => {
	it("reserves the close button's strip, so a clamped name stops where the button starts", () => {
		const { tab, closeButton, viewport } = renderTab();
		// The button is `size-target` wide at `right-0.5`; the row's `px-3` already keeps
		// the viewport that far from the edge, so the margin is the button's width less
		// the part of the padding that lies beyond the button's own offset.
		expect(closeButton.className).toContain("size-target");
		const paddingPastOffset = unitsOf(tab, "px-") - unitsOf(closeButton, "right-");
		expect(viewport.className).toContain(
			`mr-[calc(var(--spacing-target)_-_var(--spacing)_*_${paddingPastOffset})]`
		);
		expect(viewport.className).toContain("min-w-0");
		expect(viewport.className).toContain("flex-1");
	});

	it("keeps the label on the scrolling viewport, which clips it", () => {
		const { viewport } = renderTab();
		expect(viewport.className).toContain("overflow-hidden");
		// A `truncate` inside the `w-fit` track never engages; it only claims to.
		expect(screen.getByText(LONG).className).not.toContain("truncate");
	});
});
