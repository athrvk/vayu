/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every edge of the quit / close flow, driven through fakes for the renderer,
 * the two dialogs, the ceiling timer and the deferred resume.
 *
 * The defect behind it (#3335): Keep working on the loss question did nothing,
 * so the flush stayed settled and the services answer stayed latched, and the
 * next quit or close went straight through - no flush, no question - and
 * discarded the very edits the user had just chosen to keep.
 *
 * Mutation checks: make Keep working stay in `confirmingLoss` instead of going
 * to `idle` and "Keep working, then quit again" reddens; drop the ticket check
 * in `settleFlush` and the stale-ACK cases redden; let a quit through on
 * `proceeding` without `servicesCleared` and the macOS joining case reddens.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { transformWithOxc } from "vite";
import {
	createQuitFlow,
	FLUSH_ACK_CHANNEL,
	FLUSH_REQUEST_CHANNEL,
	registerFlushAckIpc,
	type QuitFlow,
} from "./quit-flow";
import {
	buildFlushFailurePrompt,
	FLUSH_TIMEOUT_MS,
	type FlushFailurePrompt,
	type FlushResult,
} from "./save-flush";
import type { IpcLike, StopGesture } from "./service-stop-guard";

const CLEAN: FlushResult = { saved: 1, failed: 0, pending: 0 };
const FAILED: FlushResult = { saved: 0, failed: 1, pending: 0 };

/** A dialog the test answers when it chooses to, the way a message box is. */
function fakeDialog<P>() {
	const asked: P[] = [];
	const answers: Array<(yes: boolean) => void> = [];
	return {
		asked,
		ask: vi.fn((prompt: P) => {
			asked.push(prompt);
			return new Promise<boolean>((resolve) => answers.push(resolve));
		}),
		/** Answer the oldest dialog still open. */
		answer: (yes: boolean) => answers.shift()?.(yes),
	};
}

/** Let answered dialogs' promise chains run out. No timer is involved. */
async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function harness(
	options: {
		/** What each gesture would stop right now. Default: nothing. */
		wouldStop?: Partial<Record<StopGesture, boolean>>;
		hasRenderer?: boolean;
	} = {}
) {
	const wouldStop = { "window-close": false, quit: false, ...options.wouldStop };
	let hasRenderer = options.hasRenderer ?? true;
	const services = fakeDialog<StopGesture>();
	const loss = fakeDialog<FlushFailurePrompt>();
	const requests: number[] = [];
	/** Every ceiling armed, in flush order; a real `setTimeout` is not cancelled either. */
	const ceilings: Array<() => void> = [];
	const deferred: Array<() => void> = [];
	const log = vi.fn();

	const flow: QuitFlow = createQuitFlow({
		services: { wouldStop: (g) => wouldStop[g], confirm: services.ask },
		requestFlush: (flushId) => {
			if (!hasRenderer) return false;
			requests.push(flushId);
			return true;
		},
		schedule: (run, ms) => {
			expect(ms).toBe(FLUSH_TIMEOUT_MS);
			ceilings.push(run);
		},
		defer: (run) => deferred.push(run),
		askLoss: loss.ask,
		log,
	});

	const resumeQuit = vi.fn();
	const closeAgain = vi.fn();
	const event = () => ({ preventDefault: vi.fn() });

	return {
		flow,
		services,
		loss,
		log,
		requests,
		resumeQuit,
		closeAgain,
		wouldStop,
		setRenderer: (alive: boolean) => {
			hasRenderer = alive;
		},
		quit: () => {
			const e = event();
			return { through: flow.gesture("quit", e, resumeQuit), event: e };
		},
		close: () => {
			const e = event();
			return { through: flow.gesture("window-close", e, closeAgain), event: e };
		},
		/** The renderer answers the latest flush request. */
		ack: (result: FlushResult = CLEAN, flushId = requests[requests.length - 1]) =>
			flow.flushed(flushId, result),
		/** The ceiling armed for the latest flush fires. */
		expire: () => ceilings[ceilings.length - 1]?.(),
		/** The ceiling armed for the `n`th flush (from 0) fires. */
		expireFlush: (n: number) => ceilings[n]?.(),
		/** Run what the flow deferred, as the next turn of the event loop would. */
		runDeferred: () => {
			for (const run of deferred.splice(0)) run();
		},
	};
}

describe("a gesture with nothing to ask about", () => {
	it("holds the quit, flushes, and resumes it once the renderer ACKs clean", () => {
		const h = harness();

		const first = h.quit();
		expect(first.through).toBe(false);
		expect(first.event.preventDefault).toHaveBeenCalledTimes(1);
		expect(h.requests).toHaveLength(1);
		expect(h.flow.phase()).toBe("flushing");

		h.ack();
		expect(h.flow.phase()).toBe("proceeding");
		// Not re-entered from inside the handler that held it.
		expect(h.resumeQuit).not.toHaveBeenCalled();
		h.runDeferred();
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);

		// The resumed quit is let through to the shutdown, without a second flush.
		expect(h.quit().through).toBe(true);
		expect(h.requests).toHaveLength(1);
		expect(h.loss.ask).not.toHaveBeenCalled();
	});

	it("proceeds at once when there is no renderer left to ask", () => {
		const h = harness({ hasRenderer: false });

		h.close();

		expect(h.flow.phase()).toBe("proceeding");
		expect(h.loss.ask).not.toHaveBeenCalled();
		h.runDeferred();
		expect(h.closeAgain).toHaveBeenCalledTimes(1);
	});

	it("asks about an unanswered flush when the ceiling fires", () => {
		const h = harness();

		h.quit();
		h.expire();

		expect(h.flow.phase()).toBe("confirmingLoss");
		expect(h.loss.asked).toEqual([buildFlushFailurePrompt("quit", null)]);
	});

	it("does not settle twice when the ACK and the ceiling both land", () => {
		const h = harness();

		h.quit();
		h.ack();
		h.expire();
		h.runDeferred();

		expect(h.flow.phase()).toBe("proceeding");
		expect(h.loss.ask).not.toHaveBeenCalled();
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
	});
});

