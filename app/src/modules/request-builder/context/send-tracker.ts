/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which send of each request is in flight (#3352).
 *
 * One `RequestBuilderProvider` serves every request tab, so "is a send in
 * flight" is a question about a request, not about the builder: switching away
 * from a request mid-send and back must find it still sending. Each send is
 * numbered when it starts, and its finish and its response count only while
 * that number is still the request's current one. A send overtaken by a newer
 * send of the same request can therefore neither clear the newer one's
 * "Sending…" nor land its answer over the newer one's.
 *
 * A request with no entry is idle. Every send ends in `finish` (the provider
 * calls it from a `finally`) or in `cancel`, so an entry never outlives its
 * send and the map needs no pruning against the open tabs.
 *
 * Closure state rather than React state, for the same reason as
 * `createAltTapWatcher`: the send's own `await` is what reads it back, and a
 * closure is the one place that is current across that `await`. `onChange`
 * hands each new map to whatever renders it.
 */

/** One request's send in flight. */
export interface InFlightSend {
	readonly id: number;
	/** Its caller handed the ticket's `signal` to the transport, so `cancel` stops it. */
	readonly cancellable: boolean;
}

/** The send in flight per request key; absence means idle. */
export type InFlightSends = ReadonlyMap<string, InFlightSend>;

export const NO_SENDS: InFlightSends = new Map();

/** One send, as its own code sees it. */
export interface SendTicket {
	/** Whether this is still the newest send of its request. */
	isCurrent(): boolean;
	/** Aborted when the send is cancelled. */
	readonly signal: AbortSignal;
	/** The send is over. Clears the request only if no newer send replaced it. */
	finish(): void;
}

export interface SendTracker {
	begin(key: string, options?: { cancellable?: boolean }): SendTicket;
	/**
	 * Abort the request's cancellable send and return the request to idle at
	 * once. The cancelled ticket stops being current, so its answer is dropped
	 * and its own `finish` is a no-op, like an overtaken send's.
	 */
	cancel(key: string): void;
}

export function createSendTracker(onChange: (sends: InFlightSends) => void): SendTracker {
	let sends: InFlightSends = NO_SENDS;
	// Beside `sends` rather than in it: `sends` is what renders, and a
	// controller is nothing a render reads.
	const controllers = new Map<string, AbortController>();
	let lastSendId = 0;

	const release = (key: string) => {
		const next = new Map(sends);
		next.delete(key);
		sends = next;
		controllers.delete(key);
		onChange(sends);
	};

	return {
		begin(key, options) {
			lastSendId += 1;
			const sendId = lastSendId;
			const controller = new AbortController();
			sends = new Map(sends).set(key, {
				id: sendId,
				cancellable: options?.cancellable ?? false,
			});
			controllers.set(key, controller);
			onChange(sends);

			const isCurrent = () => sends.get(key)?.id === sendId;
			return {
				isCurrent,
				signal: controller.signal,
				finish() {
					if (isCurrent()) release(key);
				},
			};
		},
		cancel(key) {
			if (!sends.get(key)?.cancellable) return;
			controllers.get(key)?.abort();
			release(key);
		},
	};
}
