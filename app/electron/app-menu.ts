/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the application menu comes from on a window that draws no menu bar.
 *
 * `createMenu` in main.ts installs one template on every platform, but the
 * window is frameless (`frame: false`), and a frameless window on Windows and
 * Linux draws no menu bar - so the template's only effect there is its
 * accelerators, and every item without one (Help > Documentation, About, Check
 * for Updates) has no mouse route at all (#1361). The renderer's title-bar icon
 * asks for the menu over `window:appMenu`, and the installed menu is popped
 * where it points.
 *
 * The decision is here rather than in main.ts for the reason context-menu.ts
 * gives: main.ts creates windows and starts the engine at import time, which no
 * unit test can do. `showApplicationMenu` is what main.ts calls, and neither it
 * nor `planAppMenuPopup` names an Electron type - the menu and the window
 * arrive as the slices of them this reads, which a real `Menu` satisfies and a
 * test's fake satisfies too. So "macOS is left alone", "a point from a scaled
 * display is rounded" and "a malformed point falls back to the pointer" are
 * unit tests rather than three platforms of manual clicking.
 */

/** A point in the window's viewport, as the renderer measured it. */
export interface MenuPoint {
	x: number;
	y: number;
}

/** The slice of `BrowserWindow` this reads, so a test can pass a fake. */
export interface PopupWindow {
	isDestroyed(): boolean;
}

/**
 * The slice of Electron's `Menu` this pops.
 *
 * `window` is optional here only so Electron's own `PopupOptions` stays
 * assignable to it: a real `Menu` satisfies this interface, and a fake with a
 * recorded call satisfies it too, which is the whole point.
 */
export interface PoppableMenu {
	popup(options?: { window?: PopupWindow; x?: number; y?: number }): void;
}

/** What main.ts knows when the renderer asks for the menu. */
export interface AppMenuRequest {
	/** `process.platform`. */
	platform: string;
	/** Is there a live window to pop over? */
	hasWindow: boolean;
	/** Did `Menu.getApplicationMenu()` return a menu? */
	hasMenu: boolean;
	/** Whatever arrived over IPC - untrusted, hence `unknown`. */
	position?: unknown;
}

/** The handles main.ts holds when the renderer asks for the menu. */
export interface AppMenuTargets {
	/** `process.platform`. */
	platform: string;
	/** `Menu.getApplicationMenu()` - the menu `createMenu` installed. */
	menu: PoppableMenu | null;
	/** The window to pop over, `null` once it is gone. */
	window: PopupWindow | null;
	/** Whatever arrived over IPC - untrusted, hence `unknown`. */
	position?: unknown;
}

/**
 * Pop the menu at `point` (`null` means at the pointer, Electron's default), or
 * do not pop, and say why. The reason is returned rather than logged so a test
 * names the case instead of asserting on the absence of a call.
 */
export type AppMenuPlan =
	| { pop: true; point: MenuPoint | null }
	| { pop: false; reason: "has-menu-bar" | "no-window" | "no-menu" };

/**
 * A point Electron will accept, or `null`.
 *
 * Rounded because Electron rejects fractional coordinates and the renderer's
 * `getBoundingClientRect` returns them on a scaled display - the same reason
 * the `window:systemMenu` handler rounds. Anything that is not a pair of finite
 * numbers is `null` rather than an error: the menu still opens, at the pointer,
 * which is where a menu with no anchor belongs.
 */
export function menuPoint(position: unknown): MenuPoint | null {
	if (typeof position !== "object" || position === null) return null;
	const { x, y } = position as { x?: unknown; y?: unknown };
	if (typeof x !== "number" || typeof y !== "number") return null;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Whether to pop the application menu for this request, and where.
 *
 * macOS is refused rather than supported: the menu bar there is always on
 * screen, it is the surface the platform's users reach for, and popping a
 * second copy of it under the title bar would be a duplicate of something that
 * is already visible.
 */
export function planAppMenuPopup(request: AppMenuRequest): AppMenuPlan {
	if (request.platform === "darwin") return { pop: false, reason: "has-menu-bar" };
	if (!request.hasWindow) return { pop: false, reason: "no-window" };
	if (!request.hasMenu) return { pop: false, reason: "no-menu" };
	return { pop: true, point: menuPoint(request.position) };
}

/**
 * Pop the installed application menu over the window, if this request should.
 *
 * The one function main.ts calls, and the only place the menu is popped - no
 * template is built here, because the menu handed in is the one the menu bar
 * draws on macOS. Returns the plan it acted on, so a caller or a test can name
 * the case rather than infer it from a call that did not happen.
 */
export function showApplicationMenu(targets: AppMenuTargets): AppMenuPlan {
	const plan = planAppMenuPopup({
		platform: targets.platform,
		hasWindow: !!targets.window && !targets.window.isDestroyed(),
		hasMenu: !!targets.menu,
		position: targets.position,
	});
	if (!plan.pop) return plan;
	// Both handles are non-null: `plan.pop` is exactly what the two checks
	// above established, and the compiler cannot carry that across the call.
	targets.menu?.popup({ window: targets.window ?? undefined, ...(plan.point ?? {}) });
	return plan;
}