describe("Keep working returns to idle (#3335)", () => {
	it("Keep working, then quit again: the flush runs again and the question is asked again", async () => {
		const h = harness();

		h.quit();
		h.ack(FAILED);
		h.loss.answer(false); // Keep working
		await settle();

		expect(h.flow.phase()).toBe("idle");
		h.runDeferred();
		expect(h.resumeQuit).not.toHaveBeenCalled();

		const again = h.quit();
		expect(again.through).toBe(false);
		expect(h.requests).toHaveLength(2);
		h.ack(FAILED);
		expect(h.loss.ask).toHaveBeenCalledTimes(2);
	});

	it("Keep working on a close, then close again: flushes and asks again", async () => {
		const h = harness();

		h.close();
		h.ack(FAILED);
		h.loss.answer(false);
		await settle();

		expect(h.close().through).toBe(false);
		expect(h.requests).toHaveLength(2);
		h.ack(FAILED);
		expect(h.loss.asked.map((p) => p.buttons[0])).toEqual(["Close anyway", "Close anyway"]);
	});

	it("Keep working forgets the services answer too", async () => {
		const h = harness({ wouldStop: { quit: true, "window-close": true } });

		h.quit();
		h.services.answer(true);
		await settle();
		h.ack(FAILED);
		h.loss.answer(false);
		await settle();

		h.quit();
		expect(h.flow.phase()).toBe("confirmingServices");
		expect(h.services.ask).toHaveBeenCalledTimes(2);
		expect(h.requests).toHaveLength(1); // the question comes before the flush
	});

	it("Quit anyway proceeds, and the resumed quit asks nothing again", async () => {
		const h = harness();

		h.quit();
		h.ack(FAILED);
		h.loss.answer(true);
		await settle();
		h.runDeferred();

		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
		expect(h.quit().through).toBe(true);
		expect(h.loss.ask).toHaveBeenCalledTimes(1);
	});

	it("a loss question that cannot be shown is Keep working, not consent", async () => {
		const h = harness();
		h.loss.ask.mockImplementationOnce(() => Promise.reject(new Error("no window")));

		h.quit();
		h.ack(FAILED);
		await settle();

		expect(h.flow.phase()).toBe("idle");
		expect(h.log).toHaveBeenCalledWith(expect.stringContaining("could not ask"), {
			error: "Error: no window",
		});
		h.runDeferred();
		expect(h.resumeQuit).not.toHaveBeenCalled();
	});
});

