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
 * Switching environment has to say so.
 *
 * It is a silent change with loud consequences: every `{{variable}}` in every
 * open request resolves against the new environment, so the same Send can hit a
 * different host. The only feedback was the switcher's own label - which the
 * open menu is covering at the moment of the click, and which the user is not
 * looking at afterwards.
 *
 * The no-op case is the one worth pinning. Re-picking the environment already
 * active is the most likely way to use this menu (opening it to check *which*
 * one is active, then closing it), and a toast there would be pure noise.
 *
 * The switch is now a write to the engine (`isActive`), which is why the
 * confirmations are awaited rather than read synchronously: the toast reports
 * what the engine accepted, so a failed write says so instead of announcing a
 * switch that will be gone by the next launch.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/*
 * TitleBar reads `window.electronAPI` at module scope and renders nothing
 * without it, so the stub has to be in place before the import is evaluated -
 * `vi.hoisted` is the only thing that runs early enough. A plain
 * `vi.stubGlobal` at module scope runs *after* the hoisted imports and the
 * component would already have decided it was not in Electron.
 */
vi.hoisted(() => {
	Object.defineProperty(globalThis.window, "electronAPI", {
		// Linux is the branch that also renders WindowControls, which calls these
		// on mount - so the stub has to be a working surface, not just a platform.
		value: {
			platform: "linux",
			windowIsMaximized: () => Promise.resolve(false),
			onWindowMaximized: () => () => {},
			windowMinimize: () => {},
			windowMaximize: () => {},
			windowClose: () => {},
		},
		writable: true,
		configurable: true,
	});
});

import { useToastStore, useSessionStore } from "@/stores";
import TitleBar from "./TitleBar";
import { TooltipProvider } from "@/components/ui";

const environments = [
	{ id: "env-1", name: "Staging" },
	{ id: "env-2", name: "Production" },
];

/*
 * Spread the real module and override only the environments. Listing exports by
 * hand broke every time TitleBar's subtree reached for another query - TabStrip
 * resolves each tab's label through several - and the failure is a mock error,
 * not a behaviour one.
 */
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useEnvironmentsQuery: () => ({ data: environments }),
}));

/*
 * The real `useSetActiveEnvironmentMutation` runs against this, so the store
 * write, the rollback and the toast all follow the same path they do in the
 * app - only the transport is faked.
 */
const updateEnvironment = vi.fn();
vi.mock("@/services/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/api")>();
	return {
		...actual,
		apiService: {
			...actual.apiService,
			updateEnvironment: (...a: unknown[]) => updateEnvironment(...a),
		},
	};
});

/** TabStrip resolves every tab's label through `useQueries`, so the title bar
 *  needs a client even when the test is about the icon or the env switcher. */
function renderTitleBar(TitleBar: () => React.ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		// The row's navigation buttons carry tooltips, which rely on the app-level
		// provider `main.tsx` supplies.
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<TitleBar />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	cleanup();
	useToastStore.setState({ toasts: [] });
	useSessionStore.setState({ activeEnvironmentId: null });
	updateEnvironment.mockReset();
	updateEnvironment.mockResolvedValue({ id: "env-1", name: "Staging", isActive: true });
});

/*
 * Radix opens a dropdown on pointerdown, not click, and jsdom fires no pointer
 * events from `fireEvent.click`. Keyboard activation is the reliable path here
 * and exercises the same open handler.
 *
 * The menu genuinely has to open: without it the "stays quiet" cases below
 * would pass for the wrong reason - no menu, no click, no toast.
 */
function openMenu() {
	const trigger = screen.getByRole("button", { name: /switch environment/i });
	fireEvent.keyDown(trigger, { key: "Enter" });
	// Fail loudly here rather than letting a silent no-op look like a pass.
	const menu = screen.getByRole("menu");
	expect(menu).toBeInTheDocument();
	// Scoped: the trigger shows the active environment's name too, so an
	// unscoped getByText matches both it and the menu item.
	return within(menu);
}

const messages = () => useToastStore.getState().toasts.map((t) => t.message);

