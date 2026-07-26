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
 * The title-bar app icon is the system-menu control on Windows, and only there.
 *
 * The platform split is the whole point, so both branches are asserted rather
 * than the one this machine happens to be. On Windows the icon leaves the drag
 * region - a draggable area ignores every pointer event, so it could not
 * otherwise take a click - and that is exactly what removes the platform's own
 * right-click menu, which is why both buttons have to be handled. Elsewhere it
 * stays a drag region and does nothing, because neither macOS nor GNOME has
 * this convention and the drag surface is worth more there.
 *
 * `isWindows` is read at module scope, so the platform has to be stubbed before
 * TitleBar is imported - hence the dynamic import per case rather than a
 * top-level one.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Spread the real module: TitleBar's subtree (TabStrip) reaches for several
// queries, and listing them by hand breaks whenever that changes.
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useEnvironmentsQuery: () => ({ data: [] }),
}));

const systemMenu = vi.fn();

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
			windowIsMaximized: () => Promise.resolve(false),
			onWindowMaximized: () => () => {},
			windowMinimize: () => {},
			windowMaximize: () => {},
			windowClose: () => {},
		},
		writable: true,
		configurable: true,
	});
}

/** Fresh module graph, so `isWindows` is recomputed against the stub. */
async function renderFor(platform: string) {
	stubPlatform(platform);
	vi.resetModules();
	const { default: TitleBar } = await import("./TitleBar");
	renderTitleBar(TitleBar);
}

/** TabStrip resolves every tab's label through `useQueries`, so the title bar
 *  needs a client even when the test is about the icon or the env switcher. */
function renderTitleBar(TitleBar: () => React.ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<TitleBar />
		</QueryClientProvider>
	);
}

beforeEach(() => {
	cleanup();
	systemMenu.mockClear();
});
afterEach(() => vi.resetModules());

describe("app icon on Windows", () => {
	it("opens the system menu on left click", async () => {
		await renderFor("win32");
		fireEvent.click(screen.getByRole("button", { name: /system menu/i }));
		expect(systemMenu).toHaveBeenCalledTimes(1);
	});

	it("opens it on right click too", async () => {
		// Taking the icon out of the drag region is what removed the platform's
		// own context menu. If this stops firing, right click does nothing at all.
		await renderFor("win32");
		fireEvent.contextMenu(screen.getByRole("button", { name: /system menu/i }));
		expect(systemMenu).toHaveBeenCalledTimes(1);
	});

	it("anchors the menu to the icon, not the pointer", async () => {
		await renderFor("win32");
		fireEvent.click(screen.getByRole("button", { name: /system menu/i }));
		// jsdom lays nothing out, so the numbers are zeroes - what matters is that
		// a position derived from the element is sent at all, rather than none.
		expect(systemMenu).toHaveBeenCalledWith(
			expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) })
		);
	});

	it("leaves the drag region, or it could not be clicked", async () => {
		await renderFor("win32");
		const icon = screen.getByRole("button", { name: /system menu/i });
		expect(appRegion(icon)).toBe("no-drag");
	});
});

describe("app icon elsewhere", () => {
	it("stays a drag region on macOS and is not a control", async () => {
		await renderFor("darwin");
		expect(screen.queryByRole("button", { name: /system menu/i })).not.toBeInTheDocument();
		const icon = screen.getByAltText("Vayu").parentElement!;
		expect(appRegion(icon)).toBe("drag");
	});

	it("does not pop a menu on Linux", async () => {
		await renderFor("linux");
		const icon = screen.getByAltText("Vayu").parentElement!;
		fireEvent.click(icon);
		fireEvent.contextMenu(icon);
		expect(systemMenu).not.toHaveBeenCalled();
	});
});
