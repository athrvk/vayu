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
 * The request strip fits the room it has and sends the rest to a "+N" menu
 * (#2200).
 *
 * It was `overflow-x-auto` with a hidden scrollbar, so at the default split
 * (~430px) Examples and Settings were cut off with nothing to say they were
 * there. jsdom lays nothing out, so the wrapper's width is stubbed, as
 * `TabStrip.overflow.test.tsx` does for the document strip.
 *
 * Mutation check: render every trigger regardless of `visibleIds` and the
 * narrow cases fail (all eight tabs, no "more tabs" button).
 */

import { useState } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue, RequestTab } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import RequestTabs from "./index";

// The panels pull in Monaco, the variable inputs and the auth editors; none of
// that is what this guards.
vi.mock("./panels/InfoPanel", () => ({ default: () => null }));
vi.mock("./panels/ParamsPanel", () => ({ default: () => null }));
vi.mock("./panels/HeadersPanel", () => ({ default: () => null }));
vi.mock("./panels/BodyPanel", () => ({ default: () => null }));
vi.mock("./panels/AuthPanel", () => ({ default: () => null }));
vi.mock("./panels/ElementsPanel", () => ({ default: () => null }));
vi.mock("./panels/ExamplesPanel", () => ({ default: () => null }));
vi.mock("./panels/SettingsPanel", () => ({ default: () => null }));

const ALL_LABELS = [
	"Info",
	"Params",
	"Headers",
	"Body",
	"Auth",
	"Elements",
	"Examples",
	"Settings",
];

/** The real context's `activeTab` is state in the builder; this keeps it in the harness. */
function Harness({ initial }: { initial: RequestTab }) {
	const [activeTab, setActiveTab] = useState<RequestTab>(initial);
	const value = {
		request: createDefaultRequestState(),
		activeTab,
		setActiveTab,
	} as unknown as RequestBuilderContextValue;
	return (
		<RequestBuilderContext.Provider value={value}>
			<RequestTabs />
		</RequestBuilderContext.Provider>
	);
}

const renderTabs = (initial: RequestTab = "info") => render(<Harness initial={initial} />);

/**
 * `src/test/setup.ts` stubs a canvas whose `measureText` is always 0, which
 * would size every trigger to its padding alone. Seven pixels a character is
 * close to `text-xs`, so the tab widths are in a realistic ratio to the room.
 */
function stubTextMeasure() {
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		font: "",
		measureText: (text: string) => ({ width: text.length * 7 }),
	} as unknown as CanvasRenderingContext2D);
}

/** jsdom lays nothing out, so the measuring wrapper's width has to be supplied. */
function stubStripWidth(px: number) {
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.querySelector(':scope > [role="tablist"]') ? px : 0;
		},
	});
}

/** The visible label only: `TabLabel` renders a hidden bold twin before it. */
const labelOf = (tab: HTMLElement) =>
	tab.querySelector('[data-slot="tab-label-reserve"]')?.nextElementSibling?.textContent ?? "";

const shownLabels = () => screen.getAllByRole("tab").map(labelOf);

const moreButton = () => screen.queryByRole("button", { name: /\d+ more tabs/ });

function openMore(button: HTMLElement) {
	fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

const menuLabels = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

beforeEach(stubTextMeasure);
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	// @ts-expect-error - restore jsdom's own getter
	delete HTMLElement.prototype.clientWidth;
});

describe("the request tab strip, fitted to its pane", () => {
	it("shows all eight tabs and no menu when there is room", () => {
		stubStripWidth(2000);
		renderTabs();
		expect(shownLabels()).toEqual(ALL_LABELS);
		expect(moreButton()).toBeNull();
	});

	it("moves the surplus into a menu outside the tablist when there is not", () => {
		stubStripWidth(300);
		renderTabs();
		const shown = screen.getAllByRole("tab").length;
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(ALL_LABELS.length);
		const more = screen.getByRole("button", { name: `${ALL_LABELS.length - shown} more tabs` });
		expect(screen.getByRole("tablist").contains(more)).toBe(false);
	});

	it("lists exactly the hidden tabs, and choosing one selects it", () => {
		stubStripWidth(300);
		renderTabs();
		const before = shownLabels();
		openMore(moreButton() as HTMLElement);

		const hidden = menuLabels();
		expect(hidden.length).toBeGreaterThan(0);
		expect([...before, ...hidden].sort()).toEqual([...ALL_LABELS].sort());

		const choice = hidden[0] as string;
		fireEvent.click(screen.getByRole("menuitem", { name: choice }));

		const chosen = screen.getAllByRole("tab").find((t) => labelOf(t) === choice);
		expect(chosen).toBeDefined();
		expect(chosen).toHaveAttribute("aria-selected", "true");
		// The strip re-fit around the new active tab, so the menu no longer lists it.
		expect(shownLabels()).not.toEqual(before);
		openMore(moreButton() as HTMLElement);
		expect(menuLabels()).not.toContain(choice);
		expect(menuLabels().length).toBeGreaterThan(0);
	});

	it("keeps the active tab on screen however narrow it gets", () => {
		stubStripWidth(240);
		renderTabs("settings");
		const settings = screen.getAllByRole("tab").find((t) => labelOf(t) === "Settings");
		expect(settings).toBeDefined();
		expect(settings).toHaveAttribute("aria-selected", "true");
		expect(moreButton()).not.toBeNull();
	});
});
