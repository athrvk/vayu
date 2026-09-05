/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Dock and taskbar icon's marks and menu (#1364).
 *
 * Every case names its platform rather than reading the host's, for the reason
 * `run-progress.test.ts` gives: the three differ, and a test that asserted the
 * runner's own would exercise the Linux branch in CI and a different one on a
 * developer's Mac. Focus is named the same way, because "the user is not
 * looking" is the condition every mark here exists for.
 */

import { describe, it, expect, vi } from "vitest";
import {
	createOsIcon,
	parseOsIconSignal,
	registerOsIconIpc,
	NEW_REQUEST_ARG,
	OPEN_COLLECTION_ARG,
	OS_ICON_CHANNEL,
	OS_ICON_MAX_RECENTS,
	type OsIconActivation,
	type OsIconPainter,
	type UserTask,
} from "./os-icon";
import { countOverlayBitmap, failedOverlayBitmap } from "./os-icon-overlay";
import type { IpcEventLike } from "./renderer-watch";

/** A `setOverlayIcon` call, with the image reduced to something comparable. */
interface OverlayCall {
	image: unknown;
	description: string;
}

function harness(
	platform: NodeJS.Platform,
	options: { focused?: boolean; window?: boolean; dock?: boolean } = {}
) {
	const badges: number[] = [];
	const overlays: OverlayCall[] = [];
	const bounces: string[] = [];
	const menus: unknown[] = [];
	const flashes: boolean[] = [];
	const tasks: UserTask[][] = [];
	const activations: OsIconActivation[] = [];
	let focused = options.focused ?? false;

	const dock = {
		setMenu: (menu: unknown) => menus.push(menu),
		bounce: (type: "critical" | "informational") => {
			bounces.push(type);
			return 1;
		},
	};

	const painter = createOsIcon({
		platform,
		isFocused: () => focused,
		window: () =>
			options.window === false
				? null
				: {
						setOverlayIcon: (image: unknown | null, description: string) =>
							overlays.push({ image, description }),
						flashFrame: (flag: boolean) => flashes.push(flag),
					},
		dock: () => (options.dock === false ? null : dock),
		setBadgeCount: (count) => badges.push(count),
		setUserTasks: (next) => tasks.push([...next]),
		// The template is the assertable part of a Dock menu; Electron's Menu is
		// not, so the fake keeps the template itself as the built object.
		buildMenu: (template) => template,
		// The bitmap is asserted directly rather than through a NativeImage: the
		// pixels are `os-icon-overlay.test.ts`'s subject, and what matters here is
		// *which* of the two images was handed over.
		createImage: (bitmap) => bitmap,
		activate: (activation) => activations.push(activation),
		execPath: "/opt/vayu/vayu",
	});

	return {
		painter,
		badges,
		overlays,
		flashes,
		bounces,
		menus: menus as { label: string; click: () => void }[][],
		tasks,
		activations,
		setFocused(next: boolean) {
			focused = next;
		},
	};
}

describe("createOsIcon - unread inbox captures", () => {
	it("counts a capture that arrived while the user was elsewhere, on macOS", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "captured" });
		os.painter.apply({ kind: "captured" });
		expect(os.badges).toEqual([1, 2]);
	});

	it("draws the count on the Windows overlay", () => {
		const os = harness("win32");
		os.painter.apply({ kind: "captured" });
		os.painter.apply({ kind: "captured" });
		expect(os.overlays).toEqual([
			{ image: countOverlayBitmap(1), description: "1 new captures" },
			{ image: countOverlayBitmap(2), description: "2 new captures" },
		]);
	});

	/*
	 * Mutation check: drop the `isFocused` guard in `recordCapture` and this
	 * reddens - the badge would count captures the user watched arrive.
	 */
	it("does not count a capture the user was looking at", () => {
		for (const platform of ["darwin", "win32"] as const) {
			const os = harness(platform, { focused: true });
			os.painter.apply({ kind: "captured" });
			expect(os.badges, platform).toEqual([]);
			expect(os.overlays, platform).toEqual([]);
		}
	});

	it("clears the count when the Inbox is opened", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "captured" });
		os.painter.apply({ kind: "inboxOpened" });
		expect(os.badges).toEqual([1, 0]);
	});

	/*
	 * Mutation check: clear the count in `focused()` as well and this reddens.
	 * Coming back to the window is not reading the captures - the acceptance
	 * criterion is that the count clears on *opening the Inbox*.
	 */
	it("keeps the count when the window is merely focused again", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "captured" });
		os.setFocused(true);
		os.painter.focused();
		expect(os.badges).toEqual([1]);
	});

	it("takes the Windows overlay off when the count reaches zero", () => {
		const os = harness("win32");
		os.painter.apply({ kind: "captured" });
		os.painter.apply({ kind: "inboxOpened" });
		expect(os.overlays[os.overlays.length - 1]).toEqual({ image: null, description: "" });
	});
});

