/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A close that stops a listening service has to say so first (issue #1363).
 *
 * The defect was silent and platform-split: on Windows and Linux the X button
 * quits, the quit stops the engine, and every inbox, mock server and mock
 * issuer the user pointed another tool at died with it, with nothing said. On
 * macOS the same click left them serving. These drive the guard through a fake
 * dialog rather than Electron, which is the whole reason it lives outside
 * main.ts.
 *
 * Mutation checks: make `closeStopsServices` true on every platform and the
 * macOS case reddens; drop the `confirmed` latch and the "asks once for the
 * close and the quit it becomes" case reddens; return the snapshot without the
 * `rendererGone` gate and the crashed-renderer case reddens.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	buildStopPrompt,
	createServiceStopGuard,
	describeRunningService,
	holdForConfirmation,
	parseRunningServices,
	registerRunningServicesIpc,
	RUNNING_SERVICES_CHANNEL,
	type IpcLike,
	type RunningService,
	type ServiceStopGuard,
	type ServiceStopPrompt,
} from "./service-stop-guard";

// main.ts creates windows and starts the engine at import time, so the wiring
// itself can only be read. Everything above this line would still pass with the
// close handler's interception deleted, which is precisely the bug being fixed.
const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

const inbox: RunningService = { kind: "inbox", name: null, port: 9880 };
const mock: RunningService = { kind: "mock-server", name: "Orders API", port: 9881 };
const issuer: RunningService = { kind: "issuer", name: null, port: 9882 };

/** The guard plus the dialog it would have shown, for a given platform. */
function fakeGuard(
	options: {
		platform?: NodeJS.Platform;
		answer?: boolean;
		rendererGone?: () => boolean;
	} = {}
) {
	const { platform = "linux", answer = true, rendererGone } = options;
	const prompts: ServiceStopPrompt[] = [];
	let settle: ((proceed: boolean) => void) | null = null;

	const ask = vi.fn((prompt: ServiceStopPrompt) => {
		prompts.push(prompt);
		// Answered on a later tick, the way a real message box is, so a second
		// gesture can land while the first dialog is still up.
		return new Promise<boolean>((resolve) => {
			settle = resolve;
		});
	});

	const guard = createServiceStopGuard({ ask, platform, rendererGone });

	return {
		guard,
		ask,
		prompts,
		/** Answer the dialog that is up, with the configured answer by default. */
		answerDialog: (proceed: boolean = answer) => {
			const resolve = settle;
			settle = null;
			resolve?.(proceed);
		},
	};
}

describe("parseRunningServices", () => {
	it("reads a snapshot of all three kinds", () => {
		expect(parseRunningServices([inbox, mock, issuer])).toEqual([inbox, mock, issuer]);
	});

	it("reads an empty snapshot as nothing running, not as a malformed one", () => {
		expect(parseRunningServices([])).toEqual([]);
	});

	it("drops the whole snapshot when one entry is malformed", () => {
		// A half-read list would understate what the close destroys, which is the
		// silence this guard exists to break.
		expect(parseRunningServices([inbox, { kind: "inbox", port: "9880" }])).toBeNull();
		expect(parseRunningServices([inbox, { kind: "tray", name: null, port: 9880 }])).toBeNull();
		expect(parseRunningServices([{ kind: "inbox", name: null, port: 0 }])).toBeNull();
		expect(parseRunningServices([{ kind: "inbox", name: null, port: 1.5 }])).toBeNull();
	});

	it("refuses anything that is not a list", () => {
		expect(parseRunningServices(null)).toBeNull();
		expect(parseRunningServices({ kind: "inbox", name: null, port: 9880 })).toBeNull();
		expect(parseRunningServices(undefined)).toBeNull();
	});

	it("reads a missing or empty name as no name", () => {
		// The dialog asks `name ? … : …`, so "" would render "the mock server for
		// , on port 9881".
		expect(parseRunningServices([{ kind: "mock-server", port: 9881 }])).toEqual([
			{ kind: "mock-server", name: null, port: 9881 },
		]);
		expect(parseRunningServices([{ kind: "mock-server", name: "", port: 9881 }])).toEqual([
			{ kind: "mock-server", name: null, port: 9881 },
		]);
	});
});

