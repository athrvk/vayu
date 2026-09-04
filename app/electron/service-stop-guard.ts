/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Saying what a close is about to stop, before it stops it (issue #1363).
 *
 * Everything the Services drawer starts - webhook inboxes, mock servers, mock
 * issuers - lives inside the engine, and the engine dies with the app. On
 * Windows and Linux `window-all-closed` quits, so the X button stops every one
 * of them; on macOS the same click leaves them serving. That split is Electron's
 * default rather than a decision anyone made for Vayu, and the resolution
 * (#1363, option A) keeps it: services are window-scoped, and the close says so
 * when there is something to say.
 *
 * **The renderer says what is running; this side says what that costs.** Only
 * the renderer holds the three lists and the one rule that makes them
 * comparable (a stopped inbox keeps its record, a stopped mock or issuer is
 * gone from the engine's list), so it publishes a snapshot on every change. The
 * dialog's words, the platform rule and the button order are OS surface and
 * stay here - the same split `run-progress.ts` and `notify.ts` use, and the
 * reason no platform detail reaches React.
 *
 * A snapshot rather than a question asked at close time: the round trip
 * `save-flush.ts` runs would put a second ceiling on the one gesture the user
 * is waiting on, and it would read the same TanStack cache this snapshot is
 * already published from - no fresher, strictly slower, and unanswerable in the
 * case that matters most, a renderer that is gone.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

import { createRendererWatch, type IpcEventLike } from "./renderer-watch.js";

export const RUNNING_SERVICES_CHANNEL = "services:running";

/** The three things the Services drawer starts, as the dialog speaks of them. */
export type RunningServiceKind = "inbox" | "mock-server" | "issuer";

/**
 * One service the engine is holding for this window.
 *
 * `name` is what the user recognises it by where the kind has one - a mock
 * server serves a named collection - and null where the port is the only name
 * it has, which is how the drawer lists inboxes and issuers too.
 */
export interface RunningService {
	kind: RunningServiceKind;
	name: string | null;
	port: number;
}

/** The gesture asking, which changes both the wording and the platform rule. */
export type StopGesture = "window-close" | "quit";

/** What the dialog says, split the way Electron's message box takes it. */
export interface ServiceStopPrompt {
	message: string;
	detail: string;
	buttons: [confirm: string, cancel: string];
}

/**
 * Read one snapshot off the channel, or `null` for anything that is not one.
 *
 * A malformed message drops the whole snapshot rather than the bad entry: a
 * half-read list would understate what a close destroys, which is the exact
 * silence this guard exists to break.
 */
export function parseRunningServices(raw: unknown): RunningService[] | null {
	if (!Array.isArray(raw)) return null;
	const services: RunningService[] = [];
	for (const entry of raw) {
		const service = parseRunningService(entry);
		if (!service) return null;
		services.push(service);
	}
	return services;
}

function parseRunningService(raw: unknown): RunningService | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { kind, name, port } = raw as { kind?: unknown; name?: unknown; port?: unknown };
	if (kind !== "inbox" && kind !== "mock-server" && kind !== "issuer") return null;
	if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return null;
	if (name !== null && name !== undefined && typeof name !== "string") return null;
	return { kind, name: typeof name === "string" && name.length > 0 ? name : null, port };
}

/** One service as a phrase the dialog can list: "the mock server for Orders API". */
export function describeRunningService(service: RunningService): string {
	switch (service.kind) {
		case "inbox":
			return `the inbox on port ${service.port}`;
		case "mock-server":
			return service.name
				? `the mock server for ${service.name}, on port ${service.port}`
				: `the mock server on port ${service.port}`;
		case "issuer":
			return `the mock issuer on port ${service.port}`;
	}
}

/**
 * What to put in front of the user, for a snapshot that is known to be
 * non-empty.
 *
 * The count leads and the names follow: the question a user answers is "how
 * much am I about to lose", and a message box's first line is the only part
 * every platform shows at full size.
 */
export function buildStopPrompt(
	gesture: StopGesture,
	services: RunningService[]
): ServiceStopPrompt {
	const verb = gesture === "quit" ? "Quit" : "Close";
	const subject =
		services.length === 1
			? "the service it is running"
			: `the ${services.length} services it is running`;
	const listed = services.map((service) => `• ${describeRunningService(service)}`).join("\n");
	return {
		message: `${verb} Vayu and stop ${subject}?`,
		detail: `${listed}\n\nAnything pointed at them stops getting answers.`,
		buttons: [`${verb} anyway`, "Cancel"],
	};
}

export interface ServiceStopGuardDeps {
	/** Put the prompt in front of the user; resolves true for "Close anyway". */
	ask: (prompt: ServiceStopPrompt) => Promise<boolean>;
	/**
	 * True while no renderer is left to have published a fresh snapshot. Read at
	 * ask time rather than trusted to arrive as a message: a renderer that
	 * crashed never gets to say its services are unreachable, and a dialog
	 * naming them would be asking about a window that is already gone.
	 */
	rendererGone?: () => boolean;
	/** Defaults to the host's. Injected so both branches can be tested. */
	platform?: NodeJS.Platform;
}

export interface ServiceStopGuard {
	/** Take the renderer's latest snapshot of what the engine is holding. */
	publish: (services: RunningService[]) => void;
	/** Drop the snapshot: the renderer that published it is gone or reloading. */
	forget: () => void;
	/** What the last snapshot said, as the prompt would name it. */
	running: () => RunningService[];
	/**
	 * Whether `gesture` may proceed without asking - nothing is running, the
	 * gesture stops nothing on this platform, the user already said yes, or
	 * nobody is at the keyboard to answer.
	 */
	isCleared: (gesture: StopGesture) => boolean;
	/**
	 * Ask, and answer whether the gesture may proceed. A yes latches, so the
	 * quit that a confirmed window-close turns into does not ask a second time;
	 * a no leaves everything as it was, including the snapshot.
	 *
	 * Two gestures landing together (an X on top of a Cmd-Q) share the one
	 * dialog rather than stacking two.
	 */
	confirm: (gesture: StopGesture) => Promise<boolean>;
	/**
	 * The next quit has nobody behind it - a signal, not a gesture. A dialog
	 * there waits for an answer that is never coming, which is a hang rather
	 * than a prompt: `install.sh` replaces a running AppImage that way.
	 */
	markQuitUnattended: () => void;
}

export function createServiceStopGuard(deps: ServiceStopGuardDeps): ServiceStopGuard {
	const platform = deps.platform ?? process.platform;
	const rendererGone = deps.rendererGone ?? (() => false);
	/**
	 * On macOS closing the window hides it and the app keeps serving, so that
	 * click costs nothing and asking about it would be a lie. Quit stops the
	 * services on every platform, macOS included.
	 */
	const closeStopsServices = platform !== "darwin";

	let snapshot: RunningService[] = [];
	let confirmed = false;
	let unattendedQuit = false;
	/** The dialog already in front of the user, joined rather than stacked. */
	let asking: Promise<boolean> | null = null;

	const running = (): RunningService[] => (rendererGone() ? [] : snapshot);

	const isCleared = (gesture: StopGesture): boolean => {
		if (confirmed) return true;
		if (gesture === "quit" && unattendedQuit) return true;
		if (gesture === "window-close" && !closeStopsServices) return true;
		return running().length === 0;
	};

	return {
		publish: (services) => {
			snapshot = services;
		},

		forget: () => {
			snapshot = [];
		},

		running,

		isCleared,

		markQuitUnattended: () => {
			unattendedQuit = true;
		},

		confirm: (gesture) => {
			if (isCleared(gesture)) return Promise.resolve(true);
			if (asking) return asking;
			const prompt = buildStopPrompt(gesture, running());
			asking = deps
				.ask(prompt)
				.then((proceed) => {
					// Latched only on a yes: a cancelled close leaves the window, the
					// renderer and every service exactly as they were, and the next
					// gesture is a fresh question about a snapshot that may have moved.
					if (proceed) confirmed = true;
					return proceed;
				})
				.finally(() => {
					asking = null;
				});
			return asking;
		},
	};
}

/** The slice of `ipcMain` this channel needs. */
export interface IpcLike {
	on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
}

/**
 * Wire the channel, and drop the snapshot with the renderer that published it.
 *
 * The teardown is what keeps the dialog honest: a renderer that reloads or
 * crashes never sends a closing "nothing is running", and without this the next
 * close would name services that died with it.
 */
export function registerRunningServicesIpc(ipc: IpcLike, guard: ServiceStopGuard): void {
	const watchOwner = createRendererWatch(() => guard.forget());

	ipc.on(RUNNING_SERVICES_CHANNEL, (event: IpcEventLike, ...args: unknown[]) => {
		const services = parseRunningServices(args[0]);
		if (!services) {
			console.warn("[service-stop-guard] ignored a message that is not a snapshot", args[0]);
			return;
		}
		watchOwner(event.sender);
		guard.publish(services);
	});
}