describe("createOsIcon - a failed run", () => {
	it("marks the Windows overlay and bounces the macOS Dock, once", () => {
		const windows = harness("win32");
		windows.painter.apply({ kind: "runFailed" });
		expect(windows.overlays).toEqual([
			{ image: failedOverlayBitmap(), description: "A run failed" },
		]);
		expect(windows.bounces).toEqual([]);

		const mac = harness("darwin");
		mac.painter.apply({ kind: "runFailed" });
		expect(mac.bounces).toEqual(["critical"]);
	});

	it("says nothing when the user was already watching", () => {
		const os = harness("win32", { focused: true });
		os.painter.apply({ kind: "runFailed" });
		expect(os.overlays).toEqual([]);
		expect(os.bounces).toEqual([]);
	});

	/*
	 * Mutation check: drop the `failed` branch in `paintWindows` and the count
	 * paints over the failure, which is the more urgent of the two.
	 */
	it("wins the one Windows overlay while it stands", () => {
		const os = harness("win32");
		os.painter.apply({ kind: "captured" });
		os.painter.apply({ kind: "runFailed" });
		expect(os.overlays[os.overlays.length - 1].image).toEqual(failedOverlayBitmap());
	});

	it("gives the overlay back to the count when focus clears the failure", () => {
		const os = harness("win32");
		os.painter.apply({ kind: "captured" });
		os.painter.apply({ kind: "runFailed" });
		os.setFocused(true);
		os.painter.focused();
		expect(os.overlays[os.overlays.length - 1].image).toEqual(countOverlayBitmap(1));
	});

	it("repaints nothing on a focus that had no failure to clear", () => {
		const os = harness("win32");
		os.painter.focused();
		expect(os.overlays).toEqual([]);
	});
});

describe("createOsIcon - the icon's menu", () => {
	const collections = [
		{ id: "a", name: "Payments" },
		{ id: "b", name: "Search" },
		{ id: "c", name: "Billing" },
		{ id: "d", name: "Internal" },
	];

	it("offers New Request and the recent collections on the macOS Dock", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "recents", collections });
		expect(os.menus).toHaveLength(1);
		expect(os.menus[0].map((item) => item.label)).toEqual([
			"New Request",
			"Payments",
			"Search",
			"Billing",
		]);
	});

	it("stops at the cap rather than growing a second collection tree", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "recents", collections });
		expect(os.menus[0]).toHaveLength(OS_ICON_MAX_RECENTS + 1);
	});

	it("tells the renderer which collection was picked", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "recents", collections });
		os.menus[0][2].click();
		expect(os.activations).toEqual([{ kind: "collection", collectionId: "b" }]);
	});

	it("tells the renderer about New Request too", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "recents", collections });
		os.menus[0][0].click();
		expect(os.activations).toEqual([{ kind: "newRequest" }]);
	});

	/*
	 * Mutation check: drop the argument and the Jump List task launches Vayu
	 * with nothing to say which collection was picked, which `open-intent.ts`
	 * reads back on the other side.
	 */
	it("carries the collection on the Windows Jump List's command line", () => {
		const os = harness("win32");
		os.painter.apply({ kind: "recents", collections });
		expect(os.tasks).toHaveLength(1);
		expect(os.tasks[0].map((task) => [task.title, task.arguments])).toEqual([
			["New Request", NEW_REQUEST_ARG],
			["Payments", `${OPEN_COLLECTION_ARG}a`],
			["Search", `${OPEN_COLLECTION_ARG}b`],
			["Billing", `${OPEN_COLLECTION_ARG}c`],
		]);
		expect(os.tasks[0][0].program).toBe("/opt/vayu/vayu");
		// Every task takes the executable's own icon; a Jump List of blank rows
		// is what leaving the pair unset looks like.
		expect(os.tasks[0].every((task) => task.iconPath === "/opt/vayu/vayu")).toBe(true);
	});

	it("survives a macOS build with no Dock to hang a menu on", () => {
		const os = harness("darwin", { dock: false });
		expect(() => os.painter.apply({ kind: "recents", collections })).not.toThrow();
		expect(os.menus).toEqual([]);
	});
});

