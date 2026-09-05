/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Put the window on screen, even when the first frame never arrives (#1347).
 *
 * The window is created with `show: false` and revealed from `ready-to-show`,
 * which is what keeps a user from watching an unpainted rectangle fill in.
 * Chromium emits that event once the renderer has produced a first frame for
 * this window, so it is a promise about compositing, not about loading - and
 * where compositing never gets going, nothing else in the app notices. The
 * main process finishes `whenReady`, the engine listens, MCP listens, the
 * renderer mounts and issues its prefetches, and the app then sits there
 * looking healthy with nothing on screen and nothing in the log.
 *
 * Measured on this repository's own `ubuntu-latest` runner under `xvfb-run`
 * with no window manager: one launch in five reached `ready-to-show` (743 ms)
 * and four produced no frame for the remaining 89 seconds of the launch
 * budget. Intermittent on identical code, so it is a race in getting the first
 * frame out of a hidden window, not a capability the environment lacks - a
 * window manager, started and waited for, changed nothing. The plain
 * `BrowserWindow` in `scripts/perf/startup-harness.cjs` has never failed in
 * the same session, and the one thing it does not do is come up hidden.
 *
 * So the wait is bounded. A window that is visible and briefly unpainted is a
 * worse first second than `ready-to-show` buys, and a better app than one that
 * never appears; the warning is what turns a silent hang into something a log
 * can be read for. `ready-to-show` still reveals the window on every ordinary
 * launch - the fallback is dead code on a desktop.
 *
 * Kept out of `main.ts` so it can be tested: main.ts creates windows and
 * starts the engine at import time, which no unit test can do - the same
 * reason `startup-probe.ts` and `window-navigation.ts` sit beside it.
 */

/**
 * How long a first frame gets before the window is shown regardless.
 *
 * Long enough that no ordinary launch reaches it - the runners that do paint
 * report 743 ms (Linux), 773 ms (Windows) and 2281 ms (macOS) from process
 * creation, and this timer starts after the window exists - and short enough
 * that a user meets it as a slow start rather than as a dead app.
 */
export const REVEAL_FALLBACK_MS = 8_000;

/**
 * Which of the two paths put the window on screen.
 *
 * It travels with the startup measurement (`startup-probe.ts`), because a
 * launch revealed by the fallback waited out this timer instead of painting
 * and is not a cold-start figure.
 */
export type RevealReason = "ready-to-show" | "reveal-fallback";

/** The slice of `BrowserWindow` this needs, so a test can hand it a double. */
export interface RevealableWindow {
	once(event: "ready-to-show", listener: () => void): void;
	isDestroyed(): boolean;
	show(): void;
}

export interface RevealDeps {
	/** Defaults to `REVEAL_FALLBACK_MS`. */
	fallbackMs?: number;
	/** Timer for the fallback, injected so a test need not wait it out. */
	after?: (ms: number, fn: () => void) => void;
	/** Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

/**
 * Show `window` as soon as it has a frame, or once `fallbackMs` has passed
 * without one, whichever comes first. `onRevealed` runs after the show, once,
 * with the path that got there.
 */
export function revealWhenReady(
	window: RevealableWindow,
	onRevealed: (reason: RevealReason) => void,
	deps: RevealDeps = {}
): void {
	const fallbackMs = deps.fallbackMs ?? REVEAL_FALLBACK_MS;
	const after = deps.after ?? ((ms: number, fn: () => void) => void setTimeout(fn, ms));
	const warn = deps.warn ?? ((message: string) => console.warn(message));

	// Both paths stay armed - the event can still fire after the fallback, and
	// the timer cannot be cleared through the slice of BrowserWindow this takes
	// - so the second one to arrive has to find the window already revealed.
	let revealed = false;

	function reveal(reason: RevealReason): void {
		if (revealed) return;
		revealed = true;

		// The window can be gone before either path lands: on macOS the app
		// outlives its window, and a launch closed inside the fallback window
		// leaves this timer holding a destroyed one. Showing it would throw
		// inside a timer callback, which in the main process is a crash.
		if (window.isDestroyed()) return;

		if (reason === "reveal-fallback") {
			warn(
				`[Main] No first frame after ${fallbackMs}ms - showing the window anyway. ` +
					"Its renderer is running; something in this display environment is not " +
					"compositing it (seen under a bare X server with no window manager). " +
					"The window may be blank until it paints. See issue #1347."
			);
		}

		window.show();
		onRevealed(reason);
	}

	window.once("ready-to-show", () => reveal("ready-to-show"));
	after(fallbackMs, () => reveal("reveal-fallback"));
}