describe("environment switch notification", () => {
	it("names the environment it switched to", async () => {
		renderTitleBar(TitleBar);
		const menu = openMenu();
		fireEvent.click(menu.getByText("Staging"));

		expect(useSessionStore.getState().activeEnvironmentId).toBe("env-1");
		// The destination, not the act: the toast answers "which one am I on now".
		await waitFor(() => expect(messages()).toEqual(["Environment: Staging"]));
		expect(useToastStore.getState().toasts[0].variant).toBe("info");
		// One PUT carries the whole switch - the engine clears the previous one.
		expect(updateEnvironment).toHaveBeenCalledWith({ id: "env-1", isActive: true });
	});

	it("says so when the environment is cleared", async () => {
		useSessionStore.setState({ activeEnvironmentId: "env-1" });
		renderTitleBar(TitleBar);
		const menu = openMenu();
		fireEvent.click(menu.getByText("No Environment"));

		expect(useSessionStore.getState().activeEnvironmentId).toBeNull();
		await waitFor(() => expect(messages()).toEqual(["Environment cleared"]));
		// Clearing is deactivating the row that holds the flag.
		expect(updateEnvironment).toHaveBeenCalledWith({ id: "env-1", isActive: false });
	});

	it("reports a switch the engine refused, and keeps the old one", async () => {
		/*
		 * The dangerous failure is a confident one: the switcher says Staging,
		 * every send keeps resolving against Production, and the next launch
		 * agrees with the engine rather than the label the user was shown.
		 */
		updateEnvironment.mockRejectedValue(new Error("engine unreachable"));
		useSessionStore.setState({ activeEnvironmentId: "env-2" });
		renderTitleBar(TitleBar);
		const menu = openMenu();
		fireEvent.click(menu.getByText("Staging"));

		await waitFor(() =>
			expect(messages()).toEqual(["Could not switch environment: engine unreachable"])
		);
		expect(useToastStore.getState().toasts[0].variant).toBe("error");
		expect(useSessionStore.getState().activeEnvironmentId).toBe("env-2");
	});

	it("stays quiet when the chosen environment is already active", () => {
		useSessionStore.setState({ activeEnvironmentId: "env-1" });
		renderTitleBar(TitleBar);
		const menu = openMenu();
		fireEvent.click(menu.getByText("Staging"));

		expect(messages()).toEqual([]);
	});

	it("stays quiet when No Environment is re-picked from cleared", () => {
		renderTitleBar(TitleBar);
		const menu = openMenu();
		fireEvent.click(menu.getByText("No Environment"));

		expect(messages()).toEqual([]);
	});
});

describe("environment selector tokens", () => {
	/*
	 * Two token mistakes this pins, both readable only against the design system:
	 *
	 * `--accent` is the *hover* background (`--accent-active` is the selected
	 * one). It was the resting fill, hovering to `--accent/80` - so the control
	 * got lighter under the pointer instead of more prominent.
	 *
	 * And `--scope-environment` is the app's colour for "environment": the
	 * variable badges, the autocomplete and the variables tree all use it on the
	 * documented solid-text-on-a-/10-tint convention. The control that *selects*
	 * an environment was the one surface not saying it.
	 */
	const trigger = () => screen.getByRole("button", { name: /switch environment/i });

	it("tracks the accent once an environment is selected", () => {
		// Every other selected surface follows the scheme - the Appearance cards,
		// the active tab's rule. A pill on a fixed hue stayed blue while the
		// accent was Coral, which made it look broken rather than deliberate.
		useSessionStore.setState({ activeEnvironmentId: "env-1" });
		renderTitleBar(TitleBar);
		const cls = trigger().className;
		expect(cls).toContain("bg-primary/10");
		expect(cls).toContain("border-primary/30");
		// --primary-text, not --primary: on graphite the accent is a neutral and
		// would read as grey text on a grey tint.
		expect(cls).toContain("text-primary-text");
		expect(cls).not.toContain("scope-environment");
	});

	it("never uses the hover token as a resting fill", () => {
		useSessionStore.setState({ activeEnvironmentId: "env-1" });
		renderTitleBar(TitleBar);
		const cls = trigger().className;
		// `bg-accent` at rest - the thing being fixed. `hover:bg-accent` is fine.
		expect(cls).not.toMatch(/(^|\s)bg-accent(\s|$)/);
		expect(cls).not.toContain("bg-accent/80");
	});

	it("stays muted with a transparent border when nothing is selected", () => {
		renderTitleBar(TitleBar);
		const cls = trigger().className;
		expect(cls).toContain("text-muted-foreground");
		// Border in both states so selecting does not resize the control by 2px.
		expect(cls).toContain("border-transparent");
		expect(cls).toContain("hover:bg-accent");
	});

	it("keeps a border in both states so the control does not resize", () => {
		renderTitleBar(TitleBar);
		const idle = trigger().className;
		cleanup();
		useSessionStore.setState({ activeEnvironmentId: "env-1" });
		renderTitleBar(TitleBar);
		const active = trigger().className;
		for (const cls of [idle, active]) expect(cls).toMatch(/(^|\s)border(\s|$)/);
	});
});