describe("createOsIcon - a run that ended, the quieter cue", () => {
	it("flashes the taskbar button on Windows and Linux", () => {
		for (const platform of ["win32", "linux"] as const) {
			const os = harness(platform);
			os.painter.apply({ kind: "runFinished" });
			expect(os.flashes, platform).toEqual([true]);
		}
	});

	/*
	 * macOS gets the cue too, in its own idiom. Mutation check: send the
	 * critical bounce here instead and this reddens - which matters because
	 * `runFailed` already sends that one, and a user who cannot tell the two
	 * bounces apart learns nothing from either.
	 */
	it("bounces the macOS Dock once, informationally, rather than flashing", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "runFinished" });
		expect(os.bounces).toEqual(["informational"]);
		// `flashFrame` exists on macOS and is deliberately not used: there it
		// bounces until turned off, which is the weight a failure gets.
		expect(os.flashes).toEqual([]);
	});

	it("needs no clear on macOS, because the informational bounce ends itself", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "runFinished" });
		os.setFocused(true);
		os.painter.focused();
		expect(os.bounces).toEqual(["informational"]);
		expect(os.flashes).toEqual([]);
	});

	it("says nothing when the user was already watching", () => {
		const os = harness("win32", { focused: true });
		os.painter.apply({ kind: "runFinished" });
		expect(os.flashes).toEqual([]);
	});

	/*
	 * Mutation check: drop `stopFlashing()` from `focused()` and this reddens -
	 * which on a platform that flashes until told otherwise is a taskbar button
	 * blinking for a run the user has already come back and looked at.
	 */
	it("stops flashing when the window comes back", () => {
		for (const platform of ["win32", "linux"] as const) {
			const os = harness(platform);
			os.painter.apply({ kind: "runFinished" });
			os.setFocused(true);
			os.painter.focused();
			expect(os.flashes, platform).toEqual([true, false]);
		}
	});

	it("does not turn off a flash it never started", () => {
		const os = harness("win32");
		os.painter.focused();
		os.painter.clear();
		expect(os.flashes).toEqual([]);
	});

	it("stops flashing when the renderer that asked goes away", () => {
		const os = harness("linux");
		os.painter.apply({ kind: "runFinished" });
		os.painter.clear();
		expect(os.flashes).toEqual([true, false]);
	});
});

describe("createOsIcon - the platforms with no surface", () => {
	/*
	 * Electron 44 removed Unity launcher support, so Linux has no badge, no
	 * overlay and no icon menu. Calling into a no-op would pass here by
	 * accident on the CI runner's own platform; painting nothing is the claim.
	 */
	it("paints none of the three surfaces Electron 44 took on Linux", () => {
		// `runFinished` is deliberately absent here: it is the one row Linux
		// kept, and it has its own cases above.
		const os = harness("linux");
		os.painter.apply({ kind: "captured" });
		os.painter.apply({ kind: "runFailed" });
		os.painter.apply({ kind: "inboxOpened" });
		os.painter.apply({ kind: "recents", collections: [{ id: "a", name: "Payments" }] });
		os.painter.focused();
		os.painter.clear();
		expect([os.badges, os.overlays, os.bounces, os.menus, os.tasks]).toEqual([
			[],
			[],
			[],
			[],
			[],
		]);
	});

	it("survives having no window on Windows", () => {
		const os = harness("win32", { window: false });
		expect(() => os.painter.apply({ kind: "captured" })).not.toThrow();
		expect(os.overlays).toEqual([]);
	});
});

