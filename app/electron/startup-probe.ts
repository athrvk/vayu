/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * How long the real app took to put a window on screen, when something asked.
 *
 * `scripts/perf/startup-harness.cjs` measures a window of its own holding the
 * built renderer, because until #1165 nothing could launch the actual app on a
 * runner: `main.ts` and `sidecar.ts` decide the renderer's source and the
 * engine's location off the same `isDev` flag, so the only setting that loads
 * the built `dist/` also sends the sidecar to `process.resourcesPath`. That
 * path exists in a packaged build and nowhere else, and a missing binary is a
 * plain `Error`, which `startEngine`'s catch turns into a modal box and a quit
 * (`main.ts`) - no window, no `ready-to-show`, no number. So the harness figure
 * covers the renderer's module graph and none of the main process's own work:
 * the import graph it evaluates before `whenReady` (#1145's MCP barrel was the
 * expensive half of it) and the window it then creates.
 *
 * `.github/workflows/perf-measure.yml` now packages the app and launches that,
 * where every one of those paths resolves. This is the line it reads, and it
 * measures what a user waits for: process start to a window on screen. Not the
 * engine handshake, which #1144 deliberately put behind the window.
 *
 * Guarded by `VAYU_MEASURE_STARTUP=1` because a shipped app has no business
 * printing timings: unset - which is every real launch - nothing is written and
 * nothing is measured.
 *
 * Kept out of `main.ts` so it can be tested: main.ts creates windows and starts
 * the engine at import time, which no unit test can do - the same reason
 * `window-navigation.ts` and `quit-shutdown.ts` sit beside it.
 */

import type { RevealReason } from "./window-reveal.js";

/**
 * Must match `PACKAGED_MARKER` in `scripts/perf/measure-app.mjs`, which is the
 * only reader. A rename that missed one end reports every launch as an
 * unavailable startup leg with its timeout reason, not a silent zero.
 */
export const STARTUP_MARKER = "[vayu] startup";

/** The env var that asks for the line. Any value but `1` is treated as unset. */
export const STARTUP_MEASURE_ENV = "VAYU_MEASURE_STARTUP";

/**
 * Where the elapsed time was measured from.
 *
 * `process-creation` is the honest cold-start basis: Electron's
 * `process.getCreationTime()` is when the OS created this process, so the
 * number includes the executable's load and Chromium's bootstrap - everything
 * a user waits through before any JavaScript runs. It returns `null` where the
 * platform cannot answer, and the fallback measures from Node's time origin
 * instead, which starts later and therefore reads low. The basis travels with
 * the number so nobody compares two runs that measured different things.
 */
export type StartupBasis = "process-creation" | "time-origin";

export interface StartupSample {
	readyToShowMs: number;
	basis: StartupBasis;
	/**
	 * Which path put the window on screen. A launch revealed by
	 * `window-reveal.ts`'s fallback waited out a timer instead of painting, so
	 * the number it carries is that timer and not a cold start; the reader
	 * rejects the leg rather than reporting it (#1347).
	 */
	via: RevealReason;
}

/** The clock readings this needs, so a test can hand it fixed ones. */
export interface StartupClock {
	/** Epoch milliseconds now. */
	now(): number;
	/** Milliseconds since this process's Node time origin. */
	elapsedMs(): number;
	/** Epoch milliseconds the OS created this process, or `null` if unknown. */
	processCreatedAt(): number | null;
}

/**
 * `getCreationTime` is Electron's own addition to `process` and is absent under
 * plain Node, where these tests run. Spelled here rather than taken from
 * Electron's ambient augmentation, which this module would otherwise have to
 * import Electron to see.
 */
type ProcessWithCreationTime = NodeJS.Process & {
	getCreationTime?: () => number | null;
};

export const defaultStartupClock: StartupClock = {
	now: () => Date.now(),
	elapsedMs: () => performance.now(),
	processCreatedAt: () => (process as ProcessWithCreationTime).getCreationTime?.() ?? null,
};

/** Time from process start to this call, on the best basis the platform offers. */
export function sampleStartup(
	via: RevealReason,
	clock: StartupClock = defaultStartupClock
): StartupSample {
	const createdAt = clock.processCreatedAt();
	if (createdAt === null) {
		return { readyToShowMs: clock.elapsedMs(), basis: "time-origin", via };
	}
	return { readyToShowMs: clock.now() - createdAt, basis: "process-creation", via };
}

/**
 * Write the startup line if `VAYU_MEASURE_STARTUP=1` asked for it.
 *
 * Returns whether it wrote, so the caller can be tested for wiring; a real
 * caller ignores it.
 */
export function reportStartupIfRequested(
	via: RevealReason,
	env: Record<string, string | undefined> = process.env,
	clock: StartupClock = defaultStartupClock,
	write: (line: string) => void = (line) => void process.stdout.write(`${line}\n`)
): boolean {
	if (env[STARTUP_MEASURE_ENV] !== "1") return false;

	const sample = sampleStartup(via, clock);
	write(`${STARTUP_MARKER} ${JSON.stringify(sample)}`);
	return true;
}
