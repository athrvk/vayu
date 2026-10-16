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
 * The response strip fits the room it has and sends the rest to a "+N" menu
 * (#2200).
 *
 * It was `overflow-x-auto` with a hidden scrollbar, so at the default split
 * (~430px) Events and Raw were simply cut off with nothing to say they existed.
 * jsdom lays nothing out, so the wrapper's width is stubbed, as
 * `TabStrip.overflow.test.tsx` does for the document strip.
 *
 * Mutation check: render every trigger regardless of `visibleIds` and the
 * narrow cases fail (all eight tabs, no "more tabs" button).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import type { ResponseState } from "../../types";
import ResponseViewer from "./index";

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
	CodeEditor: ({ value }: { value?: string }) => <div data-testid="body-content">{value}</div>,
}));

const state: {
	response: ResponseState | null;
	isExecuting: boolean;
	request: { id: string | null };
} = { response: null, isExecuting: false, request: { id: null } };
vi.mock("../../context", () => ({
	useRequestBuilderContext: () => state,
}));

const ALL_LABELS = ["Body", "Headers", "Cookies", "Timing", "Console", "Tests", "Events", "Raw"];

function aResponse(): ResponseState {
	return {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: "the-response-body",
		bodyType: "json",
		size: 18,
		time: 12,
	};
}

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

function renderViewer() {
	return render(
		<TooltipProvider>
			<ResponseViewer />
		</TooltipProvider>
	);
}

/** The visible label only: `TabLabel` renders a hidden bold twin before it. */
const labelOf = (tab: HTMLElement) =>
	tab.querySelector('[data-slot="tab-label-reserve"]')?.nextElementSibling?.textContent ?? "";

const shownLabels = () => screen.getAllByRole("tab").map(labelOf);

/** The "N more tabs" trigger, or null when the strip fits. */
const moreButton = () => screen.queryByRole("button", { name: /\d+ more tabs/ });

function openMore(button: HTMLElement) {
	fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

const menuLabels = () => screen.getAllByRole("menuitem").map((el) => el.textContent);

beforeEach(() => {
	useTabSelectionStore.getState().clearAll();
	state.response = aResponse();
	state.isExecuting = false;
	state.request = { id: null };
	stubTextMeasure();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	// @ts-expect-error - restore jsdom's own getter
	delete HTMLElement.prototype.clientWidth;
});

describe("the response tab strip, fitted to its pane", () => {
	it("shows all eight tabs and no menu when there is room", () => {
		stubStripWidth(2000);
		renderViewer();
		expect(shownLabels()).toEqual(ALL_LABELS);
		expect(moreButton()).toBeNull();
	});

	it("moves the surplus into a menu outside the tablist when there is not", () => {
		stubStripWidth(300);
		renderViewer();
		const shown = screen.getAllByRole("tab").length;
		expect(shown).toBeGreaterThan(0);
		expect(shown).toBeLessThan(ALL_LABELS.length);
		const more = screen.getByRole("button", { name: `${ALL_LABELS.length - shown} more tabs` });
		// A `role="tablist"` owns only tabs; a menu button inside it is announced as
		// one of them.
		expect(screen.getByRole("tablist").contains(more)).toBe(false);
	});

	it("lists exactly the hidden tabs, and choosing one selects it", () => {
		stubStripWidth(300);
		renderViewer();
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
		// The strip re-fit around the new active tab: something that was showing
		// gave up its place, so the menu now lists a tab it did not before.
		expect(shownLabels()).not.toEqual(before);
		openMore(moreButton() as HTMLElement);
		expect(menuLabels()).not.toContain(choice);
		expect(menuLabels().length).toBeGreaterThan(0);
	});

	it("keeps the active tab on screen however narrow it gets", () => {
		state.request.id = "req_a";
		useTabSelectionStore.getState().setResponseTab("req_a", "raw-request");
		stubStripWidth(240);
		renderViewer();
		const raw = screen.getAllByRole("tab").find((t) => labelOf(t) === "Raw");
		expect(raw).toBeDefined();
		expect(raw).toHaveAttribute("aria-selected", "true");
		expect(moreButton()).not.toBeNull();
	});

	it("keeps Save as example beside the tabs, outside the measured wrapper", () => {
		state.request.id = "req_a";
		stubStripWidth(300);
		renderViewer();
		const save = screen.getByRole("button", { name: /Save as example/ });
		const wrapper = screen.getByRole("tablist").parentElement as HTMLElement;
		expect(wrapper.contains(save)).toBe(false);
		expect(within(wrapper).getAllByRole("tab").length).toBeGreaterThan(0);
	});
});
