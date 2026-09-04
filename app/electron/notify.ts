/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * System notifications for the events that finish while the user is elsewhere
 * (issue #1358).
 *
 * Every other outcome Vayu reports is a toast, which is only ever seen by
 * someone already looking at the window. A thirty-minute load test is the
 * opposite case: the user starts it and switches to their editor, and today
 * they find out it finished by switching back.
 *
 * The split across the process boundary is deliberate. The renderer decides
 * *what* is worth saying - it is the only side that knows a run reached a
 * terminal state, and the only side that can read the opt-in, which lives in a
 * localStorage-backed store main cannot see. This module decides *whether and
 * how*: the window's focus is main's to answer (minimized, behind another app,
 * on another desktop - none of which `document.hasFocus()` distinguishes), and
 * so is the platform's willingness to show anything at all.
 *
 * On macOS that willingness is not a given. Electron 42 moved notifications to
 * `UNNotification`, which authorizes the *bundle*, and the OS reads the
 * bundle's own code signature to decide which one it is authorizing. A
 * Developer ID is not what it wants: ad-hoc is enough, as long as the signature
 * binds `Info.plist` - so the identifier it grants is `io.github.athrvk.vayu`
 * rather than whatever Electron's prebuilt binary was signed as - and the app
 * sits in a normal install location. `install.sh` re-signs what it unpacks
 * (`codesign --force --deep --sign -`), so an installed Vayu satisfies both.
 *
 * Three cases do not, and each arrives as a `failed` event rather than a throw.
 * `pnpm electron:dev` runs `node_modules/electron/dist/Electron.app`, whose
 * linker signature leaves `Info.plist` unbound under the identifier `Electron`,
 * so system notifications cannot be exercised in dev on macOS at all - the
 * settings row calls them unavailable, and it is right. A bundle dragged
 * straight out of the DMG has the same shape, because electron-builder skips
 * signing when it finds no Developer ID. And a user who denies the permission
 * prompt is the third, which is the one the feature has to respect.
 *
 * So the refusal is caught here, latched, and reported to the settings panel -
 * the honest answer for a build that cannot do this, instead of a toggle that
 * silently does nothing. The user still gets the in-app toast that every one of
 * these events already raises, and the latch stops arming on its own once the
 * bundle is one macOS accepts.
 *
 * Kept out of main.ts so it can be tested: main.ts creates windows and starts
 * the engine at import time. The Electron surfaces arrive as arguments for the
 * same reason.
 */

/** Ask for a notification. Answers what became of it. */
export const NOTIFY_SHOW_CHANNEL = "notify:show";
/** Can this build show one at all? Read by the settings row. */
export const NOTIFY_AVAILABILITY_CHANNEL = "notify:availability";
/** A notification was clicked; the renderer navigates to what it was about. */
export const NOTIFY_ACTIVATED_CHANNEL = "notify:activated";

/**
 * Where a click should land. Composed by the renderer, echoed back untouched -
 * main has no opinion about the app's surfaces, and encoding one here would be
 * a second definition of the renderer's own navigation.
 */
export type NotifyTarget = { view: "run"; runId: string } | { view: "settings" } | { view: "app" };

export interface NotifyRequest {
	/** Which event this is, for the renderer's own routing. Echoed on a click. */
	kind: string;
	title: string;
	body: string;
	target: NotifyTarget;
}

/**
 * What became of one request.
 *
 * `focused` is a success, not a failure: the user is looking at the window and
 * the toast already told them. The renderer needs the distinction only for its
 * own tests, and a caller may ignore the answer entirely.
 */
export type NotifyOutcome = "shown" | "focused" | "no-window" | "unsupported" | "unavailable";

export interface NotifyAvailability {
	available: boolean;
	/** Why not, in the words the settings row prints. Null while available. */
	reason: string | null;
}

/** The text the settings row shows once a build has proved it cannot notify. */
export const NOTIFY_UNAVAILABLE_REASON = "System notifications are unavailable on this build";

/** The slice of Electron's `Notification` this needs, so a test can pass a fake. */
export interface NotificationLike {
	on(event: "click" | "failed", listener: () => void): unknown;
	show(): void;
}

export interface NotifyDeps {
	/** Build one. Mirrors `new Notification(options)`. */
	create: (options: { title: string; body: string }) => NotificationLike;
	/** `Notification.isSupported()` - false on a Linux box with no notification daemon. */
	isSupported: () => boolean;
	/**
	 * Is the main window the one the user is looking at? False when there is no
	 * window, which is what `hasWindow` separates.
	 */
	isFocused: () => boolean;
	/** Is there a window at all? A quitting app has none, and says nothing. */
	hasWindow: () => boolean;
	/** Bring the window back - minimized, behind, hidden. */
	focus: () => void;
	/** Push an event to the renderer. A destroyed window is the caller's problem. */
	send: (channel: string, payload: unknown) => void;
}

export interface Notifier {
	show(request: NotifyRequest): NotifyOutcome;
	availability(): NotifyAvailability;
}

/** A target the renderer sent, or `{ view: "app" }` for anything unrecognised. */
function readTarget(value: unknown): NotifyTarget {
	if (!value || typeof value !== "object") return { view: "app" };
	const view = (value as { view?: unknown }).view;
	if (view === "settings") return { view: "settings" };
	if (view === "run") {
		const runId = (value as { runId?: unknown }).runId;
		if (typeof runId === "string" && runId.length > 0) return { view: "run", runId };
	}
	return { view: "app" };
}

/**
 * Read one request off the wire.
 *
 * Throws rather than dropping: a malformed request is a bug in the renderer's
 * call site, and an invoke that rejects says so at the line that made it. A
 * notification the user never sees would not.
 */
export function readNotifyRequest(value: unknown): NotifyRequest {
	if (!value || typeof value !== "object") {
		throw new TypeError("notify: expected a request object");
	}
	const { kind, title, body, target } = value as Record<string, unknown>;
	if (typeof kind !== "string" || kind.length === 0) {
		throw new TypeError("notify: `kind` must be a non-empty string");
	}
	if (typeof title !== "string" || title.length === 0) {
		throw new TypeError("notify: `title` must be a non-empty string");
	}
	if (typeof body !== "string") {
		throw new TypeError("notify: `body` must be a string");
	}
	return { kind, title, body, target: readTarget(target) };
}

export function createNotifier(deps: NotifyDeps): Notifier {
	/*
	 * Latched on the first `failed`, never cleared. The refusal is a property of
	 * the bundle and its permission (see the header), not of one notification, so
	 * retrying it every run would post a stream of failures nobody sees and hide
	 * the one answer the settings row needs.
	 */
	let unavailableReason: string | null = null;

	function show(request: NotifyRequest): NotifyOutcome {
		if (unavailableReason !== null) return "unavailable";
		if (!deps.isSupported()) return "unsupported";
		if (!deps.hasWindow()) return "no-window";
		// The rule the issue states: a user watching the dashboard is told once,
		// by the toast, not twice.
		if (deps.isFocused()) return "focused";

		const notification = deps.create({ title: request.title, body: request.body });
		notification.on("click", () => {
			deps.focus();
			deps.send(NOTIFY_ACTIVATED_CHANNEL, {
				kind: request.kind,
				target: request.target,
			});
		});
		notification.on("failed", () => {
			if (unavailableReason !== null) return;
			unavailableReason = NOTIFY_UNAVAILABLE_REASON;
			console.warn(`[notify] ${NOTIFY_UNAVAILABLE_REASON}; falling back to in-app toasts`);
		});
		notification.show();
		return "shown";
	}

	return {
		show,
		availability(): NotifyAvailability {
			if (unavailableReason !== null) return { available: false, reason: unavailableReason };
			if (!deps.isSupported()) {
				return { available: false, reason: NOTIFY_UNAVAILABLE_REASON };
			}
			return { available: true, reason: null };
		},
	};
}

/** The slice of `ipcMain` the channels need. */
export interface IpcLike {
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

export function registerNotifyIpc(ipc: IpcLike, notifier: Notifier): void {
	ipc.handle(NOTIFY_SHOW_CHANNEL, (_event: unknown, ...args: unknown[]) =>
		notifier.show(readNotifyRequest(args[0]))
	);
	ipc.handle(NOTIFY_AVAILABILITY_CHANNEL, () => notifier.availability());
}
