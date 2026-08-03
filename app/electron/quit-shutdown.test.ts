/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The engine and the MCP server must be stopped once, and the app must still
 * exit.
 *
 * Both halves are load-bearing and they pull against each other. The guard used
 * to be "is the engine still running", state that clears only after the awaits,
 * so a `before-quit` landing mid-shutdown ran a second `stopMcp()`/`stopEngine()`
 * on top of the first - reachable with no second gesture, because an X click
 * closes the window and `window-all-closed` fires a quit into the shutdown a
 * prior quit already began. Make the guard latch instead and the opposite
 * failure appears: the shutdown's own resumed quit gets deferred by the latch
 * and the app never exits.
 *
 * Driven through a fake transport rather than Electron, which is the whole
 * reason this lives outside main.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createQuitShutdown, type QuitShutdownTransport } from "./quit-shutdown";

/** A quit event, plus the children and the deferred quit main would have had. */
function fakeTransport(options: { hasWork?: boolean } = {}) {
	const { hasWork = true } = options;
	let releaseStop: (() => void) | null = null;
	const stop = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				releaseStop = resolve;
			})
	);
	const quit = vi.fn();
	const deferred: Array<() => void> = [];

	const transport: QuitShutdownTransport = {
		hasWork: () => hasWork,
		stop,
		quit,
		defer: (run) => {
			deferred.push(run);
		},
	};

	return {
		transport,
		stop,
		quit,
		/** The children finished stopping. */
		finishStop: async () => {
			releaseStop?.();
			// Let the `finally` that marks the shutdown done run.
			await Promise.resolve();
			await Promise.resolve();
		},
		/** `setImmediate` fired. */
		runDeferred: () => deferred.splice(0).forEach((run) => run()),
	};
}

function quitEvent() {
	return { preventDefault: vi.fn() };
}

describe("createQuitShutdown", () => {
	it("defers the first quit and stops the children", () => {
		const fake = fakeTransport();
		const shutdown = createQuitShutdown(fake.transport);

		const event = quitEvent();
		shutdown.handleQuit(event);

		expect(event.preventDefault).toHaveBeenCalledOnce();
		expect(fake.stop).toHaveBeenCalledOnce();
		expect(shutdown.hasStopped()).toBe(false);
	});

	it("does not start a second shutdown for a quit that lands mid-shutdown", async () => {
		const fake = fakeTransport();
		const shutdown = createQuitShutdown(fake.transport);

		shutdown.handleQuit(quitEvent());

		// The X-click path: window-all-closed fires app.quit() while the first
		// shutdown is still awaiting its children.
		const second = quitEvent();
		shutdown.handleQuit(second);

		expect(fake.stop).toHaveBeenCalledOnce();
		// Held, not let through - exiting here would leave an adopted engine up.
		expect(second.preventDefault).toHaveBeenCalledOnce();
		expect(fake.quit).not.toHaveBeenCalled();

		await fake.finishStop();
		fake.runDeferred();
		expect(fake.quit).toHaveBeenCalledOnce();
	});

	it("lets the quit it resumes through, so the app actually exits", async () => {
		const fake = fakeTransport();
		const shutdown = createQuitShutdown(fake.transport);

		shutdown.handleQuit(quitEvent());
		await fake.finishStop();
		expect(shutdown.hasStopped()).toBe(true);

		const resumed = quitEvent();
		shutdown.handleQuit(resumed);
		expect(resumed.preventDefault).not.toHaveBeenCalled();
		expect(fake.stop).toHaveBeenCalledOnce();
	});

	it("falls through, without latching, when there is nothing to stop yet", () => {
		let hasWork = false;
		const stop = vi.fn().mockResolvedValue(undefined);
		const shutdown = createQuitShutdown({
			hasWork: () => hasWork,
			stop,
			quit: vi.fn(),
			defer: () => {},
		});

		const early = quitEvent();
		shutdown.handleQuit(early);

		expect(early.preventDefault).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();

		// The engine finished coming up after that quit was let through. A later
		// quit must still stop it rather than read a latch set while it was down.
		hasWork = true;
		const later = quitEvent();
		shutdown.handleQuit(later);

		expect(later.preventDefault).toHaveBeenCalledOnce();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("still quits when stopping the children throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const stop = vi.fn().mockRejectedValue(new Error("engine wedged"));
		const quit = vi.fn();
		const deferred: Array<() => void> = [];
		const shutdown = createQuitShutdown({
			hasWork: () => true,
			stop,
			quit,
			defer: (run) => {
				deferred.push(run);
			},
		});

		shutdown.handleQuit(quitEvent());
		await Promise.resolve();
		await Promise.resolve();
		deferred.splice(0).forEach((run) => run());

		expect(quit).toHaveBeenCalledOnce();
		expect(shutdown.hasStopped()).toBe(true);
	});
});

describe("main.ts wiring", () => {
	// main.ts creates windows and starts the engine at import time, so the wiring
	// itself can only be read. Everything above this line would still pass with
	// main.ts calling the old inline shutdown, which is the bug being fixed.
	const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

	it("reads a non-empty main.ts", () => {
		expect(main.length).toBeGreaterThan(1000);
	});

	it("routes before-quit's second pass through the coordinator", () => {
		expect(main).toContain("createQuitShutdown(");
		expect(main).toContain("quitShutdown.handleQuit(event)");
		// The old guard, which re-entered its own in-flight shutdown.
		expect(main).not.toContain(
			"if ((engineSidecar && engineSidecar.isRunning()) || mcpService)"
		);
	});

	it("takes the single-instance lock and focuses the window a second launch wanted", () => {
		expect(main).toContain("app.requestSingleInstanceLock()");
		expect(main).toContain('app.on("second-instance"');
		expect(main).toMatch(/second-instance[\s\S]{0,400}mainWindow\.focus\(\)/);
	});

	it("shuts the engine down for good on quit rather than merely stopping it", () => {
		expect(main).toContain("engineSidecar.shutdown()");
	});
});
