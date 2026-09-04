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
 * The title-bar app icon: two menus, three platforms.
 *
 * The window is frameless, so Windows and Linux draw no menu bar and the
 * application menu had no mouse route at all - Help > Documentation, About Vayu
 * and Check for Updates were reachable only by a shortcut nobody could see
 * (#1361). Left click opens that menu on both; on Windows right click keeps the
 * system menu, which is the platform's own convention for this icon and was the
 * only thing the icon did before. macOS renders no button: the menu bar there
 * already draws the same template.
 *
 * The platform split is the whole point, so every branch is asserted rather
 * than the one this machine happens to be. `isWindows` and `isLinux` are read
 * at module scope, so the platform is stubbed before TitleBar is imported -
 * hence the dynamic import per case rather than a top-level one.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { APP_MENU_CHORD } from "@/constants/shortcuts";

// Spread the real module: the environment switcher reaches for more than the
// one query stubbed here, and listing them by hand breaks whenever that
// changes.
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useEnvironmentsQuery: () => ({ data: [] }),
}));

const systemMenu = vi.fn();
const appMenu = vi.fn();
const windowClose = vi.fn();

/**
 * `-webkit-app-region` is not on CSSStyleDeclaration in TypeScript's DOM lib,
 * and jsdom keeps it as a style property without serialising it back to the
 * style attribute - so read the property, with a cast, rather than the markup.
 */