describe("the running-services question", () => {
	it("Cancel returns to idle without flushing, and the next quit asks again", async () => {
		const h = harness({ wouldStop: { quit: true } });

		h.quit();
		expect(h.flow.phase()).toBe("confirmingServices");
		h.services.answer(false);
		await settle();

		expect(h.flow.phase()).toBe("idle");
		expect(h.requests).toHaveLength(0); // the renderer was never told its work was ending
		h.runDeferred();
		expect(h.resumeQuit).not.toHaveBeenCalled();

		h.quit();
		expect(h.services.ask).toHaveBeenCalledTimes(2);
	});

	it("Quit anyway flushes next, then proceeds", async () => {
		const h = harness({ wouldStop: { quit: true } });

		h.quit();
		h.services.answer(true);
		await settle();
		expect(h.flow.phase()).toBe("flushing");

		h.ack();
		h.runDeferred();
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
	});

	it("asks once for a close and the quit it turns into", async () => {
		// Off macOS the confirmed close fires `window-all-closed`, which quits.
		const h = harness({ wouldStop: { quit: true, "window-close": true } });

		h.close();
		h.services.answer(true);
		await settle();
		h.ack();
		h.runDeferred();
		expect(h.closeAgain).toHaveBeenCalledTimes(1);

		expect(h.close().through).toBe(true);
		expect(h.quit().through).toBe(true);
		expect(h.services.ask).toHaveBeenCalledTimes(1);
		expect(h.requests).toHaveLength(1);
	});

	it("shares one question between a close and a quit that land together", async () => {
		const h = harness({ wouldStop: { quit: true, "window-close": true } });

		h.close();
		h.quit();
		h.services.answer(true);
		await settle();
		h.ack();
		h.runDeferred();

		expect(h.services.ask).toHaveBeenCalledTimes(1);
		expect(h.requests).toHaveLength(1);
		expect(h.closeAgain).toHaveBeenCalledTimes(1);
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
	});

	it("asks a quit that joined a macOS close, which asked nothing", async () => {
		// macOS's close stops nothing, so its flow skips the question; the quit
		// that joined it does stop the services, and is asked once the flush is over.
		const h = harness({ wouldStop: { quit: true, "window-close": false } });

		h.close();
		h.quit();
		expect(h.services.ask).not.toHaveBeenCalled();
		h.ack();
		h.runDeferred();
		expect(h.closeAgain).toHaveBeenCalledTimes(1);
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);

		// The resumed quit re-enters, and is held for its own question.
		expect(h.quit().through).toBe(false);
		expect(h.services.asked).toEqual(["quit"]);
		h.services.answer(true);
		await settle();
		h.runDeferred();

		expect(h.resumeQuit).toHaveBeenCalledTimes(2);
		expect(h.quit().through).toBe(true);
		expect(h.requests).toHaveLength(1);
	});

	it("Cancel on that late question returns to idle, so the next quit flushes the live renderer", async () => {
		const h = harness({ wouldStop: { quit: true, "window-close": false } });

		h.close();
		h.ack();
		h.runDeferred();
		h.quit();
		h.services.answer(false);
		await settle();

		expect(h.flow.phase()).toBe("idle");
		h.quit();
		expect(h.services.ask).toHaveBeenCalledTimes(2);
	});
});

