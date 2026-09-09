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
 * The rail is the Dock's former left nav, moved (#1615): every claim this file
 * makes used to be the Dock's, made in `Dock.services.test.tsx` and
 * `variables-icon.test.tsx`. Both are trimmed to their Dock-only halves now
 * that the switchers live here instead.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui";
import { useEngineStore, useLayoutStore } from "@/stores";
import type { Inbox } from "@/types";
import { DRAWER_VIEW_CHORDS } from "@/constants/shortcuts";
import { formatChord } from "@/lib/platform";
import { ActivityRail } from "./ActivityRail";

const listInboxes = vi.fn();
const listMockIssuers = vi.fn();
const listMockServers = vi.fn();

vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			listInboxes: () => listInboxes(),
			listMockIssuers: () => listMockIssuers(),
			listMockServers: () => listMockServers(),
		},
	};
});

function inbox(overrides: Partial<Inbox> = {}): Inbox {
	return {
		inboxId: "inbox_a",
		url: "http://127.0.0.1:41234/",
		bind: "127.0.0.1",
		port: 41234,
		running: true,
		loopback: true,
		captureCount: 0,
		response: { status: 200, body: "", headers: {}, delayMs: 0 },
		...overrides,
	};
}

function renderRail() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ActivityRail />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** lucide stamps each icon with `lucide-<kebab-name>` beside the shared `lucide` class. */
function iconNames(root: Element): string[] {
	return Array.from(root.querySelectorAll("svg"))
		.flatMap((svg) => svg.getAttribute("class")?.split(/\s+/) ?? [])
		.filter((c) => c.startsWith("lucide-"))
		.map((c) => c.slice("lucide-".length));
}

beforeEach(() => {
	cleanup();
	listInboxes.mockReset().mockResolvedValue([]);
	listMockIssuers.mockReset().mockResolvedValue([]);
	listMockServers.mockReset().mockResolvedValue([]);
	useLayoutStore.setState({ drawerOpen: true, drawerView: "collections" });
	useEngineStore.setState({ engineStatus: "connected", engineError: null });
});

describe("ActivityRail - the six view buttons", () => {
	it("renders the six views in DRAWER_VIEWS order with their labels", () => {
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Sidebar views" });
		const buttons = Array.from(nav.querySelectorAll("button"));
		expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
			"Collections",
			"History",
			"Variables",
			"Services",
			"Trash",
			"Settings",
		]);
	});

	it("every tooltip names the chord from constants/shortcuts.ts", async () => {
		renderRail();
		const button = screen.getByRole("button", { name: "Collections" });
		fireEvent.focus(button);
		expect(
			await screen.findByText(`Collections ${formatChord(DRAWER_VIEW_CHORDS.collections)}`)
		).toBeInTheDocument();
	});

	it("does not reuse an icon another button already owns", () => {
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Sidebar views" });
		const buttons = Array.from(nav.querySelectorAll("button"));
		expect(buttons).toHaveLength(6);
		const perButton = buttons.map((b) => iconNames(b).join("+"));
		expect(new Set(perButton).size).toBe(perButton.length);
	});

	it("keeps the load-test bolt out of the switchers entirely", () => {
		// `Zap` means "load test" everywhere else in the app; any of the six
		// wearing it would re-introduce that misreading in a different slot.
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Sidebar views" });
		expect(iconNames(nav)).not.toContain("zap");
	});

	it("draws Variables as Braces, not the load-test bolt", () => {
		renderRail();
		const names = iconNames(screen.getByRole("button", { name: "Variables" }));
		expect(names).toContain("braces");
		expect(names).not.toContain("zap");
	});

	it("marks the active view's button pressed, and clicking the active one collapses the Drawer", () => {
		useLayoutStore.setState({ drawerOpen: true, drawerView: "collections" });
		renderRail();
		const collections = screen.getByRole("button", { name: "Collections" });
		expect(collections).toHaveAttribute("aria-pressed", "true");

		fireEvent.click(collections);
		expect(useLayoutStore.getState().drawerOpen).toBe(false);
	});

	it("clicking another view opens the Drawer to it", () => {
		useLayoutStore.setState({ drawerOpen: false, drawerView: "collections" });
		renderRail();
		fireEvent.click(screen.getByRole("button", { name: "Services" }));
		expect(useLayoutStore.getState()).toMatchObject({
			drawerOpen: true,
			drawerView: "services",
		});
	});
});

describe("ActivityRail - roving tabindex", () => {
	it("keeps exactly one tab stop, on the currently selected view", () => {
		useLayoutStore.setState({ drawerOpen: false, drawerView: "history" });
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Sidebar views" });
		const buttons = Array.from(nav.querySelectorAll("button"));
		expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([
			screen.getByRole("button", { name: "History" }),
		]);
	});

	it("ArrowDown moves focus to the next button and promotes its tab stop", () => {
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Sidebar views" });
		const collections = screen.getByRole("button", { name: "Collections" });
		const history = screen.getByRole("button", { name: "History" });
		collections.focus();

		fireEvent.keyDown(nav, { key: "ArrowDown" });

		expect(document.activeElement).toBe(history);
		expect(history.tabIndex).toBe(0);
		expect(collections.tabIndex).toBe(-1);
		// Focus moved without activating - arrowing past every view must not
		// switch the Drawer six times.
		expect(useLayoutStore.getState().drawerView).toBe("collections");
	});

	it("ArrowUp from the first button wraps to the last", () => {
		renderRail();
		const nav = screen.getByRole("navigation", { name: "Sidebar views" });
		screen.getByRole("button", { name: "Collections" }).focus();

		fireEvent.keyDown(nav, { key: "ArrowUp" });

		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Settings" }));
	});
});

describe("ActivityRail - the Services badge (#502, #1615)", () => {
	it("shows no badge while nothing is running", async () => {
		renderRail();
		await waitFor(() => expect(listMockIssuers).toHaveBeenCalled());
		const services = screen.getByRole("button", { name: "Services" });
		expect(services.querySelector("[data-services-badge]")).not.toBeInTheDocument();
	});

	it("shows a badge dot on Services once a service is running", async () => {
		listInboxes.mockResolvedValue([inbox()]);
		renderRail();
		await waitFor(() => {
			const services = screen.getByRole("button", { name: "Services" });
			expect(services.querySelector("[data-services-badge]")).toBeInTheDocument();
		});
	});
});
