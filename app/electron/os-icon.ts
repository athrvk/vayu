/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What the app's icon carries, and what its menu offers (issue #1364).
 *
 * The Dock and taskbar icon was inert: it never said a capture had arrived, it
 * never said a run had failed, and right-clicking it offered only what the OS
 * puts there. Each of those is a glance the user does not have to switch
 * windows for, which is the same case the wake lock (#1357), the notifications
 * (#1358) and the taskbar progress bar (#1362) were made for.
 *
 * **The split is `run-progress.ts`'s.** The renderer says *what happened* - a
 * capture landed, a run failed, these are the collections it has been in - and
 * this side says *whether and how*, because both answers are main's:
 *
 * - **Whether**, because the mark is only worth painting when the user is not
 *   looking. The window's focus is main's to answer - minimized, behind another
 *   app, on another desktop, none of which `document.hasFocus()` tells apart -
 *   which is the same reason `notify.ts` asks it here rather than in React.
 * - **How**, because the three platforms have three different surfaces, and
 *   since Electron 44 removed Unity support one of them has none at all.
 *
 * | | macOS | Windows | Linux |
 * |---|---|---|---|
 * | unread captures | `app.setBadgeCount` | `setOverlayIcon`, a drawn count | - |
 * | a failed run | `dock.bounce("critical")` | `setOverlayIcon`, a drawn mark | - |
 * | the icon's menu | `dock.setMenu` | `app.setUserTasks` | - |
 *
 * **Windows has one overlay and two things to say through it.** A failed run
 * wins while it stands, because it is the newer and the more urgent of the two,
 * and the count comes back underneath it when focus clears the failure. macOS
 * has no such contention: the badge is a number and the bounce is an event.
 *
 * Kept out of `main.ts` so it can be tested - `main.ts` creates windows and
 * starts the engine at import time, which no unit test can do - and every
 * Electron surface it needs arrives as an argument for the same reason.
 */

import {
	countOverlayBitmap,
	failedOverlayBitmap,
	overlayCountText,
	OVERLAY_SCALE,
	type Bitmap,
} from "./os-icon-overlay.js";
import { createRendererWatch, type IpcEventLike } from "./renderer-watch.js";

/** What the renderer tells this side about, one way. */
export const OS_ICON_CHANNEL = "icon:signal";

/** What the user picked off the icon, pushed back to the renderer. */
export const OS_ICON_ACTIVATED_CHANNEL = "icon:activated";

/**
 * How many collections the icon's menu offers.
 *
 * Three is what fits above the OS's own entries without the menu becoming a
 * second collection tree - the tree is in the window, and this is the shortcut
 * for the one the user was just in.
 */
export const OS_ICON_MAX_RECENTS = 3;

/**
 * The argument a Jump List task launches Vayu with.
 *
 * Windows tasks are shortcuts to the executable, so the collection has to
 * survive as text on a command line and be read back by whichever process ends
 * up handling it - a cold start reads its own `process.argv`, a warm one gets
 * the launch as `second-instance`. `open-intent.ts` is the one reader.
 */
export const OPEN_COLLECTION_ARG = "--vayu-open-collection=";

/** A collection as the icon's menu needs it: something to show, something to open. */
export interface OsIconCollection {
	id: string;
	name: string;
}

/** What the renderer reports. */
export type OsIconSignal =
	/** A capture arrived. Whether it counts is this side's to say. */
	| { kind: "captured" }
	/** The Inbox is on screen, so the pile has been seen. */
	| { kind: "inboxOpened" }
	/** A load or collection run ended badly. */
	| { kind: "runFailed" }
	/** The collections the user has been in, most recent first. */
	| { kind: "recents"; collections: OsIconCollection[] };

/** What the user picked off the icon's menu. */
export type OsIconActivation = { kind: "newRequest" } | { kind: "collection"; collectionId: string };

/** The slice of `BrowserWindow` the Windows overlay needs. */
export interface OverlayWindowLike {
	setOverlayIcon(overlay: unknown | null, description: string): void;
}

/** The slice of `app.dock` this needs, which exists on macOS alone. */
export interface DockLike {
	setMenu(menu: unknown): void;
	bounce(type: "critical" | "informational"): number;
}

/** One entry of the macOS Dock menu, as `Menu.buildFromTemplate` takes it. */
export interface MenuItemTemplate {
	label: string;
	click: () => void;
}

/** One Windows Jump List task, as `app.setUserTasks` takes it. */
export interface UserTask {
	program: string;
	arguments: string;
	title: string;
	description: string;
}

export interface OsIconDeps {
	/** Defaults to the host's. Injected so all three branches can be tested. */
	platform?: NodeJS.Platform;
	/** Whether the user is looking at the window right now. */
	isFocused: () => boolean;
	/**
	 * The window as it is right now, or null. Read per call rather than
	 * captured: on macOS the app outlives its window, and a captured one would
	 * be painted after it was destroyed.
	 */
	window: () => OverlayWindowLike | null;
	/** `app.dock`, which is undefined off macOS. */
	dock: () => DockLike | null;
	/** `app.setBadgeCount`, the macOS badge. */
	setBadgeCount: (count: number) => void;
	/** `app.setUserTasks`, the Windows Jump List. */
	setUserTasks: (tasks: readonly UserTask[]) => void;
	/** `Menu.buildFromTemplate`, for the Dock menu. */
	buildMenu: (template: readonly MenuItemTemplate[]) => unknown;
	/** `nativeImage.createFromBitmap`, for the Windows overlay. */
	createImage: (bitmap: Bitmap, options: { scaleFactor: number }) => unknown;
	/** Tell the renderer the user picked something off the icon. */
	activate: (activation: OsIconActivation) => void;
	/** The executable a Jump List task launches. Defaults to the running one. */
	execPath?: string;
}

export interface OsIconPainter {
	/** Act on what the renderer reported. */
	apply(signal: OsIconSignal): void;
	/** The window came back to the front. */
	focused(): void;
	/** Take every mark off, because nobody is left to say what they meant. */
	clear(): void;
}

/** What the menu says, in one place, so the three platforms cannot disagree. */
const NEW_REQUEST_LABEL = "New Request";

export function createOsIcon(deps: OsIconDeps): OsIconPainter {
	const platform = deps.platform ?? process.platform;
	const isMac = platform === "darwin";
	const isWindows = platform === "win32";
	/** Electron 44 left Linux with none of these surfaces. See the header. */
	const paints = isMac || isWindows;

	/** Captures that arrived while the user was elsewhere and are still unread. */
	let unread = 0;
	/** A run ended badly while the user was elsewhere, and they have not looked yet. */
	let failed = false;

	function paintMac(): void {
		deps.setBadgeCount(unread);
	}

	function paintWindows(): void {
		const window = deps.window();
		if (!window) return;
		if (failed) {
			window.setOverlayIcon(image(failedOverlayBitmap()), "A run failed");
			return;
		}
		const bitmap = countOverlayBitmap(unread);
		if (!bitmap) {
			window.setOverlayIcon(null, "");
			return;
		}
		window.setOverlayIcon(image(bitmap), `${overlayCountText(unread)} new captures`);
	}

	function image(bitmap: Bitmap): unknown {
		return deps.createImage(bitmap, { scaleFactor: OVERLAY_SCALE });
	}

	function repaint(): void {
		if (isMac) paintMac();
		else if (isWindows) paintWindows();
	}

	function recordCapture(): void {
		// A capture the user watched arrive is not unread. The badge is for the
		// pile that built up while they were somewhere else.
		if (deps.isFocused()) return;
		unread++;
		repaint();
	}

	function recordFailure(): void {
		// The notification (#1358) already told a user who is elsewhere why. This
		// is the mark they come back to, so a user who is already here needs none.
		if (deps.isFocused()) return;
		failed = true;
		repaint();
		// macOS has no persistent icon mark of its own, so the arrival is the
		// signal: one critical bounce, which keeps bouncing until the app is
		// activated and is therefore never asked for twice.
		if (isMac) deps.dock()?.bounce("critical");
	}

	function setRecents(collections: readonly OsIconCollection[]): void {
		const shown = collections.slice(0, OS_ICON_MAX_RECENTS);
		if (isMac) setDockMenu(shown);
		else if (isWindows) setJumpList(shown);
	}

	function setDockMenu(collections: readonly OsIconCollection[]): void {
		const dock = deps.dock();
		if (!dock) return;
		dock.setMenu(
			deps.buildMenu([
				{ label: NEW_REQUEST_LABEL, click: () => deps.activate({ kind: "newRequest" }) },
				...collections.map((collection) => ({
					label: collection.name,
					click: () =>
						deps.activate({ kind: "collection", collectionId: collection.id }),
				})),
			])
		);
	}

	function setJumpList(collections: readonly OsIconCollection[]): void {
		const program = deps.execPath ?? process.execPath;
		deps.setUserTasks([
			{
				program,
				arguments: "",
				title: NEW_REQUEST_LABEL,
				description: "Open Vayu on a new request",
			},
			...collections.map((collection) => ({
				program,
				arguments: `${OPEN_COLLECTION_ARG}${collection.id}`,
				title: collection.name,
				description: `Open the ${collection.name} collection`,
			})),
		]);
	}

	return {
		apply(signal: OsIconSignal): void {
			if (!paints) return;
			switch (signal.kind) {
				case "captured":
					recordCapture();
					return;
				case "inboxOpened":
					unread = 0;
					repaint();
					return;
				case "runFailed":
					recordFailure();
					return;
				case "recents":
					setRecents(signal.collections);
					return;
			}
		},

		focused(): void {
			if (!paints) return;
			// The count is not cleared here: those captures are still unread, and
			// opening the Inbox is what says otherwise. The failure is, because
			// coming back to the window is the whole of what the mark was asking
			// for.
			if (!failed) return;
			failed = false;
			repaint();
		},

		clear(): void {
			if (!paints) return;
			unread = 0;
			failed = false;
			repaint();
		},
	};
}

/** The slice of `ipcMain` this channel needs. */
export interface IpcLike {
	on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
}

function parseCollections(raw: unknown): OsIconCollection[] | null {
	if (!Array.isArray(raw)) return null;
	const collections: OsIconCollection[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) return null;
		const { id, name } = entry as { id?: unknown; name?: unknown };
		if (typeof id !== "string" || typeof name !== "string") return null;
		if (!id) return null;
		collections.push({ id, name });
	}
	return collections;
}

/**
 * Read one signal off the channel, or `null` for anything that is not one.
 *
 * Dropped rather than thrown, the way `run-progress.ts` drops a malformed
 * update: these reach an OS surface that outlives the window, and a mark nothing
 * will come back to clear is worse than a mark that never appeared.
 */
export function parseOsIconSignal(raw: unknown): OsIconSignal | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { kind, collections } = raw as { kind?: unknown; collections?: unknown };
	if (kind === "captured" || kind === "inboxOpened" || kind === "runFailed") return { kind };
	if (kind !== "recents") return null;
	const parsed = parseCollections(collections);
	return parsed ? { kind: "recents", collections: parsed } : null;
}

/**
 * Wire the channel, and take the marks down with the renderer that asked for
 * them.
 *
 * The teardown is not a nicety: a renderer that crashes or reloads never gets to
 * say the Inbox was opened, and without this the Dock keeps a count for captures
 * whose list is gone until the app quits.
 */
export function registerOsIconIpc(ipc: IpcLike, painter: OsIconPainter): void {
	const watchOwner = createRendererWatch(() => painter.clear());

	ipc.on(OS_ICON_CHANNEL, (event: IpcEventLike, ...args: unknown[]) => {
		const signal = parseOsIconSignal(args[0]);
		if (!signal) {
			console.warn("[os-icon] ignored a message that is not a signal", args[0]);
			return;
		}
		watchOwner(event.sender);
		painter.apply(signal);
	});
}