describe("gestures that join a flow in flight", () => {
	it("a double Cmd-Q is one flush and one quit to resume", () => {
		const h = harness();

		h.quit();
		h.quit();
		h.ack();
		h.runDeferred();

		expect(h.requests).toHaveLength(1);
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
	});

	it("repeated X clicks queue one close", () => {
		const h = harness();

		h.close();
		h.close();
		h.close();
		h.ack();
		h.runDeferred();

		expect(h.closeAgain).toHaveBeenCalledTimes(1);
	});

	it("an X on top of a quit's flush waits for it rather than closing mid-write", () => {
		const h = harness();

		h.quit();
		const x = h.close();
		expect(x.through).toBe(false);
		expect(h.closeAgain).not.toHaveBeenCalled();

		h.ack();
		h.runDeferred();
		expect(h.requests).toHaveLength(1);
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
		expect(h.closeAgain).toHaveBeenCalledTimes(1);
	});

	it("does not ask a dying renderer again when the quit's window closes", () => {
		const h = harness();

		h.quit();
		h.ack();
		h.runDeferred();

		expect(h.close().through).toBe(true);
		expect(h.requests).toHaveLength(1);
	});
});

describe("an ACK from an earlier flush", () => {
	it("cannot answer a later one", async () => {
		const h = harness();

		h.quit();
		const firstId = h.requests[0];
		h.expire(); // the renderer was slow; the ceiling asked
		h.loss.answer(false);
		await settle();

		h.quit();
		expect(h.flow.phase()).toBe("flushing");
		h.ack(CLEAN, firstId); // the first flush's ACK, late

		expect(h.flow.phase()).toBe("flushing");
		h.runDeferred();
		expect(h.resumeQuit).not.toHaveBeenCalled();

		h.ack(FAILED);
		expect(h.flow.phase()).toBe("confirmingLoss");
	});

	it("cannot be settled by a ceiling armed for an earlier flush", async () => {
		const h = harness();

		h.quit();
		h.ack(FAILED);
		h.loss.answer(false);
		await settle();
		h.quit();

		h.expireFlush(0);

		expect(h.flow.phase()).toBe("flushing");
		expect(h.loss.ask).toHaveBeenCalledTimes(1);
	});

	it("ignores an id that is not a number at all", () => {
		const h = harness();

		h.quit();
		h.flow.flushed(String(h.requests[0]), CLEAN);
		h.flow.flushed(undefined, CLEAN);

		expect(h.flow.phase()).toBe("flushing");
	});
});

describe("a renderer reload resets the flow", () => {
	it("drops the held gesture and the flush, and the next gesture flushes the new renderer", () => {
		const h = harness();

		h.quit();
		const staleId = h.requests[0];
		h.flow.reset();
		expect(h.flow.phase()).toBe("idle");

		h.ack(CLEAN, staleId);
		h.runDeferred();
		expect(h.resumeQuit).not.toHaveBeenCalled();

		h.close();
		expect(h.requests).toHaveLength(2);
	});

	it("ignores a dialog answered after the reset", async () => {
		const h = harness({ wouldStop: { quit: true } });

		h.quit();
		h.flow.reset();
		h.services.answer(true);
		await settle();

		expect(h.flow.phase()).toBe("idle");
		expect(h.requests).toHaveLength(0);
	});

	it("takes a proceeding flow back to idle, for a window created after a macOS close", () => {
		const h = harness();

		h.close();
		h.ack();
		h.runDeferred();
		h.flow.reset();

		expect(h.close().through).toBe(false);
		expect(h.requests).toHaveLength(2);
	});
});

