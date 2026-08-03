/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A crashed or frozen renderer has to end up somewhere other than "force-quit
 * and lose your edits".
 *
 * Three things are worth pinning and none of them are visible from the window:
 * the reload happens, the reload is bounded (an unguarded one loops forever on
 * content that crashes deterministically), and the close path stops waiting for
 * an ACK from a process that no longer exists.
 *
 * These drive the recovery through a fake transport rather than Electron, which
 * is the whole reason it lives outside main.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	createRendererRecovery,
	decideCrashAction,
	CRASH_WINDOW_MS,
	MAX_RELOADS_PER_WINDOW,
	type RendererRecoveryTransport,
} from "./renderer-recovery";
import { createSaveFlusher, FLUSH_TIMEOUT_MS } from "./save-flush";

// main.ts creates windows and starts the engine at import time, so the wiring
// itself can only be read.
const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

beforeEach(() => {
	// The module logs every crash, which is the point of it - just not on stderr
	// in the middle of a test run.
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A window that reloads, prompts and relaunches on command. */
function fakeTransport(
	answers: {
		crashLoop?: "relaunch" | "quit";
		unresponsive?: "wait" | "reload";
	} = {}
) {
	let clock = 1_000;
	/** Resolvers for prompts still on screen, so a test can answer them late. */
	let answerUnresponsive: ((choice: "wait" | "reload") => void) | null = null;

	const transport: RendererRecoveryTransport = {
		now: () => clock,
		reload: vi.fn(),
		promptCrashLoop: vi.fn(() => Promise.resolve(answers.crashLoop ?? "quit")),
		promptUnresponsive: vi.fn(
			() =>
				new Promise<"wait" | "reload">((resolve) => {
					answerUnresponsive = resolve;
					if (answers.unresponsive) resolve(answers.unresponsive);
				})
		),
		relaunch: vi.fn(),
		quit: vi.fn(),
		onRecovered: vi.fn(),
	};

	return {
		transport,
		advance: (ms: number) => {
			clock += ms;
		},
		/** Answer a dialog the test left open, and let the .then() run. */
		answer: async (choice: "wait" | "reload") => {
			answerUnresponsive?.(choice);
			await Promise.resolve();
			await Promise.resolve();
		},
		/** Let a prompt's already-resolved promise settle. */
		settle: async () => {
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

const CRASHED = { reason: "crashed", exitCode: 133 };

describe("the crash-loop guard", () => {
	it("reloads the first crash and the second, and asks on the third", () => {
		// An unguarded reload is an infinite loop: content that crashes the
		// renderer crashes it again on the way back.
		const at = [0];
		expect(decideCrashAction(at, 0)).toBe("reload");
		expect(decideCrashAction([0, 1], 1)).toBe("reload");
		expect(decideCrashAction([0, 1, 2], 2)).toBe("prompt");
	});

	it("counts only crashes inside the window, so an old one cannot trip it", () => {
		// Two crashes a day apart is not a loop; the second must still reload.
		const longAgo = 0;
		const now = CRASH_WINDOW_MS * 10;
		expect(decideCrashAction([longAgo, longAgo + 1, now], now)).toBe("reload");
	});

	it("lets exactly MAX_RELOADS_PER_WINDOW crashes through before asking", () => {
		const times = Array.from({ length: MAX_RELOADS_PER_WINDOW }, (_, i) => i);
		expect(decideCrashAction(times, 0)).toBe("reload");
		expect(decideCrashAction([...times, 0], 0)).toBe("prompt");
	});
});

describe("recovering a gone renderer", () => {
	it("reloads the window instead of leaving it frozen", () => {
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);

		recovery.handleRenderProcessGone(CRASHED);

		expect(t.transport.reload).toHaveBeenCalledTimes(1);
		expect(t.transport.promptCrashLoop).not.toHaveBeenCalled();
	});

	it("stops reloading and offers a relaunch once the crashes keep coming", async () => {
		const t = fakeTransport({ crashLoop: "relaunch" });
		const recovery = createRendererRecovery(t.transport);

		recovery.handleRenderProcessGone(CRASHED);
		recovery.handleRenderProcessGone(CRASHED);
		recovery.handleRenderProcessGone(CRASHED);
		await t.settle();

		expect(t.transport.reload).toHaveBeenCalledTimes(MAX_RELOADS_PER_WINDOW);
		expect(t.transport.promptCrashLoop).toHaveBeenCalledTimes(1);
		expect(t.transport.relaunch).toHaveBeenCalledTimes(1);
		expect(t.transport.quit).not.toHaveBeenCalled();
	});

	it("quits when the user declines the relaunch", async () => {
		const t = fakeTransport({ crashLoop: "quit" });
		const recovery = createRendererRecovery(t.transport);

		for (let i = 0; i <= MAX_RELOADS_PER_WINDOW; i++) recovery.handleRenderProcessGone(CRASHED);
		await t.settle();

		expect(t.transport.quit).toHaveBeenCalledTimes(1);
		expect(t.transport.relaunch).not.toHaveBeenCalled();
	});

	it("reloads again once the crashes have aged out of the window", () => {
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);

		for (let i = 0; i < MAX_RELOADS_PER_WINDOW; i++) recovery.handleRenderProcessGone(CRASHED);
		t.advance(CRASH_WINDOW_MS + 1);
		recovery.handleRenderProcessGone(CRASHED);

		expect(t.transport.reload).toHaveBeenCalledTimes(MAX_RELOADS_PER_WINDOW + 1);
		expect(t.transport.promptCrashLoop).not.toHaveBeenCalled();
	});

	it("does not reload a renderer that exited cleanly - that is a teardown", () => {
		// `clean-exit` accompanies the window going away on purpose. Reloading
		// there races the teardown and can put a window back up on the way out.
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);

		recovery.handleRenderProcessGone({ reason: "clean-exit", exitCode: 0 });

		expect(t.transport.reload).not.toHaveBeenCalled();
		expect(recovery.isRendererGone()).toBe(true);
	});

	it("clears the flush for the renderer that replaces the dead one", () => {
		// The dead renderer's flush settled against nobody. Its replacement has
		// its own unsaved work, so main.ts has to be told to ask again.
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);

		recovery.handleRenderProcessGone(CRASHED);
		expect(recovery.isRendererGone()).toBe(true);

		recovery.noteRendererAlive();

		expect(recovery.isRendererGone()).toBe(false);
		expect(t.transport.onRecovered).toHaveBeenCalledTimes(1);
	});

	it("does not report a recovery for an ordinary load", () => {
		// `did-finish-load` fires on every navigation. Resetting the flush on
		// each one would be a way to skip a flush that was legitimately in
		// flight, which is the data loss save-flush.ts exists to prevent.
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);

		recovery.noteRendererAlive();
		recovery.noteRendererAlive();

		expect(t.transport.onRecovered).not.toHaveBeenCalled();
	});
});

