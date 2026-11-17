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
 * A live run is stopped by the same close, and #3604 is the same silence for
 * it: the X button ended a 30 minute load test with no question.
 *
 * Mutation checks: make `closeQuits` true on every platform and the macOS
 * cases redden; return the snapshot without the `rendererGone` gate and the
 * crashed-renderer case reddens; drop the run from `wouldStop` and "asks
 * about a quit with only a load test live" reddens. Whether an answer carries
 * over to the next gesture is `quit-flow.ts`'s, and is tested there.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	buildStopPrompt,
	createServiceStopGuard,
	describeLiveRun,
	describeRunningService,
	LIVE_RUN_CHANNEL,
	parseLiveRun,
	parseRunningServices,
	registerRunningServicesIpc,
	RUNNING_SERVICES_CHANNEL,
	type IpcLike,
	type LiveRun,
	type RunningService,
	type ServiceStopGuard,
	type ServiceStopPrompt,
} from "./service-stop-guard";
import type { NavigationDetails } from "./renderer-watch";

// main.ts creates windows and starts the engine at import time, so the wiring
// itself can only be read. Everything above this line would still pass with the
// close handler's interception deleted, which is precisely the bug being fixed.
const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(join(here, "main.ts"), "utf8");
const preload = readFileSync(join(here, "preload.ts"), "utf8");

const inbox: RunningService = { kind: "inbox", name: null, port: 9880 };
const mock: RunningService = { kind: "mock-server", name: "Orders API", port: 9881 };
const issuer: RunningService = { kind: "issuer", name: null, port: 9882 };
const loadRun: LiveRun = { kind: "load", label: "GET https://api.example.com/orders" };

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

describe("parseLiveRun", () => {
	it("reads a load test and a collection run", () => {
		expect(parseLiveRun(loadRun)).toEqual({ run: loadRun });
		expect(parseLiveRun({ kind: "collection", label: null })).toEqual({
			run: { kind: "collection", label: null },
		});
	});

	it("reads null as no run live, not as a malformed message", () => {
		expect(parseLiveRun(null)).toEqual({ run: null });
	});

	it("reads a missing or empty label as no label", () => {
		expect(parseLiveRun({ kind: "load" })).toEqual({ run: { kind: "load", label: null } });
		expect(parseLiveRun({ kind: "load", label: "" })).toEqual({
			run: { kind: "load", label: null },
		});
	});

	it("refuses anything that is not a run", () => {
		expect(parseLiveRun(undefined)).toBeNull();
		expect(parseLiveRun("load")).toBeNull();
		expect(parseLiveRun([loadRun])).toBeNull();
		expect(parseLiveRun({ kind: "design", label: null })).toBeNull();
		expect(parseLiveRun({ kind: "load", label: 42 })).toBeNull();
	});
});