describe("a quit nobody is behind", () => {
	it("asks neither question, and logs what it discarded", () => {
		const h = harness({ wouldStop: { quit: true } });
		h.flow.markQuitUnattended();

		h.quit();
		expect(h.services.ask).not.toHaveBeenCalled();
		h.ack(FAILED);
		h.runDeferred();

		expect(h.loss.ask).not.toHaveBeenCalled();
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
		expect(h.log).toHaveBeenCalledWith(expect.any(String), { result: FAILED });
	});

	it("takes over a services question already on screen", async () => {
		const h = harness({ wouldStop: { quit: true } });

		h.quit(); // a person's Cmd-Q, asked and unanswered
		h.flow.markQuitUnattended();
		h.quit(); // then a signal
		expect(h.flow.phase()).toBe("flushing");

		h.services.answer(false); // a late Cancel no longer holds the quit
		await settle();
		h.ack();
		h.runDeferred();
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
	});

	it("takes over a loss question already on screen", () => {
		const h = harness();

		h.close();
		h.ack(FAILED);
		expect(h.flow.phase()).toBe("confirmingLoss");
		h.flow.markQuitUnattended();
		h.quit();
		h.runDeferred();

		expect(h.flow.phase()).toBe("proceeding");
		expect(h.resumeQuit).toHaveBeenCalledTimes(1);
		expect(h.closeAgain).toHaveBeenCalledTimes(1);
		expect(h.log).toHaveBeenCalledWith(expect.any(String), { result: FAILED });
	});

	it("stays unattended across a Cancel on the window's own close", async () => {
		const h = harness({ wouldStop: { quit: true, "window-close": true } });
		h.flow.markQuitUnattended();

		h.close(); // the X still has someone behind it
		expect(h.services.ask).toHaveBeenCalledTimes(1);
		h.services.answer(false);
		await settle();

		h.quit();
		expect(h.services.ask).toHaveBeenCalledTimes(1);
		expect(h.flow.phase()).toBe("flushing");
	});

	it("logs nothing when the flush it quit on landed clean", () => {
		const h = harness();
		h.flow.markQuitUnattended();

		h.quit();
		h.ack(CLEAN);

		expect(h.log).not.toHaveBeenCalled();
	});

	it("still asks the window's own close about a failed flush", () => {
		const h = harness();
		h.flow.markQuitUnattended();

		h.close();
		h.ack(FAILED);

		expect(h.loss.asked).toEqual([buildFlushFailurePrompt("window-close", FAILED)]);
	});
});

describe("registerFlushAckIpc", () => {
	function fakeIpc() {
		const handlers = new Map<string, (event: never, ...args: unknown[]) => void>();
		const ipc: IpcLike = { on: (channel, listener) => handlers.set(channel, listener) };
		return {
			ipc,
			send: (...args: unknown[]) => handlers.get(FLUSH_ACK_CHANNEL)?.({} as never, ...args),
		};
	}

	it("hands the id and the parsed result to the flow", () => {
		const { ipc, send } = fakeIpc();
		const flushed = vi.fn();
		registerFlushAckIpc(ipc, { flushed }, vi.fn());

		send(7, { saved: 2, failed: 0, pending: 1, reason: "disk-full" });

		expect(flushed).toHaveBeenCalledWith(7, {
			saved: 2,
			failed: 0,
			pending: 1,
			reason: "disk-full",
		});
	});

	it("settles an unreadable report as unknown, and says so", () => {
		const { ipc, send } = fakeIpc();
		const flushed = vi.fn();
		const log = vi.fn();
		registerFlushAckIpc(ipc, { flushed }, log);

		send(7, { saved: "lots" });

		expect(flushed).toHaveBeenCalledWith(7, null);
		expect(log).toHaveBeenCalledTimes(1);
	});
});

/*
 * main.ts creates windows and starts the engine at import time, so its half of
 * the wiring can only be read. Every case above would still pass with a handler
 * that skipped the flow, which is the bug the flow exists to close.
 */