describe("createOsIcon - clear", () => {
	it("takes both marks off", () => {
		const os = harness("darwin");
		os.painter.apply({ kind: "captured" });
		os.painter.apply({ kind: "runFailed" });
		os.painter.clear();
		expect(os.badges[os.badges.length - 1]).toBe(0);
	});

	it("forgets the failure, so a later focus repaints nothing", () => {
		const os = harness("win32");
		os.painter.apply({ kind: "runFailed" });
		os.painter.clear();
		const after = os.overlays.length;
		os.painter.focused();
		expect(os.overlays).toHaveLength(after);
	});
});

describe("parseOsIconSignal", () => {
	it("reads the four shapes the renderer sends", () => {
		expect(parseOsIconSignal({ kind: "captured" })).toEqual({ kind: "captured" });
		expect(parseOsIconSignal({ kind: "inboxOpened" })).toEqual({ kind: "inboxOpened" });
		expect(parseOsIconSignal({ kind: "runFailed" })).toEqual({ kind: "runFailed" });
		expect(parseOsIconSignal({ kind: "runFinished" })).toEqual({ kind: "runFinished" });
		expect(
			parseOsIconSignal({ kind: "recents", collections: [{ id: "a", name: "A" }] })
		).toEqual({ kind: "recents", collections: [{ id: "a", name: "A" }] });
	});

	it("reads an empty recents list, which is a user who has been nowhere yet", () => {
		expect(parseOsIconSignal({ kind: "recents", collections: [] })).toEqual({
			kind: "recents",
			collections: [],
		});
	});

	it("refuses anything else", () => {
		for (const raw of [
			null,
			undefined,
			"captured",
			42,
			{},
			{ kind: "bounced" },
			{ kind: "recents" },
			{ kind: "recents", collections: "Payments" },
			{ kind: "recents", collections: [{ id: "a" }] },
			{ kind: "recents", collections: [{ id: "", name: "A" }] },
			{ kind: "recents", collections: [{ id: 1, name: "A" }] },
		]) {
			expect(parseOsIconSignal(raw), JSON.stringify(raw) ?? "undefined").toBeNull();
		}
	});
});

describe("registerOsIconIpc", () => {
	function ipcHarness() {
		const applied: unknown[] = [];
		let cleared = 0;
		const painter: OsIconPainter = {
			apply: (signal) => {
				applied.push(signal);
			},
			focused: () => {},
			clear: () => {
				cleared++;
			},
		};
		let listener: ((event: IpcEventLike, ...args: unknown[]) => void) | null = null;
		const ipc = {
			on(channel: string, fn: (event: IpcEventLike, ...args: unknown[]) => void) {
				expect(channel).toBe(OS_ICON_CHANNEL);
				listener = fn;
			},
		};
		registerOsIconIpc(ipc, painter);
		const senderEvents = new Map<string, () => void>();
		const sender = {
			id: 1,
			once: (event: "destroyed", fn: () => void) => senderEvents.set(event, fn),
			on: (event: "did-start-loading", fn: () => void) => senderEvents.set(event, fn),
		};
		return {
			applied,
			cleared: () => cleared,
			send: (payload: unknown) => listener?.({ sender }, payload),
			fire: (event: "destroyed" | "did-start-loading") => senderEvents.get(event)?.(),
		};
	}

	it("applies a signal the renderer sends", () => {
		const ipc = ipcHarness();
		ipc.send({ kind: "captured" });
		expect(ipc.applied).toEqual([{ kind: "captured" }]);
	});

	it("ignores a message that is not a signal, and says so", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ipc = ipcHarness();
		ipc.send({ kind: "elsewhere" });
		expect(ipc.applied).toEqual([]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	/*
	 * Mutation check: drop the `once("destroyed")` watch and a renderer that
	 * crashes leaves a count on the Dock for captures whose list is gone.
	 */
	it("clears when the renderer goes away or reloads", () => {
		for (const event of ["destroyed", "did-start-loading"] as const) {
			const ipc = ipcHarness();
			ipc.send({ kind: "captured" });
			expect(ipc.cleared()).toBe(0);
			ipc.fire(event);
			expect(ipc.cleared(), event).toBe(1);
		}
	});
});