describe("the sentence the dialog says", () => {
	it("names a load test by what it is aimed at, and falls back to the kind", () => {
		expect(describeLiveRun(loadRun)).toBe(
			"the load test of GET https://api.example.com/orders"
		);
		expect(describeLiveRun({ kind: "load", label: null })).toBe("the load test");
		expect(describeLiveRun({ kind: "collection", label: null })).toBe("the collection run");
	});

	it("names a run alone, and says how it ends", () => {
		const prompt = buildStopPrompt("window-close", { run: loadRun, services: [] });

		expect(prompt.message).toBe("Close Vayu and stop the load test it is running?");
		expect(prompt.detail).toBe(
			"• the load test of GET https://api.example.com/orders\n\n" +
				"It ends as stopped, with what it has measured so far."
		);
		expect(prompt.buttons).toEqual(["Close anyway", "Cancel"]);
	});

	it("names a run and two services in one question, the run first", () => {
		const prompt = buildStopPrompt("quit", { run: loadRun, services: [inbox, mock] });

		expect(prompt.message).toBe(
			"Quit Vayu and stop the load test and the 2 services it is running?"
		);
		expect(prompt.detail).toBe(
			"• the load test of GET https://api.example.com/orders\n" +
				"• the inbox on port 9880\n" +
				"• the mock server for Orders API, on port 9881\n\n" +
				"The load test ends as stopped, with what it has measured so far. " +
				"Anything pointed at the services stops getting answers."
		);
		expect(prompt.buttons).toEqual(["Quit anyway", "Cancel"]);
	});

	it("says one service in the singular beside a collection run", () => {
		const prompt = buildStopPrompt("quit", {
			run: { kind: "collection", label: null },
			services: [inbox],
		});

		expect(prompt.message).toBe(
			"Quit Vayu and stop the collection run and the service it is running?"
		);
		expect(prompt.detail).toContain("Anything pointed at the service stops getting answers.");
	});

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

	it("names an issuer as a mock OAuth issuer, not as an OAuth server", () => {
		expect(describeRunningService(issuer)).toBe("the mock OAuth issuer on port 9882");
	});

	it("leads with the count and lists what will stop", () => {
		const prompt = buildStopPrompt("window-close", { run: null, services: [inbox, mock] });

		expect(prompt.message).toBe("Close Vayu and stop the 2 services it is running?");
		expect(prompt.detail).toContain("• the inbox on port 9880");
		expect(prompt.detail).toContain("• the mock server for Orders API, on port 9881");
		expect(prompt.buttons).toEqual(["Close anyway", "Cancel"]);
	});

	it("says one service in the singular", () => {
		expect(buildStopPrompt("window-close", { run: null, services: [inbox] }).message).toBe(
			"Close Vayu and stop the service it is running?"
		);
	});

	it("says quit, not close, for a quit", () => {
		const prompt = buildStopPrompt("quit", { run: null, services: [inbox] });

		expect(prompt.message).toBe("Quit Vayu and stop the service it is running?");
		expect(prompt.buttons).toEqual(["Quit anyway", "Cancel"]);
	});
});

