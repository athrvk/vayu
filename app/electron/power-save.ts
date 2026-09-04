/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The system wake lock a run holds, and the report of a sleep it could not
 * prevent (issue #1357).
 *
 * A load test is a long-running foreground task the user stops watching: they
 * start a thirty-minute run and switch to something else. The OS then suspends
 * the machine on its own timer, the engine stops with it, and the report comes
 * back with a flat stretch or a cluster of timeouts that reads as the server's
 * fault. So while a run streams, the app asks the OS not to sleep.
 *
 * `prevent-app-suspension`, never `prevent-display-sleep`: the screen may dim
 * and lock, the machine may not suspend. A run is not a reason to keep a laptop
 * lit on someone's desk.
 *
 * The lock is ref-counted because two runs can overlap in the renderer's model
 * (a load run and a collection run each hold), and because a hold that outlived
 * its holder would pin the machine awake for the rest of the session. Every
 * holder gets a token back and hands it in; the blocker starts on the first and
 * stops on the last.
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do. The Electron surfaces it
 * needs arrive as arguments for the same reason.
 */

import { randomUUID } from "node:crypto";

/** What a run asks the OS for. See the header: never `prevent-display-sleep`. */
export const WAKE_LOCK_BLOCKER_TYPE = "prevent-app-suspension";

export const POWER_HOLD_CHANNEL = "power:hold";
export const POWER_RELEASE_CHANNEL = "power:release";
export const POWER_SUSPENDED_CHANNEL = "power:suspended";
export const POWER_RESUMED_CHANNEL = "power:resumed";

/** The host went to sleep while a run held the lock. `at` is a wall clock ms. */
export interface HostSuspendedEvent {
	at: number;
}

/** The host came back. `durationMs` is the gap the run's series cannot explain. */
export interface HostResumedEvent {
	at: number;
	durationMs: number;
}

/** The slice of Electron's `powerSaveBlocker` this needs, so a test can pass a fake. */
export interface PowerSaveBlockerLike {
	start(type: string): number;
	stop(id: number): void;
	isStarted(id: number): boolean;
}

/** The slice of Electron's `powerMonitor` this needs. */
export interface PowerMonitorLike {
	on(event: "suspend" | "resume", listener: () => void): unknown;
}

export interface WakeLockDeps {
	blocker: PowerSaveBlockerLike;
	monitor: PowerMonitorLike;
	/** Push an event to the renderer. A destroyed window is the caller's problem. */
	send: (channel: string, payload: unknown) => void;
	/** Wall clock, injected so a test can move it. */
	now?: () => number;
}

export interface WakeLock {
	/**
	 * Ask the OS to stay awake. Returns the token that releases this hold - the
	 * caller keeps it, and nothing else can drop a hold it did not take.
	 */
	hold(reason: string, ownerId?: number): string;
	/** Hand a token back. `false` for a token that was never live, or is already home. */
	release(token: string): boolean;
	/** Drop every hold taken by one renderer - it is gone or reloading. */
	releaseAllFrom(ownerId: number): number;
	/** How many holds are live. The blocker is running when this is above zero. */
	activeHolds(): number;
}

export function createWakeLock(deps: WakeLockDeps): WakeLock {
	const now = deps.now ?? Date.now;
	const holds = new Map<string, { reason: string; ownerId: number | null }>();
	let blockerId: number | null = null;
	/** Set only between an announced suspend and its resume. */
	let suspendedAt: number | null = null;

	function startBlocker(): void {
		if (blockerId !== null) return;
		blockerId = deps.blocker.start(WAKE_LOCK_BLOCKER_TYPE);
	}

	function stopBlockerIfIdle(): void {
		if (holds.size > 0 || blockerId === null) return;
		// `isStarted` because the OS can refuse or drop a blocker - stopping an id
		// it no longer knows throws on some platforms.
		if (deps.blocker.isStarted(blockerId)) deps.blocker.stop(blockerId);
		blockerId = null;
	}

	/*
	 * Subscribed once, for the life of the process, rather than while a hold is
	 * live: `powerMonitor` exposes no removal that survives a listener taken and
	 * given back repeatedly, and the guard below is what "while any token is
	 * held" actually means to a reader - no hold, nothing to report.
	 */
	deps.monitor.on("suspend", () => {
		if (holds.size === 0) return;
		suspendedAt = now();
		deps.send(POWER_SUSPENDED_CHANNEL, { at: suspendedAt } satisfies HostSuspendedEvent);
	});

	deps.monitor.on("resume", () => {
		const startedAt = suspendedAt;
		suspendedAt = null;
		// Nothing announced the suspend, so there is no interval to close - a
		// resume the app slept through without a run is not an event.
		if (startedAt === null) return;
		const at = now();
		// Announced suspends are always closed, even if the run ended while the
		// host was down: the renderer is holding an open marker on the strength of
		// the suspend event, and only this closes it.
		deps.send(POWER_RESUMED_CHANNEL, {
			at,
			durationMs: Math.max(0, at - startedAt),
		} satisfies HostResumedEvent);
	});

	return {
		hold(reason: string, ownerId?: number): string {
			const token = randomUUID();
			holds.set(token, { reason, ownerId: ownerId ?? null });
			startBlocker();
			return token;
		},

		release(token: string): boolean {
			if (!holds.delete(token)) return false;
			stopBlockerIfIdle();
			return true;
		},

		releaseAllFrom(ownerId: number): number {
			let dropped = 0;
			for (const [token, held] of holds) {
				if (held.ownerId !== ownerId) continue;
				holds.delete(token);
				dropped++;
			}
			if (dropped > 0) stopBlockerIfIdle();
			return dropped;
		},

		activeHolds(): number {
			return holds.size;
		},
	};
}

/** The slice of `ipcMain` the channels need. */
export interface IpcLike {
	handle(
		channel: string,
		listener: (event: IpcEventLike, ...args: unknown[]) => unknown
	): unknown;
}

/**
 * The renderer behind a call, and the two lifecycle events that mean its holds
 * are gone: `destroyed` (window closed, process gone) and `did-start-loading`
 * (a reload - the new page cannot release the old page's tokens).
 */
export interface RendererLike {
	id: number;
	once(event: "destroyed", listener: () => void): unknown;
	on(event: "did-start-loading", listener: () => void): unknown;
}

export interface IpcEventLike {
	sender: RendererLike;
}

/**
 * Wire the two channels, and make a renderer's holds die with it.
 *
 * The owner cleanup is not a nicety: a renderer that crashes or reloads mid-run
 * never gets to release, and without this the machine stays pinned awake until
 * the app quits.
 */
export function registerPowerIpc(ipc: IpcLike, lock: WakeLock): void {
	const watched = new Set<number>();

	function watchOwner(sender: RendererLike): void {
		if (watched.has(sender.id)) return;
		watched.add(sender.id);
		const drop = () => {
			lock.releaseAllFrom(sender.id);
		};
		sender.once("destroyed", () => {
			watched.delete(sender.id);
			drop();
		});
		sender.on("did-start-loading", drop);
	}

	ipc.handle(POWER_HOLD_CHANNEL, (event: IpcEventLike, ...args: unknown[]) => {
		// A reason the renderer did not send is not a reason to refuse the hold:
		// the lock is what the run needs, the string only says who asked.
		const reason = typeof args[0] === "string" ? args[0] : "run";
		watchOwner(event.sender);
		return lock.hold(reason, event.sender.id);
	});

	ipc.handle(POWER_RELEASE_CHANNEL, (_event: IpcEventLike, ...args: unknown[]) => {
		const token = args[0];
		if (typeof token !== "string") return false;
		return lock.release(token);
	});
}
