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
 * when there is something to say. A live run dies the same way, so the same
 * question names it, first (#3604). Restarting the engine stops it too, so
 * Restart asks the same question when a run is live (#3604).
 *
 * **The renderer says what is running; this side says what that costs.** Only
 * the renderer holds the three lists and the one rule that makes them
 * comparable (a stopped inbox keeps its record, a stopped mock or issuer is
 * gone from the engine's list), and only it knows which run it shows live, so
 * it publishes both, each on its own channel, on every change. The
 * dialog's words, the platform rule and the button order are OS surface and
 * stay here - the same split `run-progress.ts` and `notify.ts` use, and the
 * reason no platform detail reaches React.
 *
 * A snapshot rather than a question asked at close time: the round trip
 * `quit-flow.ts` runs would put a second ceiling on the one gesture the user
 * is waiting on, and it would read the same TanStack cache this snapshot is
 * already published from - no fresher, strictly slower, and unanswerable in the
 * case that matters most, a renderer that is gone.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do.
 */

import { createRendererWatch, type IpcEventLike } from "./renderer-watch.js";

export const RUNNING_SERVICES_CHANNEL = "services:running";
/** Carries the run the renderer shows live, or `null` once none is. */
export const LIVE_RUN_CHANNEL = "runs:live";
/** Asked by Restart engine before it does anything; answers whether to go on. */
export const CONFIRM_RESTART_CHANNEL = "engine:confirm-restart";

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

/**
 * The run the app is showing live. The app shows one at a time
 * (`stores/run-gate.ts`), so it is the only one the dialog can name.
 */
export interface LiveRun {
	kind: "load" | "collection";
	/** What the run is aimed at ("GET https://..."), when the renderer knows it. */
	label: string | null;
}

/** Everything a gesture would stop, as the dialog lists it: the run first. */
export interface StopTargets {
	run: LiveRun | null;
	services: RunningService[];
}

/** A gesture that ends the app, which `quit-flow.ts` puts through its flush. */
export type StopGesture = "window-close" | "quit";

/**
 * Every gesture the guard asks for, which changes both the wording and the
 * rule. Restart ends the engine but not the app, so it never reaches the quit
 * flow and its save flush.
 */
export type AskingGesture = StopGesture | "restart";

/** How each gesture is spoken of: the message's opening and the confirm button. */
const GESTURE_WORDS: Record<AskingGesture, { lead: string; confirm: string }> = {
	"window-close": { lead: "Close Vayu", confirm: "Close anyway" },
	quit: { lead: "Quit Vayu", confirm: "Quit anyway" },
	restart: { lead: "Restart Vayu's engine", confirm: "Restart anyway" },
};

const RUN_NOUN: Record<LiveRun["kind"], string> = {
	load: "load test",
	collection: "collection run",
};

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

/**
 * Read one run publication: `{ run: null }` when the renderer says no run is
 * live, or `null` for anything that is not a publication, which is dropped the
 * way a malformed services snapshot is.
 */
export function parseLiveRun(raw: unknown): { run: LiveRun | null } | null {
	if (raw === null) return { run: null };
	if (typeof raw !== "object") return null;
	const { kind, label } = raw as { kind?: unknown; label?: unknown };
	if (kind !== "load" && kind !== "collection") return null;
	if (label !== null && label !== undefined && typeof label !== "string") return null;
	return { run: { kind, label: typeof label === "string" && label.length > 0 ? label : null } };
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
			return `the mock OAuth issuer on port ${service.port}`;
	}
}

/** The run as a phrase the dialog can list: "the load test of GET https://...". */
export function describeLiveRun(run: LiveRun): string {
	const noun = RUN_NOUN[run.kind];
	return run.label ? `the ${noun} of ${run.label}` : `the ${noun}`;
}

/** "the load test and the 2 services it is running" */
function stopSubject({ run, services }: StopTargets): string {
	const named: string[] = [];
	if (run) named.push(`the ${RUN_NOUN[run.kind]}`);
	if (services.length === 1) named.push("the service");
	else if (services.length > 1) named.push(`the ${services.length} services`);
	return `${named.join(" and ")} it is running`;
}

/** What stopping costs, said once per kind of thing stopped. */
function stopConsequence({ run, services }: StopTargets): string {
	if (!run) return "Anything pointed at them stops getting answers.";
	const runEnds = "ends as stopped, with what it has measured so far.";
	if (services.length === 0) return `It ${runEnds}`;
	const theServices = services.length === 1 ? "the service" : "the services";
	return `The ${RUN_NOUN[run.kind]} ${runEnds} Anything pointed at ${theServices} stops getting answers.`;
}

/**
 * What to put in front of the user, for targets known to hold something.
 *
 * The count leads and the names follow: the question a user answers is "how
 * much am I about to lose", and a message box's first line is the only part
 * every platform shows at full size. The run is listed first because it is the
 * one thing here that cannot be started again where it left off.
 */
export function buildStopPrompt(gesture: AskingGesture, targets: StopTargets): ServiceStopPrompt {
	const { lead, confirm } = GESTURE_WORDS[gesture];
	const listed = [
		...(targets.run ? [describeLiveRun(targets.run)] : []),
		...targets.services.map(describeRunningService),
	]
		.map((phrase) => `• ${phrase}`)
		.join("\n");
	return {
		message: `${lead} and stop ${stopSubject(targets)}?`,
		detail: `${listed}\n\n${stopConsequence(targets)}`,
		buttons: [confirm, "Cancel"],
	};
}

export interface ServiceStopGuardDeps {
	/** Put the prompt in front of the user; resolves true for "Close anyway". */
	ask: (prompt: ServiceStopPrompt) => Promise<boolean>;
	/**
	 * True while no renderer is left to have published a fresh snapshot. Read at
	 * ask time rather than trusted to arrive as a message: a renderer that
	 * crashed never gets to say its services and its run are unreachable, and a
	 * dialog naming them would be asking about a window that is already gone.
	 */
	rendererGone?: () => boolean;
	/** Defaults to the host's. Injected so both branches can be tested. */
	platform?: NodeJS.Platform;
	/** Where an unanswerable question is reported. Category `"ipc"`. Defaults to a no-op. */
	log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface ServiceStopGuard {
	/** Take the renderer's latest snapshot of what the engine is holding. */
	publish: (services: RunningService[]) => void;
	/** Take the run the renderer shows live, or `null` once it has none. */
	publishRun: (run: LiveRun | null) => void;
	/** Drop both publications: the renderer that sent them is gone or reloading. */
	forget: () => void;
	/** What the last snapshot said, as the prompt would name it. */
	running: () => RunningService[];
	/** The last run published, as the prompt would name it. */
	liveRun: () => LiveRun | null;
	/** Whether `gesture` would stop something running right now, on this platform. */
	wouldStop: (gesture: AskingGesture) => boolean;
	/**
	 * Ask, and answer whether the gesture may proceed. A no, or a dialog that
	 * could not be shown, is `false`; the promise never rejects. Whether an
	 * answer still counts for the next gesture is `quit-flow.ts`'s to decide.
	 */
	confirm: (gesture: AskingGesture) => Promise<boolean>;
}

export function createServiceStopGuard(deps: ServiceStopGuardDeps): ServiceStopGuard {
	const platform = deps.platform ?? process.platform;
	const rendererGone = deps.rendererGone ?? (() => false);
	const log = deps.log ?? (() => {});
	/**
	 * On macOS closing the window hides it and the app keeps serving and
	 * running, so that click costs nothing and asking about it would be a lie.
	 * Quit stops everything on every platform, macOS included.
	 */
	const closeQuits = platform !== "darwin";

	let snapshot: RunningService[] = [];
	let run: LiveRun | null = null;

	const running = (): RunningService[] => (rendererGone() ? [] : snapshot);
	const liveRun = (): LiveRun | null => (rendererGone() ? null : run);
	const targets = (): StopTargets => ({ run: liveRun(), services: running() });

	const wouldStop = (gesture: AskingGesture): boolean => {
		if (gesture === "window-close" && !closeQuits) return false;
		const now = targets();
		// A restart that stops only services does not ask: a toast names what
		// stopped afterwards (#3493). It stops a run on every platform, so the
		// macOS close rule does not apply either.
		if (gesture === "restart") return now.run !== null;
		return now.run !== null || now.services.length > 0;
	};

	return {
		publish: (services) => {
			snapshot = services;
		},

		publishRun: (next) => {
			run = next;
		},

		forget: () => {
			snapshot = [];
			run = null;
		},

		running,

		liveRun,

		wouldStop,

		confirm: (gesture) => {
			if (!wouldStop(gesture)) return Promise.resolve(true);
			return deps.ask(buildStopPrompt(gesture, targets())).catch((error: unknown) => {
				// A question that could not be asked is not a yes. In the case that
				// actually raises this - a window destroyed while its own dialog was
				// up - the close already happened and the answer is moot; in any
				// other, refusing to stop the user's run or services on an error is
				// the safe half, and a signal still quits without asking at all.
				log("service-stop-guard: could not ask about what the gesture would stop", {
					error: String(error),
				});
				return false;
			});
		},
	};
}

/** The slice of `ipcMain` this channel needs. */
export interface IpcLike {
	on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
}

/**
 * Wire both channels, and drop what they carried with the renderer that sent it.
 *
 * The teardown is what keeps the dialog honest: a renderer that reloads or
 * crashes never sends a closing "nothing is running", and without this the next
 * close would name services and a run that died with it. One watch for both
 * channels, so either one's sender going takes both publications with it.
 */
export function registerRunningServicesIpc(
	ipc: IpcLike,
	guard: ServiceStopGuard,
	log: (msg: string, fields?: Record<string, unknown>) => void = () => {}
): void {
	const watchOwner = createRendererWatch(() => guard.forget());

	ipc.on(RUNNING_SERVICES_CHANNEL, (event: IpcEventLike, ...args: unknown[]) => {
		const services = parseRunningServices(args[0]);
		if (!services) {
			log("service-stop-guard: ignored a message that is not a snapshot", {
				message: args[0],
			});
			return;
		}
		watchOwner(event.sender);
		guard.publish(services);
	});

	ipc.on(LIVE_RUN_CHANNEL, (event: IpcEventLike, ...args: unknown[]) => {
		const published = parseLiveRun(args[0]);
		if (!published) {
			log("service-stop-guard: ignored a message that is not a live run", {
				message: args[0],
			});
			return;
		}
		watchOwner(event.sender);
		guard.publishRun(published.run);
	});
}