const appRegion = (el: HTMLElement) =>
	(el.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion;

function stubPlatform(platform: string) {
	Object.defineProperty(window, "electronAPI", {
		value: {
			platform,
			windowSystemMenu: systemMenu,
			windowAppMenu: appMenu,
			windowIsMaximized: () => Promise.resolve(false),
			onWindowMaximized: () => () => {},
			windowMinimize: () => {},
			windowMaximize: () => {},
			windowClose,
		},
		writable: true,
		configurable: true,
	});
}

/** Fresh module graph, so `isWindows` / `isLinux` are recomputed against the stub. */
async function renderFor(platform: string) {
	stubPlatform(platform);
	vi.resetModules();
	const [{ default: TitleBar }, { TooltipProvider }] = await Promise.all([
		import("./TitleBar"),
		import("@/components/ui"),
	]);
	renderTitleBar(TitleBar, TooltipProvider);
}

/** The environment switcher's mutation runs through react-query, so the title
 *  bar needs a client even when the test is about the icon. */
function renderTitleBar(
	TitleBar: () => React.ReactNode,
	// From the same fresh graph as the bar: after `resetModules` a statically
	// imported provider is a different Radix instance, and the tooltips the
	// navigation buttons carry would find no context.
	TooltipProvider: typeof import("@/components/ui").TooltipProvider
) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<TitleBar />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

const icon = () => screen.getByRole("button", { name: /application menu/i });

/** Alt pressed and released with nothing in between - the native gesture. */
function tapAlt() {
	fireEvent.keyDown(window, { key: "Alt" });
	fireEvent.keyUp(window, { key: "Alt" });
}

/** A dialog, as `isModalOpen` reads one. */
function openModal() {
	const dialog = document.createElement("div");
	dialog.setAttribute("data-slot", "dialog-content");
	dialog.setAttribute("data-state", "open");
	document.body.appendChild(dialog);
	return dialog;
}

beforeEach(() => {
	cleanup();
	document.body.innerHTML = "";
	systemMenu.mockClear();
	appMenu.mockClear();
	windowClose.mockClear();
});
afterEach(() => vi.resetModules());

describe.each([["win32"], ["linux"]])("app icon on %s", (platform) => {
	it("opens the application menu on left click", async () => {
		await renderFor(platform);
		fireEvent.click(icon());
		expect(appMenu).toHaveBeenCalledTimes(1);
		expect(systemMenu).not.toHaveBeenCalled();
	});

	it("anchors the menu to the icon, not the pointer", async () => {
		await renderFor(platform);
		fireEvent.click(icon());
		// jsdom lays nothing out, so the numbers are zeroes - what matters is that
		// a position derived from the element is sent at all, rather than none.
		expect(appMenu).toHaveBeenCalledWith(
			expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
		);
	});

	it("leaves the drag region, or it could not be clicked", async () => {
		await renderFor(platform);
		expect(appRegion(icon())).toBe("no-drag");
	});

	/*
	 * A `role="button"` owes the keyboard what a real button gives for free, and
	 * this one gave neither half: no tab stop, no key handler (#1216).
	 */
	it("is a tab stop", async () => {
		await renderFor(platform);
		expect(icon()).toHaveAttribute("tabindex", "0");
	});

	it.each([
		["Enter", { key: "Enter" }],
		["Space", { key: " " }],
	])("opens the application menu on %s", async (_name, event) => {
		await renderFor(platform);
		fireEvent.keyDown(icon(), event);
		expect(appMenu).toHaveBeenCalledTimes(1);
	});

	it("leaves an IME's committing Enter and the app's chords alone", async () => {
		// The IME commits its buffer with an ordinary keydown (`isCommitEnter`),
		// and mod+Enter is the Send chord bound on the window - neither is a press
		// of this control.
		await renderFor(platform);
		fireEvent.keyDown(icon(), { key: "Enter", isComposing: true });
		fireEvent.keyDown(icon(), { key: "Enter", metaKey: true });
		fireEvent.keyDown(icon(), { key: "Enter", ctrlKey: true });
		fireEvent.keyDown(icon(), { key: "a" });
		expect(appMenu).not.toHaveBeenCalled();
	});

	it(`opens the application menu on ${APP_MENU_CHORD.key}, from anywhere in the window`, async () => {
		await renderFor(platform);
		fireEvent.keyDown(window, { key: APP_MENU_CHORD.key });
		expect(appMenu).toHaveBeenCalledTimes(1);
	});

	it("opens it on a tap of Alt, the way the platform does", async () => {
		await renderFor(platform);
		tapAlt();
		expect(appMenu).toHaveBeenCalledTimes(1);
	});

	it("does not open it for Alt used as a modifier", async () => {
		// Alt+← is Go back; a menu opening on it would open on every navigation.
		await renderFor(platform);
		fireEvent.keyDown(window, { key: "Alt" });
		fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
		fireEvent.keyUp(window, { key: "Alt" });
		expect(appMenu).not.toHaveBeenCalled();
	});

	it("stays shut while a dialog owns the window", async () => {
		// Window-level chords fire wherever focus is, including inside an open
		// dialog (#935).
		await renderFor(platform);
		openModal();
		fireEvent.keyDown(window, { key: APP_MENU_CHORD.key });
		tapAlt();
		expect(appMenu).not.toHaveBeenCalled();
	});

	it("stops listening once the bar is gone", async () => {
		// The listeners are on `window`, which outlives the component.
		await renderFor(platform);
		cleanup();
		fireEvent.keyDown(window, { key: APP_MENU_CHORD.key });
		tapAlt();
		expect(appMenu).not.toHaveBeenCalled();
	});

	it("follows the spec's 16px icon at a 16px inset", async () => {
		// "The size of the window icon is 16px by 16px", placed "16px from the
		// left-most border". It was 20px at 12px.
		await renderFor(platform);
		expect(icon().className).toContain("pl-4");
		expect(icon().querySelector("img")?.className).toContain("w-4");
	});
});

describe("the system menu, which is Windows' alone", () => {
	it("opens on right click there", async () => {
		// Taking the icon out of the drag region is what removed the platform's
		// own context menu. If this stops firing, right click does nothing at all.
		await renderFor("win32");
		fireEvent.contextMenu(icon());
		expect(systemMenu).toHaveBeenCalledTimes(1);
		expect(appMenu).not.toHaveBeenCalled();
	});

	it("is not offered on Linux, which has none", async () => {
		await renderFor("linux");
		fireEvent.contextMenu(icon());
		expect(systemMenu).not.toHaveBeenCalled();
	});

	it("closes the window on a double click on Windows", async () => {
		// The icon's own convention there, distinct from the rest of the bar,
		// where a double click toggles maximise.
		await renderFor("win32");
		fireEvent.doubleClick(icon());
		expect(windowClose).toHaveBeenCalledTimes(1);
	});

	it("does not close it on Linux, where that is nobody's convention", async () => {
		await renderFor("linux");
		fireEvent.doubleClick(icon());
		expect(windowClose).not.toHaveBeenCalled();
	});
});

describe("app icon on macOS", () => {
	/*
	 * macOS states app identity in the Dock and the menu bar, its traffic lights
	 * own this corner, and - the reason that matters here - its menu bar already
	 * draws the same template. Nothing renders, and nothing listens.
	 */
	it("renders no button", async () => {
		await renderFor("darwin");
		expect(screen.queryByRole("button", { name: /application menu/i })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /system menu/i })).not.toBeInTheDocument();
	});

	it("claims neither F10 nor Alt", async () => {
		await renderFor("darwin");
		fireEvent.keyDown(window, { key: APP_MENU_CHORD.key });
		tapAlt();
		expect(appMenu).not.toHaveBeenCalled();
	});
});