describe("an unresponsive renderer", () => {
	it("offers wait or reload, and reloads when asked", async () => {
		const t = fakeTransport({ unresponsive: "reload" });
		const recovery = createRendererRecovery(t.transport);

		recovery.handleUnresponsive();
		await t.settle();

		expect(t.transport.reload).toHaveBeenCalledTimes(1);
	});

	it("leaves the renderer alone when the user chooses to wait", async () => {
		const t = fakeTransport({ unresponsive: "wait" });
		const recovery = createRendererRecovery(t.transport);

		recovery.handleUnresponsive();
		await t.settle();

		expect(t.transport.reload).not.toHaveBeenCalled();
	});

	it("ignores a reload answered after the renderer has caught up", async () => {
		// Electron has no API to close a message box, so `responsive` invalidates
		// the answer instead. Without that, a dialog the user gets to late
		// reloads a working window and discards the work it just caught up on.
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);

		recovery.handleUnresponsive();
		recovery.handleResponsive();
		await t.answer("reload");

		expect(t.transport.reload).not.toHaveBeenCalled();
	});

	it("does not stack a second dialog while the hang continues", async () => {
		// Electron re-fires `unresponsive` for as long as the renderer is stuck.
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);

		recovery.handleUnresponsive();
		recovery.handleUnresponsive();
		recovery.handleUnresponsive();

		expect(t.transport.promptUnresponsive).toHaveBeenCalledTimes(1);
		await t.answer("wait");
	});

	it("asks again for a fresh hang once the first was answered", async () => {
		const t = fakeTransport({ unresponsive: "wait" });
		const recovery = createRendererRecovery(t.transport);

		recovery.handleUnresponsive();
		await t.settle();
		recovery.handleResponsive();
		recovery.handleUnresponsive();
		await t.settle();

		expect(t.transport.promptUnresponsive).toHaveBeenCalledTimes(2);
	});
});

