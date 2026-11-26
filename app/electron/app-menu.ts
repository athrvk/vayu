/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the application menu comes from on a window that draws no menu bar.
 *
 * `createMenu` in main.ts installs one template on every platform, but the window is frameless
 * (`frame: false`), and a frameless window on Windows and Linux draws no menu bar: there the
 * template's only effect is its accelerators, and an item without one (Help > Documentation, About,
 * Check for Updates) has no mouse route at all (#1361). The renderer's title-bar icon asks for the
 * menu over `window:appMenu`, and the installed menu pops where it points.
 *
 * Here rather than in main.ts for the reason context-menu.ts gives: main.ts creates windows and
 * starts the engine at import time, which no unit test can do. Neither `showApplicationMenu` (what
 * main.ts calls) nor `planAppMenuPopup` names an Electron type; they take the slices of the menu
 * and window they read, which a real `Menu` and a test fake both satisfy. So "macOS is left alone",
 * "a point from a scaled display is rounded" and "a malformed point falls back to the pointer" are
 * unit tests, not manual clicking on three platforms.
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
 * The slice of Electron's `Menu` this pops. `window` is optional only so Electron's own
 * `PopupOptions` stays assignable: a real `Menu` and a recording fake both satisfy it.
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
 * Pop at `point` (`null` means at the pointer, Electron's default), or do not pop, and say why. The
 * reason is returned, not logged, so a test names the case instead of asserting on a missing call.
 */
export type AppMenuPlan =
	| { pop: true; point: MenuPoint | null }
	| { pop: false; reason: "has-menu-bar" | "no-window" | "no-menu" };

/**
 * A point Electron will accept, or `null`. Rounded because Electron rejects fractional coordinates
 * and `getBoundingClientRect` returns them on a scaled display (the `window:systemMenu` handler
 * rounds for the same reason). Anything but a pair of finite numbers is `null`, not an error: the
 * menu still opens, at the pointer, where a menu with no anchor belongs.
 */
export function menuPoint(position: unknown): MenuPoint | null {
	if (typeof position !== "object" || position === null) return null;
	const { x, y } = position as { x?: unknown; y?: unknown };
	if (typeof x !== "number" || typeof y !== "number") return null;
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x: Math.round(x), y: Math.round(y) };
}

/**
 * Whether to pop the application menu for this request, and where. macOS is refused: its menu bar
 * is always on screen and is the surface its users reach for, so a second copy under the title bar
 * would duplicate something already visible.
 */
export function planAppMenuPopup(request: AppMenuRequest): AppMenuPlan {
	if (request.platform === "darwin") return { pop: false, reason: "has-menu-bar" };
	if (!request.hasWindow) return { pop: false, reason: "no-window" };
	if (!request.hasMenu) return { pop: false, reason: "no-menu" };
	return { pop: true, point: menuPoint(request.position) };
}

/**
 * Pop the installed application menu over the window, if this request should. The only place the
 * menu pops, and no template is built here: the menu handed in is the one the menu bar draws on
 * macOS. Returns the plan it acted on, so a caller or a test names the case rather than infers it
 * from a call that did not happen.
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
