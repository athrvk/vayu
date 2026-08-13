/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The channel a *mounted feature* contributes a command surface through.
 *
 * `CommandSurfaces` was originally the palette host's own set: three dialogs it
 * mounts itself, so it can always offer them. One action does not fit that
 * shape. Starting a load test needs the request builder's **live editor draft**
 * - the URL, headers, body and auth as currently typed, before autosave has run
 * - and that draft exists only inside `RequestBuilderProvider`, which the
 * palette is a sibling of. A command reaching for the saved request instead
 * would run the *old* URL after an edit and report it as the run the user asked
 * for: a near-miss that reads as a bug, which is why #526 shipped the registry
 * without this command rather than approximating it.
 *
 * So the mounted feature hands its own handler out, and the palette merges what
 * is registered into the surfaces it offers. The alternative - reading the draft
 * out of the provider from outside it, or recomposing the payload in the command
 * - would be a second copy of `buildExecBody` and the single-active-run policy,
 * exactly the "hand-rolled copy of a primitive" defect the registry exists to
 * remove. Nothing about the load test moves; only its *reachability* changes.
 *
 * **One slot, one contributor.** A registry of arbitrary named surfaces would be
 * a framework built for a second caller that does not exist yet. When one
 * arrives - a "Send request" command has the same live-draft problem - it joins
 * this file as a second slot, rather than inventing a second channel.
 *
 * **The clear is identity-checked.** Unmount effects run before the next mount's
 * effects, so switching request tabs clears then registers in the right order -
 * but a remount that ever lands the other way round would otherwise leave the
 * slot empty with a builder on screen. Comparing identity makes the clear a
 * no-op for anyone but the current holder.
 */

import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";

interface LiveCommandSurfaceState {
	/** The mounted request builder's start-load-test handler, or null. */
	startLoadTest: (() => void) | null;
	registerStartLoadTest: (handler: () => void) => void;
	/** Drops `handler` if it is still the registered one. */
	clearStartLoadTest: (handler: () => void) => void;
}

export const useLiveCommandSurfaceStore = create<LiveCommandSurfaceState>((set) => ({
	startLoadTest: null,
	registerStartLoadTest: (handler) => set({ startLoadTest: handler }),
	clearStartLoadTest: (handler) =>
		set((state) => (state.startLoadTest === handler ? { startLoadTest: null } : state)),
}));

/**
 * Publish `handler` as the live start-load-test surface for as long as the
 * caller is mounted.
 *
 * The registered function is a **stable** wrapper over a ref rather than
 * `handler` itself. The builder's own `startLoadTest` closes over the draft, so
 * its identity changes on every keystroke; registering that directly would write
 * to this store - and re-render the palette - once per character typed. The
 * wrapper is written once and reads the current handler when it is called.
 */
export function useRegisterLoadTestSurface(handler: () => void): void {
	const latest = useRef(handler);
	useEffect(() => {
		latest.current = handler;
	}, [handler]);

	const stable = useCallback(() => latest.current(), []);

	useEffect(() => {
		const { registerStartLoadTest, clearStartLoadTest } = useLiveCommandSurfaceStore.getState();
		registerStartLoadTest(stable);
		return () => clearStartLoadTest(stable);
	}, [stable]);
}
