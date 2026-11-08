/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { create } from "zustand";

/**
 * Which OAuth 2.0 configs have an interactive sign-in running, by cache key
 * (#3354).
 *
 * A sign-in belongs to the config, not to the row that started it: the request
 * builder's Auth tab, the context bar and the collection editor can each show a
 * row for the same config, and a second Get token on one config must find the
 * first one running rather than open a second browser tab. The same config also
 * outlives any one row, so rows hold the sign-in between them (`acquire`) and
 * the last to unmount stops it: nothing is left polling for a row nobody sees.
 *
 * The controllers and owner counts sit beside the store rather than in it, as
 * in `request-builder/context/send-tracker.ts`: `active` is what renders, and
 * a controller is nothing a render reads.
 */

interface OAuthSigninState {
	/** The cache keys with a sign-in running. */
	active: ReadonlySet<string>;
}

export const useOAuthSigninStore = create<OAuthSigninState>(() => ({ active: new Set() }));

const controllers = new Map<string, AbortController>();
const ownerCounts = new Map<string, number>();

function setActive(update: (active: Set<string>) => void): void {
	const next = new Set(useOAuthSigninStore.getState().active);
	update(next);
	useOAuthSigninStore.setState({ active: next });
}

/**
 * Start the sign-in for @p key. Returns the signal the flow must honour, or
 * null when one is already running, in which case the caller starts nothing.
 */
function begin(key: string): AbortSignal | null {
	if (controllers.has(key)) return null;
	const controller = new AbortController();
	controllers.set(key, controller);
	setActive((active) => active.add(key));
	return controller.signal;
}

/**
 * The flow that holds @p signal is over. A no-op for a signal that is no longer
 * the key's, so a cancelled flow settling late cannot end the sign-in that
 * replaced it.
 */
function end(key: string, signal: AbortSignal): void {
	if (controllers.get(key)?.signal !== signal) return;
	controllers.delete(key);
	setActive((active) => active.delete(key));
}

/** Abort the sign-in for @p key and mark it over at once. */
function cancel(key: string): void {
	const controller = controllers.get(key);
	if (!controller) return;
	controllers.delete(key);
	setActive((active) => active.delete(key));
	controller.abort();
}

/**
 * Register a row as showing @p key. Returns the release, which is safe to call
 * twice; the release that leaves no owner cancels the key's sign-in.
 */
function acquire(key: string): () => void {
	ownerCounts.set(key, (ownerCounts.get(key) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const remaining = (ownerCounts.get(key) ?? 1) - 1;
		if (remaining > 0) {
			ownerCounts.set(key, remaining);
			return;
		}
		ownerCounts.delete(key);
		cancel(key);
	};
}

export const oauthSignin = { begin, end, cancel, acquire };

/** Whether a sign-in is running for @p key; false for a config with no key. */
export function useIsSigningIn(key: string | null): boolean {
	return useOAuthSigninStore((state) => key !== null && state.active.has(key));
}