describe("main.ts wiring", () => {
	const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
	const closeHandler = main.slice(main.indexOf('closingWindow.on("close"'));
	const quitHandler = main.slice(main.indexOf('app.on("before-quit"'));

	it("read the real main.ts", () => {
		// A guard that scanned an empty string would pass every assertion below.
		expect(main.length).toBeGreaterThan(1000);
		expect(main).toContain('closingWindow.on("close"');
		expect(main).toContain('app.on("before-quit"');
	});

	it("puts the window's close through the flow, with one stable resume per window", () => {
		expect(closeHandler).toMatch(
			/^closingWindow\.on\("close", \(event\) => \{\s*quitFlow\.gesture\("window-close", event, closeAgain\);\s*\}\);/
		);
	});

	it("puts before-quit through the same flow, and only then into the shutdown", () => {
		const gesture = quitHandler.indexOf('quitFlow.gesture("quit", event, resumeQuit)');
		const shutdown = quitHandler.indexOf("quitShutdown.handleQuit(event)");
		expect(gesture).toBeGreaterThan(-1);
		expect(shutdown).toBeGreaterThan(gesture);
		expect(main).toContain("const resumeQuit = () => app.quit();");
	});

	it("tags each flush request with its id, and takes the ACK through the parser", () => {
		expect(main).toContain("mainWindow.webContents.send(FLUSH_REQUEST_CHANNEL, flushId)");
		expect(main).toContain("registerFlushAckIpc(ipcMain, quitFlow,");
	});

	it("resets the flow for a new window and a replaced renderer", () => {
		const createWindow = main.slice(main.indexOf("function createWindow()"));
		expect(createWindow.slice(0, createWindow.indexOf("loadWindowState("))).toContain(
			"quitFlow.reset()"
		);
		expect(main).toContain("onRecovered: () => quitFlow.reset()");
	});

	it("marks a signal's quit unattended, so no dialog waits on nobody (#1908)", () => {
		const signalWiring = main.slice(main.indexOf("installQuitOnSignal("));
		expect(signalWiring).toContain("quitFlow.markQuitUnattended()");
	});

	it("keeps no second copy of the quit bookkeeping", () => {
		for (const gone of [
			"saveFlusher",
			"flushFailureGate",
			"holdForConfirmation",
			"hasSettled",
			"flushSent",
		]) {
			expect(main).not.toContain(gone);
		}
	});
});

describe("the preload's half of the ACK", () => {
	const preload = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");

	/** Run the real preload against a fake `electron`, as `preload-grant-channel.test.ts` does. */
	async function runPreload() {
		const { code } = await transformWithOxc(preload, "preload.ts", { lang: "ts" });
		let api: { onBeforeQuit: (cb: () => Promise<FlushResult>) => () => void } | undefined;
		const ipcRenderer = {
			send: vi.fn(),
			sendSync: vi.fn(),
			invoke: vi.fn(),
			on: vi.fn(),
			removeListener: vi.fn(),
		};
		const electron = {
			contextBridge: {
				exposeInMainWorld: (_name: string, value: typeof api) => {
					api = value;
				},
			},
			ipcRenderer,
			webFrame: {},
			webUtils: {},
		};
		new Function("require", "process", "window", code)(
			() => electron,
			{ argv: [], platform: "linux" },
			{ addEventListener: () => {} }
		);
		if (!api) throw new Error("the preload exposed nothing");
		return { api, ipcRenderer };
	}

	/** The listener the preload put on the request channel. */
	function requestListener(ipcRenderer: Awaited<ReturnType<typeof runPreload>>["ipcRenderer"]) {
		const call = ipcRenderer.on.mock.calls.find(
			([channel]) => channel === FLUSH_REQUEST_CHANNEL
		);
		if (!call) throw new Error("the preload never listened for a flush request");
		return call[1] as (event: unknown, flushId: unknown) => Promise<void>;
	}

	it("spells both channels the way main does", () => {
		// The preload is CommonJS and cannot import the constants.
		expect(preload.length).toBeGreaterThan(10_000);
		expect(preload).toContain(`ipcRenderer.on("${FLUSH_REQUEST_CHANNEL}", handler)`);
		expect(preload).toContain(`ipcRenderer.send("${FLUSH_ACK_CHANNEL}", flushId, result)`);
	});

	it("echoes the flush id main sent beside the result", async () => {
		const { api, ipcRenderer } = await runPreload();
		api.onBeforeQuit(() => Promise.resolve(CLEAN));

		await requestListener(ipcRenderer)({}, 42);

		expect(ipcRenderer.send).toHaveBeenCalledWith(FLUSH_ACK_CHANNEL, 42, CLEAN);
	});

	it("reports a flush that threw as a failure, still under its id", async () => {
		const { api, ipcRenderer } = await runPreload();
		api.onBeforeQuit(() => Promise.reject(new Error("store gone")));

		await requestListener(ipcRenderer)({}, 43);

		expect(ipcRenderer.send).toHaveBeenCalledWith(FLUSH_ACK_CHANNEL, 43, FAILED);
	});
});
