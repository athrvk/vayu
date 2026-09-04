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
/** Post one on purpose, from the settings row, and report what the OS did. */
export const NOTIFY_TEST_CHANNEL = "notify:test";

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

/** The text a test notification carries. Named so the settings row can quote it. */
export const NOTIFY_TEST_TITLE = "Vayu";
export const NOTIFY_TEST_BODY = "System notifications are working. This is what one looks like.";

/**
 * How long to wait for the OS to answer a test before calling it inconclusive.
 *
 * Every platform Vayu ships on emits `show` or `failed` for a posted
 * notification, and both arrive immediately - this exists only so a platform
 * that emits neither leaves the button spinning forever instead of answering.
 */
export const NOTIFY_TEST_TIMEOUT_MS = 4000;

/** The slice of Electron's `Notification` this needs, so a test can pass a fake. */
export interface NotificationLike {
	on(event: "click" | "failed" | "show", listener: () => void): unknown;
	show(): void;
}

export interface NotifyDeps {
	/**
	 * Build one. Mirrors `new Notification(options)`.
	 *
	 * `icon` is the app's own icon, and which platform needs it differs. macOS
	 * ignores it and draws the bundle's icon itself. Windows falls back to the
	 * Start Menu shortcut's icon for the matching AppUserModelID, so it is
	 * already right and this only makes it explicit. Linux is the one that
	 * needs it: libnotify draws whatever the notification carries, and a
	 * notification carrying nothing gets a generic placeholder or no icon at
	 * all.
	 */
	create: (options: { title: string; body: string; icon?: string }) => NotificationLike;
	/** Absolute path to the app icon, or undefined where it cannot be resolved. */
	iconPath?: string;
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
	/** Run `fn` after `ms`. Injected so a test can fire or withhold the timeout. */
	after?: (ms: number, fn: () => void) => void;
}

export interface Notifier {
	show(request: NotifyRequest): NotifyOutcome;
	availability(): NotifyAvailability;
	/**
	 * Post one because the user asked to see one, and answer with what the OS
	 * actually did rather than with what was attempted.
	 *
	 * This is the only path that ignores the focus check, and it has to: the
	 * user is looking at the settings panel when they press the button, which is
	 * precisely the state every other notification is suppressed in. It ignores
	 * the opt-in for the same reason - a test is how someone decides whether to
	 * turn the setting on.
	 *
	 * Async, unlike `show`, because the answer is the point. macOS refuses a
	 * bundle it does not authorize through a `failed` event that arrives after
	 * the call returns, so a synchronous "sent" would be the one thing a test
	 * button must never say.
	 */
	test(): Promise<NotifyOutcome>;
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
	const after = deps.after ?? ((ms, fn) => setTimeout(fn, ms));

	/** Latch the refusal, once, whichever notification brought it. */
	function markUnavailable(): void {
		if (unavailableReason !== null) return;
		unavailableReason = NOTIFY_UNAVAILABLE_REASON;
		console.warn(`[notify] ${NOTIFY_UNAVAILABLE_REASON}; falling back to in-app toasts`);
	}

	/**
	 * Build one and wire what every notification needs, whatever posted it: a
	 * click brings the window back and tells the renderer what it was about, and
	 * a refusal latches. One definition, so the test path cannot drift into
	 * handling a refusal differently from the real ones.
	 */
	function build(
		request: NotifyRequest,
		hooks?: { onFailed?: () => void; onShow?: () => void }
	): NotificationLike {
		const notification = deps.create({
			title: request.title,
			body: request.body,
			icon: deps.iconPath,
		});
		notification.on("click", () => {
			deps.focus();
			deps.send(NOTIFY_ACTIVATED_CHANNEL, {
				kind: request.kind,
				target: request.target,
			});
		});
		// One listener per event, composed here rather than registered twice by
		// the caller: `Notification` is an emitter and would run both, but the
		// latch is this module's business either way and only one place should
		// decide the order.
		notification.on("failed", () => {
			markUnavailable();
			hooks?.onFailed?.();
		});
		if (hooks?.onShow) notification.on("show", hooks.onShow);
		return notification;
	}

	/** The gates every path shares. `null` when there is nothing in the way. */
	function blocked(): NotifyOutcome | null {
		if (unavailableReason !== null) return "unavailable";
		if (!deps.isSupported()) return "unsupported";
		if (!deps.hasWindow()) return "no-window";
		return null;
	}

	function show(request: NotifyRequest): NotifyOutcome {
		const stopped = blocked();
		if (stopped) return stopped;
		// The rule the issue states: a user watching the dashboard is told once,
		// by the toast, not twice.
		if (deps.isFocused()) return "focused";

		build(request).show();
		return "shown";
	}

	function test(): Promise<NotifyOutcome> {
		const stopped = blocked();
		if (stopped) return Promise.resolve(stopped);

		return new Promise<NotifyOutcome>((resolve) => {
			let settled = false;
			const settle = (outcome: NotifyOutcome) => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};

			const notification = build(
				{
					kind: "test",
					title: NOTIFY_TEST_TITLE,
					body: NOTIFY_TEST_BODY,
					target: { view: "settings" },
				},
				{
					onFailed: () => settle("unavailable"),
					onShow: () => settle("shown"),
				}
			);
			// A platform that answers neither way must not leave the button
			// spinning. `shown` here means "posted, and nothing refused it" - which
			// is what the settings row's wording promises, no more.
			after(NOTIFY_TEST_TIMEOUT_MS, () => settle("shown"));
			notification.show();
		});
	}

	return {
		show,
		test,
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
	ipc.handle(NOTIFY_TEST_CHANNEL, () => notifier.test());
}
