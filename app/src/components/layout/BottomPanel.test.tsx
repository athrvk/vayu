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
 * The bottom panel's shell (#3635): when it exists, how tall it is drawn, and
 * that its handle writes the one stored height, and which of its two tabs it
 * opens on. What a tab shows is the tab's own subject; `@/modules/console` and
 * `@/modules/logs` are stubbed so these cases do not move with them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useLayoutStore } from "@/stores";
import {
	BOTTOM_PANEL_LABEL,
	BOTTOM_PANEL_MAX_HEIGHT,
	BOTTOM_PANEL_MIN_HEIGHT,
	DEFAULT_BOTTOM_PANEL_HEIGHT,
} from "@/constants/layout";
import { BottomPanel } from "./BottomPanel";
import { REGION_ATTRIBUTE } from "./region-focus";

vi.mock("@/modules/console", () => ({ ConsoleTab: () => <div data-testid="console-tab" /> }));
vi.mock("@/modules/logs", () => ({ LogsTab: () => <div data-testid="logs-tab" /> }));

const panel = () => screen.getByRole("region", { name: BOTTOM_PANEL_LABEL });

/** A window `height` CSS px high - the cap is half of this. */
function windowHeight(height: number) {
	vi.stubGlobal("innerHeight", height);
}

beforeEach(() => {
	windowHeight(1000);
	useLayoutStore.setState({
		bottomPanelOpen: true,
		bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
		bottomPanelTab: "console",
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the bottom panel's presence", () => {
	it("renders nothing while closed, so a tab's content is not mounted", () => {
		useLayoutStore.setState({ bottomPanelOpen: false });
		const { container } = render(<BottomPanel />);
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByTestId("console-tab")).toBeNull();
		expect(screen.queryByTestId("logs-tab")).toBeNull();
	});

	it("renders a labelled region, a stop in the F6 cycle, with the Console tab first and selected", () => {
		render(<BottomPanel />);
		expect(panel()).toHaveAttribute(REGION_ATTRIBUTE, "bottom-panel");
		expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
			"Console",
			"Logs",
		]);
		expect(screen.getByRole("tab", { name: "Console" })).toHaveAttribute(
			"aria-selected",
			"true"
		);
		expect(screen.getByTestId("console-tab")).toBeInTheDocument();
		expect(screen.queryByTestId("logs-tab")).toBeNull();
	});

	it("opens on Logs when that is the stored tab, and mounts only its body", () => {
		useLayoutStore.setState({ bottomPanelTab: "logs" });
		render(<BottomPanel />);
		expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByTestId("logs-tab")).toBeInTheDocument();
		expect(screen.queryByTestId("console-tab")).toBeNull();
	});

	it("writes the tab a click selects", () => {
		render(<BottomPanel />);
		// Radix selects a tab on mouse down, not on click.
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Logs" }));
		expect(useLayoutStore.getState().bottomPanelTab).toBe("logs");
		expect(screen.getByTestId("logs-tab")).toBeInTheDocument();
	});

	it("falls back to the Console tab when the stored one no longer exists", () => {
		// A later release can remove a tab a user left active; the persisted id
		// then names nothing, and the panel must not render an empty body.
		useLayoutStore.setState({ bottomPanelTab: "retired" as never });
		render(<BottomPanel />);
		expect(screen.getByRole("tab", { name: "Console" })).toHaveAttribute(
			"aria-selected",
			"true"
		);
		expect(screen.getByTestId("console-tab")).toBeInTheDocument();
	});
});

describe("the bottom panel's height", () => {
	it("is the stored choice", () => {
		useLayoutStore.setState({ bottomPanelHeight: 300 });
		render(<BottomPanel />);
		expect(panel().style.height).toBe("300px");
	});

	it("never takes more than half the window, and keeps the stored choice", () => {
		useLayoutStore.setState({ bottomPanelHeight: 700 });
		windowHeight(768);
		render(<BottomPanel />);

		expect(panel().style.height).toBe("384px");
		expect(useLayoutStore.getState().bottomPanelHeight).toBe(700);
	});

	it("is drawn at the stored choice once the window is tall enough again", () => {
		useLayoutStore.setState({ bottomPanelHeight: 700 });
		windowHeight(1600);
		render(<BottomPanel />);
		expect(panel().style.height).toBe("700px");
	});

	it("stays above its floor in a window too short for half of it", () => {
		windowHeight(100);
		render(<BottomPanel />);
		expect(panel().style.height).toBe(`${BOTTOM_PANEL_MIN_HEIGHT}px`);
	});
});

describe("the bottom panel's top-edge handle", () => {
	const handle = () => screen.getByRole("separator", { name: "Resize console" });

	it("announces the panel's bounds in this window", () => {
		windowHeight(768);
		render(<BottomPanel />);
		expect(handle()).toHaveAttribute("aria-orientation", "horizontal");
		expect(handle()).toHaveAttribute("aria-valuenow", String(DEFAULT_BOTTOM_PANEL_HEIGHT));
		expect(handle()).toHaveAttribute("aria-valuemin", String(BOTTOM_PANEL_MIN_HEIGHT));
		expect(handle()).toHaveAttribute("aria-valuemax", "384");
	});

	it("grows the stored height on ArrowUp and persists nothing beyond the one field", () => {
		render(<BottomPanel />);
		fireEvent.keyDown(handle(), { key: "ArrowUp" });
		expect(useLayoutStore.getState().bottomPanelHeight).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT + 16);
		expect(panel().style.height).toBe(`${DEFAULT_BOTTOM_PANEL_HEIGHT + 16}px`);
	});

	it("cannot be nudged past half the window by End, nor below the floor by Home", () => {
		windowHeight(768);
		render(<BottomPanel />);
		fireEvent.keyDown(handle(), { key: "End" });
		expect(useLayoutStore.getState().bottomPanelHeight).toBe(384);
		fireEvent.keyDown(handle(), { key: "Home" });
		expect(useLayoutStore.getState().bottomPanelHeight).toBe(BOTTOM_PANEL_MIN_HEIGHT);
	});

	it("resets to the default on Enter", () => {
		useLayoutStore.setState({ bottomPanelHeight: 400 });
		render(<BottomPanel />);
		fireEvent.keyDown(handle(), { key: "Enter" });
		expect(useLayoutStore.getState().bottomPanelHeight).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
	});

	it("is held to the store's own ceiling however tall the window", () => {
		windowHeight(5000);
		render(<BottomPanel />);
		expect(handle()).toHaveAttribute("aria-valuemax", String(BOTTOM_PANEL_MAX_HEIGHT));
	});
});
