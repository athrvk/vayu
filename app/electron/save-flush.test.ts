/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The window must not go away before the renderer has written its edits.
 *
 * The hole this closes was specific: `before-quit` flushed, `close` did not, and
 * `close` is what the X button fires. It destroys the WebContents, nulls the
 * window handle, and only then reaches `before-quit`, where the null check
 * skipped the flush - so everything inside the auto-save delay was lost, and
 * with auto-save turned off, everything since the last manual save.
 *
 * These drive the coordinator through a fake transport rather than Electron,
 * which is the whole reason it lives outside main.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSaveFlusher, FLUSH_TIMEOUT_MS, type FlushTransport } from "./save-flush";

// main.ts creates windows and starts the engine at import time, so the wiring
// itself can only be read. Everything above this line would still pass with the
// `close` handler deleted, which is precisely the bug being fixed.
const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

/** A renderer that ACKs when told to, plus the timer main would have armed. */
function fakeTransport(options: { hasRenderer?: boolean } = {}) {
	const { hasRenderer = true } = options;
	const listeners = new Set<() => void>();
	let timer: { fire: () => void; ms: number } | null = null;

	const transport: FlushTransport = {
		requestFlush: vi.fn(() => hasRenderer),
		onFlushed: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		schedule: (listener, ms) => {
			timer = { fire: listener, ms };
		},
	};

	return {
		transport,
		/** The renderer finished flushing and ACKed. */
		ack: () => [...listeners].forEach((l) => l()),
		/** The fallback timer expired. */
		expire: () => timer?.fire(),
		timeoutMs: () => timer?.ms,
		listenerCount: () => listeners.size,
	};
}

describe("flushing before the window goes away", () => {
	it("asks the renderer and waits - the window does not close first", () => {
		const t = fakeTransport();
		const flusher = createSaveFlusher(t.transport);
		const close = vi.fn();

		flusher.flush(close);

		expect(t.transport.requestFlush).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled(); // the edits are still being written

		t.ack();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("proceeds anyway when the renderer never ACKs, on the 2s ceiling", () => {
		const t = fakeTransport();
		const flusher = createSaveFlusher(t.transport);
		const close = vi.fn();

		flusher.flush(close);
		expect(t.timeoutMs()).toBe(FLUSH_TIMEOUT_MS);
		expect(close).not.toHaveBeenCalled();

		t.expire();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("does not close twice when the ACK and the timeout both land", () => {
		const t = fakeTransport();
		const flusher = createSaveFlusher(t.transport);
		const close = vi.fn();

		flusher.flush(close);
		t.ack();
		t.expire();

		expect(close).toHaveBeenCalledTimes(1);
	});

	it("drops its ACK listener once settled, so a later flush cannot be woken by it", () => {
		const t = fakeTransport();
		const flusher = createSaveFlusher(t.transport);

		flusher.flush(vi.fn());
		expect(t.listenerCount()).toBe(1);
		t.ack();
		expect(t.listenerCount()).toBe(0);
	});

	it("proceeds immediately when there is no renderer left to ask", () => {
		const t = fakeTransport({ hasRenderer: false });
		const flusher = createSaveFlusher(t.transport);
		const close = vi.fn();

		flusher.flush(close);

		expect(close).toHaveBeenCalledTimes(1);
	});
});

describe("the quit path and the close path share one flush", () => {
	it("flushes once - a quit after a close does not ask a dying renderer again", () => {
		const t = fakeTransport();
		const flusher = createSaveFlusher(t.transport);

		// X button: flush, then let the close through.
		flusher.flush(vi.fn());
		t.ack();
		expect(flusher.hasFlushed()).toBe(true);

		// `window-all-closed` -> app.quit() -> before-quit, arriving second.
		const quit = vi.fn();
		flusher.flush(quit);

		expect(t.transport.requestFlush).toHaveBeenCalledTimes(1);
		expect(quit).toHaveBeenCalledTimes(1); // and without waiting out the ceiling
	});

	it("lets the close through untouched once the quit path has flushed", () => {
		const t = fakeTransport();
		const flusher = createSaveFlusher(t.transport);

		flusher.flush(vi.fn()); // Cmd-Q
		t.ack();

		// main.ts's close handler is a no-op in this state, which is what keeps
		// the window from being held open by a second round trip.
		expect(flusher.hasFlushed()).toBe(true);
	});

	it("flushes again for a new window, which has its own unsaved work", () => {
		const t = fakeTransport();
		const flusher = createSaveFlusher(t.transport);

		flusher.flush(vi.fn());
		t.ack();
		flusher.reset(); // createWindow()

		const close = vi.fn();
		flusher.flush(close);

		expect(t.transport.requestFlush).toHaveBeenCalledTimes(2);
		expect(close).not.toHaveBeenCalled();
	});
});

describe("main.ts wiring", () => {
	it("read the real main.ts", () => {
		// A guard that scanned an empty string would pass every assertion below.
		expect(main.length).toBeGreaterThan(1000);
		expect(main).toContain('app.on("before-quit"');
	});

	it("intercepts the window's close and flushes before it destroys the renderer", () => {
		// The defect: `close` fires, the WebContents dies, `mainWindow` is
		// nulled, and only then does `before-quit` run and find nothing to ask.
		expect(main).toMatch(/\.on\("close",\s*\(event\)\s*=>\s*\{/);
		const closeHandler = main.slice(main.indexOf('.on("close"'));
		expect(closeHandler).toContain("event.preventDefault()");
		expect(closeHandler).toContain("saveFlusher.flush");
	});

	it("routes the quit path through the same flusher", () => {
		const quitHandler = main.slice(main.indexOf('app.on("before-quit"'));
		expect(quitHandler).toContain("saveFlusher.hasFlushed()");
		expect(quitHandler).toContain("saveFlusher.flush(() => app.quit())");
	});

	it("clears the flush for a newly created window", () => {
		expect(main).toContain("saveFlusher.reset()");
	});

	it("keeps no second copy of the flush bookkeeping", () => {
		// The `flushSent` flag this replaced lived only in the quit path; a
		// close path that grew its own would reintroduce the double flush.
		expect(main).not.toContain("flushSent");
	});
});