describe("the sentence the dialog says", () => {
	it("names an inbox by its port, which is what the drawer names it by", () => {
		expect(describeRunningService(inbox)).toBe("the inbox on port 9880");
	});

	it("names a mock server by the collection it serves, and its port", () => {
		expect(describeRunningService(mock)).toBe("the mock server for Orders API, on port 9881");
	});

	it("falls back to the port for a mock server with no collection name", () => {
		expect(describeRunningService({ ...mock, name: null })).toBe(
			"the mock server on port 9881"
		);
	});

	it("names an issuer as a mock issuer, not as an OAuth server", () => {
		expect(describeRunningService(issuer)).toBe("the mock issuer on port 9882");
	});

	it("leads with the count and lists what will stop", () => {
		const prompt = buildStopPrompt("window-close", [inbox, mock]);

		expect(prompt.message).toBe("Close Vayu and stop the 2 services it is running?");
		expect(prompt.detail).toContain("• the inbox on port 9880");
		expect(prompt.detail).toContain("• the mock server for Orders API, on port 9881");
		expect(prompt.buttons).toEqual(["Close anyway", "Cancel"]);
	});

	it("says one service in the singular", () => {
		expect(buildStopPrompt("window-close", [inbox]).message).toBe(
			"Close Vayu and stop the service it is running?"
		);
	});

	it("says quit, not close, for a quit", () => {
		const prompt = buildStopPrompt("quit", [inbox]);

		expect(prompt.message).toBe("Quit Vayu and stop the service it is running?");
		expect(prompt.buttons).toEqual(["Quit anyway", "Cancel"]);
	});
});