describe("closing a window whose renderer is gone", () => {
	/** main.ts's flush transport: the same predicate, over a fake renderer. */
	function wire(recovery: ReturnType<typeof createRendererRecovery>) {
		let armedCeiling: (() => void) | null = null;
		const flusher = createSaveFlusher({
			requestFlush: () => {
				if (recovery.isRendererGone()) return false;
				return true; // a live renderer was asked; it has yet to answer
			},
			onFlushed: () => () => {},
			schedule: (listener, ms) => {
				expect(ms).toBe(FLUSH_TIMEOUT_MS);
				armedCeiling = listener;
			},
		});
		return { flusher, fireCeiling: () => armedCeiling?.() };
	}

	it("settles at once rather than waiting out the ceiling", () => {
		// The compounding half of the bug: `webContents.isDestroyed()` stays
		// false for a crashed process, so the close asked a corpse and sat there
		// for the full 2s. Nothing was going to be saved either way.
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);
		const { flusher } = wire(recovery);

		recovery.handleRenderProcessGone(CRASHED);
		const close = vi.fn();
		flusher.flush(close);

		expect(close).toHaveBeenCalledTimes(1);
		expect(flusher.hasSettled()).toBe(true);
	});

	it("still waits for a live renderer - the skip is for the gone one only", () => {
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);
		const { flusher, fireCeiling } = wire(recovery);

		const close = vi.fn();
		flusher.flush(close);
		expect(close).not.toHaveBeenCalled();

		fireCeiling();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("waits again for the renderer that recovered", () => {
		const t = fakeTransport();
		const recovery = createRendererRecovery(t.transport);
		const { flusher } = wire(recovery);

		recovery.handleRenderProcessGone(CRASHED);
		flusher.flush(vi.fn());
		recovery.noteRendererAlive();
		flusher.reset(); // what main.ts's onRecovered does

		const close = vi.fn();
		flusher.flush(close);

		expect(close).not.toHaveBeenCalled();
	});
});

describe("main.ts wiring", () => {
	it("read the real main.ts", () => {
		// A guard that scanned an empty string would pass every assertion below.
		expect(main.length).toBeGreaterThan(1000);
		expect(main).toContain("createRendererRecovery");
	});

	it("subscribes to the events that report a dead or stuck renderer", () => {
		expect(main).toContain('webContents.on("render-process-gone"');
		expect(main).toContain('mainWindow.on("unresponsive"');
		expect(main).toContain('mainWindow.on("responsive"');
		expect(main).toContain('webContents.on("did-finish-load"');
	});

	it("teaches the flush transport that a gone renderer cannot ACK", () => {
		const requestFlush = main.slice(main.indexOf("requestFlush: () => {"));
		expect(requestFlush.slice(0, requestFlush.indexOf("},"))).toContain(
			"rendererRecovery.isRendererGone()"
		);
	});

	it("resets the flush when a renderer replaces a dead one", () => {
		expect(main).toContain("onRecovered: () => saveFlusher.reset()");
	});
});