describe("createServiceStopGuard", () => {
	it("lets a close through untouched when nothing is running", async () => {
		const { guard, ask } = fakeGuard();

		expect(guard.wouldStop("window-close")).toBe(false);
		await expect(guard.confirm("window-close")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("asks about a close that would stop a running inbox", async () => {
		const { guard, ask, prompts, answerDialog } = fakeGuard();
		guard.publish([inbox]);

		expect(guard.wouldStop("window-close")).toBe(true);
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
		expect(guard.wouldStop("window-close")).toBe(true);
		const second = guard.confirm("window-close");
		answerDialog(true);
		await expect(second).resolves.toBe(true);
		expect(ask).toHaveBeenCalledTimes(2);
	});

	it("does not ask about a close on macOS, where the services keep serving", async () => {
		const { guard, ask } = fakeGuard({ platform: "darwin" });
		guard.publish([inbox]);

		expect(guard.wouldStop("window-close")).toBe(false);
		await expect(guard.confirm("window-close")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("asks about a quit on macOS, where they do not", async () => {
		const { guard, ask, prompts, answerDialog } = fakeGuard({ platform: "darwin" });
		guard.publish([inbox]);

		expect(guard.wouldStop("quit")).toBe(true);
		const proceed = guard.confirm("quit");
		answerDialog(true);

		await expect(proceed).resolves.toBe(true);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(prompts[0].message).toContain("Quit Vayu");
	});

	it("names nothing once the renderer that published it is gone", async () => {
		// A crashed renderer never sends a closing "nothing is running", and its
		// services died with the window it drove.
		let gone = false;
		const { guard, ask } = fakeGuard({ rendererGone: () => gone });
		guard.publish([inbox]);
		expect(guard.wouldStop("window-close")).toBe(true);

		gone = true;

		expect(guard.running()).toEqual([]);
		expect(guard.wouldStop("window-close")).toBe(false);
		await expect(guard.confirm("window-close")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("treats a dialog it could not show as a no, not as consent", async () => {
		const log = vi.fn();
		const guard = createServiceStopGuard({
			ask: () => Promise.reject(new Error("no window to parent to")),
			platform: "linux",
			log,
		});
		guard.publish([inbox]);

		await expect(guard.confirm("window-close")).resolves.toBe(false);
		expect(log).toHaveBeenCalled();
	});

	it("says what a gesture would stop, with no memory of an earlier answer", async () => {
		const { guard, answerDialog } = fakeGuard();
		expect(guard.wouldStop("window-close")).toBe(false);

		guard.publish([inbox]);
		const proceed = guard.confirm("window-close");
		answerDialog(true);
		await proceed;

		expect(guard.wouldStop("window-close")).toBe(true);
		expect(guard.wouldStop("quit")).toBe(true);
	});

	it("says a macOS close stops nothing, and a macOS quit does", () => {
		const { guard } = fakeGuard({ platform: "darwin" });
		guard.publish([inbox]);

		expect(guard.wouldStop("window-close")).toBe(false);
		expect(guard.wouldStop("quit")).toBe(true);
	});

	it("forgets the snapshot when told the renderer went away", () => {
		const { guard } = fakeGuard();
		guard.publish([inbox]);

		guard.forget();

		expect(guard.running()).toEqual([]);
		expect(guard.wouldStop("window-close")).toBe(false);
	});

	it("takes the latest snapshot, including the one that says nothing is left", () => {
		const { guard } = fakeGuard();
		guard.publish([inbox, mock]);
		guard.publish([mock]);

		expect(guard.running()).toEqual([mock]);

		guard.publish([]);

		expect(guard.wouldStop("window-close")).toBe(false);
	});
});

describe("a live run (#3604)", () => {
	it("asks about a quit with only a load test live, and names it", async () => {
		const { guard, prompts, answerDialog } = fakeGuard();
		guard.publishRun(loadRun);

		expect(guard.wouldStop("quit")).toBe(true);
		const proceed = guard.confirm("quit");
		answerDialog(true);

		await expect(proceed).resolves.toBe(true);
		expect(prompts[0].message).toBe("Quit Vayu and stop the load test it is running?");
		expect(prompts[0].detail).toContain("the load test of GET https://api.example.com/orders");
	});

	it.each(["linux", "win32"] as const)("asks about a window close on %s", (platform) => {
		const { guard, ask } = fakeGuard({ platform });
		guard.publishRun(loadRun);

		expect(guard.wouldStop("window-close")).toBe(true);
		void guard.confirm("window-close");
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("does not ask about a window close on macOS, where the run keeps going", async () => {
		const { guard, ask } = fakeGuard({ platform: "darwin" });
		guard.publishRun(loadRun);

		expect(guard.wouldStop("window-close")).toBe(false);
		await expect(guard.confirm("window-close")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
		expect(guard.wouldStop("quit")).toBe(true);
	});

	it("puts a run beside two services in one prompt listing all three", async () => {
		const { guard, ask, prompts, answerDialog } = fakeGuard();
		guard.publish([inbox, mock]);
		guard.publishRun(loadRun);

		const proceed = guard.confirm("window-close");
		answerDialog(true);
		await proceed;

		expect(ask).toHaveBeenCalledTimes(1);
		expect(prompts[0]).toEqual(
			buildStopPrompt("window-close", { run: loadRun, services: [inbox, mock] })
		);
	});

	it("asks nothing once the run is withdrawn", () => {
		const { guard } = fakeGuard();
		guard.publishRun(loadRun);

		guard.publishRun(null);

		expect(guard.liveRun()).toBeNull();
		expect(guard.wouldStop("quit")).toBe(false);
	});

	it("names nothing once the renderer that published it is gone", async () => {
		let gone = false;
		const { guard, ask } = fakeGuard({ rendererGone: () => gone });
		guard.publishRun(loadRun);
		expect(guard.wouldStop("quit")).toBe(true);

		gone = true;

		expect(guard.liveRun()).toBeNull();
		await expect(guard.confirm("quit")).resolves.toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("forgets the run with the services", () => {
		const { guard } = fakeGuard();
		guard.publish([inbox]);
		guard.publishRun(loadRun);

		guard.forget();

		expect(guard.liveRun()).toBeNull();
		expect(guard.wouldStop("quit")).toBe(false);
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
			sendRun: (sender: RendererStub, payload: unknown) =>
				handlers.get(LIVE_RUN_CHANNEL)?.({ sender }, payload),
		};
	}

	class RendererStub {
		id = 1;
		private destroyed: Array<() => void> = [];
		private reloaded: Array<(details: NavigationDetails) => void> = [];
		once(_event: "destroyed", listener: () => void) {
			this.destroyed.push(listener);
			return this;
		}
		on(_event: "did-start-navigation", listener: (details: NavigationDetails) => void) {
			this.reloaded.push(listener);
			return this;
		}
		destroy() {
			for (const listener of this.destroyed) listener();
		}
		reload() {
			for (const listener of this.reloaded) {
				listener({ isMainFrame: true, isSameDocument: false });
			}
		}
	}

	function stubGuard(): ServiceStopGuard & { published: RunningService[][] } {
		const published: RunningService[][] = [];
		let snapshot: RunningService[] = [];
		let run: LiveRun | null = null;
		return {
			published,
			publish: (services) => {
				published.push(services);
				snapshot = services;
			},
			publishRun: (next) => {
				run = next;
			},
			forget: () => {
				snapshot = [];
				run = null;
			},
			running: () => snapshot,
			liveRun: () => run,
			wouldStop: () => snapshot.length > 0 || run !== null,
			confirm: () => Promise.resolve(true),
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
		const log = vi.fn();
		registerRunningServicesIpc(ipc, guard, log);
		send(new RendererStub(), [inbox]);

		send(new RendererStub(), "everything");

		expect(guard.running()).toEqual([inbox]);
		expect(log).toHaveBeenCalled();
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

	it("publishes the run the renderer sent, and its withdrawal", () => {
		const guard = stubGuard();
		const { ipc, sendRun } = fakeIpc();
		registerRunningServicesIpc(ipc, guard);
		const renderer = new RendererStub();

		sendRun(renderer, loadRun);
		expect(guard.liveRun()).toEqual(loadRun);

		sendRun(renderer, null);
		expect(guard.liveRun()).toBeNull();
	});

	it("ignores a run message it cannot read rather than clearing the run", () => {
		const guard = stubGuard();
		const { ipc, sendRun } = fakeIpc();
		const log = vi.fn();
		registerRunningServicesIpc(ipc, guard, log);
		sendRun(new RendererStub(), loadRun);

		sendRun(new RendererStub(), { kind: "everything" });

		expect(guard.liveRun()).toEqual(loadRun);
		expect(log).toHaveBeenCalled();
	});

	it("drops the run and the services with the renderer that published them", () => {
		const guard = stubGuard();
		const { ipc, send, sendRun } = fakeIpc();
		registerRunningServicesIpc(ipc, guard);
		const renderer = new RendererStub();
		send(renderer, [inbox]);
		sendRun(renderer, loadRun);

		renderer.destroy();

		expect(guard.running()).toEqual([]);
		expect(guard.liveRun()).toBeNull();
	});

	it("drops the run when its renderer reloads, even if only the run was published", () => {
		const guard = stubGuard();
		const { ipc, sendRun } = fakeIpc();
		registerRunningServicesIpc(ipc, guard);
		const renderer = new RendererStub();
		sendRun(renderer, loadRun);

		renderer.reload();

		expect(guard.liveRun()).toBeNull();
	});
});

describe("the preload's half of the channels", () => {
	it("spells both channels the way this side does", () => {
		// The preload is CommonJS and cannot import the constants.
		expect(preload.length).toBeGreaterThan(10_000);
		expect(preload).toContain(`ipcRenderer.send("${RUNNING_SERVICES_CHANNEL}", services)`);
		expect(preload).toContain(`ipcRenderer.send("${LIVE_RUN_CHANNEL}", run)`);
	});
});

describe("main.ts wiring", () => {
	it("read the real main.ts", () => {
		// A guard that scanned an empty string would pass every assertion below.
		expect(main.length).toBeGreaterThan(1000);
		expect(main).toContain("createServiceStopGuard(");
	});

	it("takes the renderer's snapshot off the channel", () => {
		expect(main).toContain("registerRunningServicesIpc(ipcMain, serviceStopGuard,");
	});

	it("asks through the quit flow, which both gestures drive", () => {
		const flowWiring = main.slice(main.indexOf("createQuitFlow("));
		expect(flowWiring).toContain("services: serviceStopGuard,");
	});

	it("reads the running list through the renderer's own liveness", () => {
		const guardWiring = main.slice(main.indexOf("createServiceStopGuard("));
		expect(guardWiring).toContain("rendererGone: () => rendererRecovery.isRendererGone()");
	});
});