describe("createServiceStopGuard", () => {
	it("lets a close through untouched when nothing is running", async () => {
		const { guard, ask } = fakeGuard();

		expect(guard.isCleared("window-close")).toBe(true);
		await expect(guard.confirm("window-close")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("asks about a close that would stop a running inbox", async () => {
		const { guard, ask, prompts, answerDialog } = fakeGuard();
		guard.publish([inbox]);

		expect(guard.isCleared("window-close")).toBe(false);
		const proceed = guard.confirm("window-close");
		answerDialog(true);

		await expect(proceed).resolves.toBe(true);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(prompts[0].detail).toContain("the inbox on port 9880");
	});

	it("leaves everything running when the user cancels, and asks again next time", async () => {
		const { guard, ask, answerDialog } = fakeGuard();
		guard.publish([inbox]);

		const first = guard.confirm("window-close");
		answerDialog(false);
		await expect(first).resolves.toBe(false);

		// Nothing was destroyed, so the snapshot still stands and the next X is a
		// fresh question rather than a close that slips through.
		expect(guard.running()).toEqual([inbox]);
		expect(guard.isCleared("window-close")).toBe(false);
		const second = guard.confirm("window-close");
		answerDialog(true);
		await expect(second).resolves.toBe(true);
		expect(ask).toHaveBeenCalledTimes(2);
	});

	it("asks once for the close and the quit it becomes", async () => {
		// On Windows and Linux the confirmed close fires `window-all-closed`,
		// which quits: a second dialog on the way out would be the same question
		// asked of a user who already answered it.
		const { guard, ask, answerDialog } = fakeGuard();
		guard.publish([inbox, mock]);

		const proceed = guard.confirm("window-close");
		answerDialog(true);
		await proceed;

		expect(guard.isCleared("quit")).toBe(true);
		await expect(guard.confirm("quit")).resolves.toBe(true);
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("shares one dialog between two gestures that land together", async () => {
		const { guard, ask, answerDialog } = fakeGuard();
		guard.publish([inbox]);

		const close = guard.confirm("window-close");
		const quit = guard.confirm("quit");
		answerDialog(true);

		await expect(Promise.all([close, quit])).resolves.toEqual([true, true]);
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("does not ask about a close on macOS, where the services keep serving", async () => {
		const { guard, ask } = fakeGuard({ platform: "darwin" });
		guard.publish([inbox]);

		expect(guard.isCleared("window-close")).toBe(true);
		await expect(guard.confirm("window-close")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("asks about a quit on macOS, where they do not", async () => {
		const { guard, ask, prompts, answerDialog } = fakeGuard({ platform: "darwin" });
		guard.publish([inbox]);

		expect(guard.isCleared("quit")).toBe(false);
		const proceed = guard.confirm("quit");
		answerDialog(true);

		await expect(proceed).resolves.toBe(true);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(prompts[0].message).toContain("Quit Vayu");
	});

	it("asks nothing of a quit nobody is behind", async () => {
		// A signal is how install.sh replaces a running AppImage. A dialog there is
		// a hang, not a prompt.
		const { guard, ask } = fakeGuard();
		guard.publish([inbox]);
		guard.markQuitUnattended();

		expect(guard.isCleared("quit")).toBe(true);
		await expect(guard.confirm("quit")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("names nothing once the renderer that published it is gone", async () => {
		// A crashed renderer never sends a closing "nothing is running", and its
		// services died with the window it drove.
		let gone = false;
		const { guard, ask } = fakeGuard({ rendererGone: () => gone });
		guard.publish([inbox]);
		expect(guard.isCleared("window-close")).toBe(false);

		gone = true;

		expect(guard.running()).toEqual([]);
		expect(guard.isCleared("window-close")).toBe(true);
		await expect(guard.confirm("window-close")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("treats a dialog it could not show as a no, not as consent", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const guard = createServiceStopGuard({
			ask: () => Promise.reject(new Error("no window to parent to")),
			platform: "linux",
		});
		guard.publish([inbox]);

		await expect(guard.confirm("window-close")).resolves.toBe(false);
		// Not latched either: the next gesture asks again rather than inheriting a
		// consent nobody gave.
		expect(guard.isCleared("quit")).toBe(false);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("forgets the snapshot when told the renderer went away", () => {
		const { guard } = fakeGuard();
		guard.publish([inbox]);

		guard.forget();

		expect(guard.running()).toEqual([]);
		expect(guard.isCleared("window-close")).toBe(true);
	});

	it("takes the latest snapshot, including the one that says nothing is left", () => {
		const { guard } = fakeGuard();
		guard.publish([inbox, mock]);
		guard.publish([mock]);

		expect(guard.running()).toEqual([mock]);

		guard.publish([]);

		expect(guard.isCleared("window-close")).toBe(true);
	});
});

describe("registerRunningServicesIpc", () => {
	/** The slice of `ipcMain` the channel uses, plus the renderer that sent it. */
	function fakeIpc() {
		const handlers = new Map<
			string,
			(event: { sender: RendererStub }, ...args: unknown[]) => void
		>();
		const ipc: IpcLike = {
			on: (channel, listener) => handlers.set(channel, listener),
		};
		return {
			ipc,
			send: (sender: RendererStub, payload: unknown) =>
				handlers.get(RUNNING_SERVICES_CHANNEL)?.({ sender }, payload),
		};
	}

	class RendererStub {
		id = 1;
		private destroyed: Array<() => void> = [];
		private reloaded: Array<() => void> = [];
		once(_event: "destroyed", listener: () => void) {
			this.destroyed.push(listener);
			return this;
		}
		on(_event: "did-start-loading", listener: () => void) {
			this.reloaded.push(listener);
			return this;
		}
		destroy() {
			for (const listener of this.destroyed) listener();
		}
		reload() {
			for (const listener of this.reloaded) listener();
		}
	}

	function stubGuard(): ServiceStopGuard & { published: RunningService[][] } {
		const published: RunningService[][] = [];
		let snapshot: RunningService[] = [];
		return {
			published,
			publish: (services) => {
				published.push(services);
				snapshot = services;
			},
			forget: () => {
				snapshot = [];
			},
			running: () => snapshot,
			isCleared: () => snapshot.length === 0,
			confirm: () => Promise.resolve(true),
			markQuitUnattended: () => {},
		};
	}

	it("publishes what the renderer sent", () => {
		const guard = stubGuard();
		const { ipc, send } = fakeIpc();
		registerRunningServicesIpc(ipc, guard);

		send(new RendererStub(), [inbox, mock]);

		expect(guard.published).toEqual([[inbox, mock]]);
	});

	it("ignores a message that is not a snapshot rather than clearing one", () => {
		const guard = stubGuard();
		const { ipc, send } = fakeIpc();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerRunningServicesIpc(ipc, guard);
		send(new RendererStub(), [inbox]);

		send(new RendererStub(), "everything");

		expect(guard.running()).toEqual([inbox]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("drops the snapshot with the renderer that published it", () => {
		const guard = stubGuard();
		const { ipc, send } = fakeIpc();
		registerRunningServicesIpc(ipc, guard);
		const renderer = new RendererStub();
		send(renderer, [inbox]);

		renderer.destroy();

		expect(guard.running()).toEqual([]);
	});

	it("drops the snapshot when the renderer reloads, which cannot re-send it", () => {
		const guard = stubGuard();
		const { ipc, send } = fakeIpc();
		registerRunningServicesIpc(ipc, guard);
		const renderer = new RendererStub();
		send(renderer, [inbox]);

		renderer.reload();

		expect(guard.running()).toEqual([]);
	});
});

/*
 * What each of main.ts's two handlers does with the answer. The handlers
 * themselves cannot be imported, so the decision they turn on lives here: a
 * "no" has to do nothing at all, which no source scan can see.
 */
describe("holdForConfirmation", () => {
	/** The close event as far as a handler is concerned. */
	function fakeEvent() {
		return { preventDefault: vi.fn() };
	}

	/** Let the answered dialog's promise chain run out before asserting on it. */
	const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("lets a gesture through untouched when there is nothing to ask about", () => {
		const { guard, ask } = fakeGuard();
		const event = fakeEvent();
		const retry = vi.fn();

		expect(holdForConfirmation(guard, "window-close", event, retry)).toBe(true);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(retry).not.toHaveBeenCalled();
		expect(ask).not.toHaveBeenCalled();
	});

	it("holds the gesture while the dialog is up", () => {
		const { guard, answerDialog } = fakeGuard();
		guard.publish([inbox]);
		const event = fakeEvent();
		const retry = vi.fn();

		expect(holdForConfirmation(guard, "window-close", event, retry)).toBe(false);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();

		answerDialog(true);
		expect(retry).not.toHaveBeenCalled(); // still on the promise's tick
	});

	it("does nothing at all on Cancel - the window stays, the services stay", async () => {
		const { guard, answerDialog } = fakeGuard();
		guard.publish([inbox]);
		const event = fakeEvent();
		const retry = vi.fn();

		holdForConfirmation(guard, "window-close", event, retry);
		answerDialog(false);
		await settled();

		expect(retry).not.toHaveBeenCalled();
		expect(guard.running()).toEqual([inbox]);
	});

	it("retries the gesture on Close anyway, and the retry finds the guard cleared", async () => {
		const { guard, answerDialog } = fakeGuard();
		guard.publish([inbox]);
		const retry = vi.fn();

		holdForConfirmation(guard, "window-close", fakeEvent(), retry);
		answerDialog(true);
		await settled();

		expect(retry).toHaveBeenCalledTimes(1);
		// The second pass through the handler asks nothing and returns true, which
		// is what carries main.ts's close into the save flush.
		const second = fakeEvent();
		expect(holdForConfirmation(guard, "window-close", second, vi.fn())).toBe(true);
		expect(second.preventDefault).not.toHaveBeenCalled();
	});

	it("holds nothing on a quit nobody is behind", () => {
		const { guard, ask } = fakeGuard();
		guard.publish([inbox]);
		guard.markQuitUnattended();
		const event = fakeEvent();

		expect(holdForConfirmation(guard, "quit", event, vi.fn())).toBe(true);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(ask).not.toHaveBeenCalled();
	});
});

describe("main.ts wiring", () => {
	it("read the real main.ts", () => {
		// A guard that scanned an empty string would pass every assertion below.
		expect(main.length).toBeGreaterThan(1000);
		expect(main).toContain('app.on("before-quit"');
	});

	it("asks before the close destroys anything", () => {
		// Ordered: a flush that ran first would have told the renderer its work
		// was ending, and Cancel has to leave everything as it was.
		const closeHandler = main.slice(main.indexOf('.on("close"'));
		const guardCheck = closeHandler.indexOf(
			'holdForConfirmation(serviceStopGuard, "window-close"'
		);
		const flushCheck = closeHandler.indexOf("saveFlusher.hasSettled()");
		expect(guardCheck).toBeGreaterThan(-1);
		expect(flushCheck).toBeGreaterThan(guardCheck);
		// The held close is resumed by closing the window again, which is what
		// takes the confirmed path through the flush.
		expect(closeHandler).toContain("closingWindow.close()");
	});

	it("asks the same question of a quit, before the flush", () => {
		const quitHandler = main.slice(main.indexOf('app.on("before-quit"'));
		const guardCheck = quitHandler.indexOf('holdForConfirmation(serviceStopGuard, "quit"');
		const flushCheck = quitHandler.indexOf("saveFlusher.hasSettled()");
		expect(guardCheck).toBeGreaterThan(-1);
		expect(flushCheck).toBeGreaterThan(guardCheck);
		// Resumed through the same one stable callback every other quit gesture
		// takes, so a confirmed quit is not a second engine shutdown.
		expect(quitHandler).toContain("resumeQuit)");
	});

	it("takes the renderer's snapshot off the channel", () => {
		expect(main).toContain("registerRunningServicesIpc(ipcMain, serviceStopGuard)");
	});

	it("asks nothing of a quit that came from a signal", () => {
		// install.sh replaces a running AppImage with one, and a dialog would hold
		// the upgrade open until someone clicked it.
		const signalWiring = main.slice(main.indexOf("installQuitOnSignal("));
		expect(signalWiring).toContain("serviceStopGuard.markQuitUnattended()");
	});

	it("reads the running list through the renderer's own liveness", () => {
		const guardWiring = main.slice(main.indexOf("createServiceStopGuard("));
		expect(guardWiring).toContain("rendererGone: () => rendererRecovery.isRendererGone()");
	});
});
