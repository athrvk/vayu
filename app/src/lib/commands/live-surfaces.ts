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
 * mounts itself, so it can always offer them. Two actions do not fit that shape.
 * Starting a load test - and sending - needs the request builder's **live editor
 * draft** - the URL, headers, body and auth as currently typed, before autosave
 * has run - and that draft exists only inside `RequestBuilderProvider`, which the
 * palette is a sibling of. A command reaching for the saved request instead
 * would run the *old* URL after an edit and report it as the run the user asked
 * for: a near-miss that reads as a bug, which is why #526 shipped the registry
 * without these commands rather than approximating them.
 *
 * So the mounted feature hands its own handler out, and the palette merges what
 * is registered into the surfaces it offers. The alternative - reading the draft
 * out of the provider from outside it, or recomposing the payload in the command
 * - would be a second copy of `buildExecBody` and the single-active-run policy,
 * exactly the "hand-rolled copy of a primitive" defect the registry exists to
 * remove. Nothing about either action moves; only its *reachability* changes.
 *
 * **Two named slots, not a registry.** The second one arrived in #1243, the
 * caller this file's first version said it was waiting for: Send has the
 * identical live-draft problem, so it joined as a slot rather than as a second
 * channel. `LiveSurfaceSlot` stays a closed union, spelled the same way on
 * `CommandSurfaces` - a third slot is a decision taken here, not a name a caller
 * can invent by passing a string.
 *
 * **The clear is identity-checked.** Unmount effects run before the next mount's
 * effects, so switching request tabs clears then registers in the right order -
 * but a remount that ever lands the other way round would otherwise leave the
 * slot empty with a builder on screen. Comparing identity makes the clear a
 * no-op for anyone but the current holder.
 *
 * **A contribution can be conditional.** A slot holding a handler is what makes
 * its command appear, so a feature that can only *sometimes* perform the action
 * passes `null` the rest of the time and the row goes away with it - which is
 * the honest answer for Send, whose own button is replaced by Stop mid-stream
 * and disabled with an empty URL. A registered handler that quietly declined
 * would be a palette row that answers to nothing.
 */

import { useCallback, useEffect, useRef } from "react";
import { create } from "zustand";

/** The slots a mounted feature can fill, named once for both directions. */
export type LiveSurfaceSlot = "startLoadTest" | "sendRequest";

interface LiveCommandSurfaceState {
	/** The mounted request builder's start-load-test handler, or null. */
	startLoadTest: (() => void) | null;
	/**
	 * The mounted request builder's send handler, or null - including while that
	 * builder is on screen but could not send (a run in flight, an empty URL).
	 */
	sendRequest: (() => void) | null;
	registerSurface: (slot: LiveSurfaceSlot, handler: () => void) => void;
	/** Drops `handler` from `slot` if it is still the registered one. */
	clearSurface: (slot: LiveSurfaceSlot, handler: () => void) => void;
}

/**
 * A one-slot patch, written where the compiler can see which key it sets - a
 * computed key would need a cast, and a cast here is how the two slots would
 * start accepting a third name nobody declared.
 */
function fill(
	slot: LiveSurfaceSlot,
	handler: (() => void) | null
): Partial<LiveCommandSurfaceState> {
	return slot === "startLoadTest" ? { startLoadTest: handler } : { sendRequest: handler };
}

export const useLiveCommandSurfaceStore = create<LiveCommandSurfaceState>((set) => ({
	startLoadTest: null,
	sendRequest: null,
	registerSurface: (slot, handler) => set(fill(slot, handler)),
	clearSurface: (slot, handler) =>
		set((state) => (state[slot] === handler ? fill(slot, null) : state)),
}));

/**
 * Publish `handler` in `slot` for as long as the caller is mounted and passes a
 * handler at all; `null` withdraws the contribution without unmounting.
 *
 * The registered function is a **stable** wrapper over a ref rather than
 * `handler` itself. The builder's own handlers close over the draft, so their
 * identity changes on every keystroke; registering that directly would write to
 * this store - and re-render the palette - once per character typed. The wrapper
 * is written once and reads the current handler when it is called.
 */
function useRegisterSurface(slot: LiveSurfaceSlot, handler: (() => void) | null): void {
	const latest = useRef(handler);
	useEffect(() => {
		latest.current = handler;
	}, [handler]);

	const stable = useCallback(() => latest.current?.(), []);

	// The *offer*, not the handler: a slot changes hands when a feature starts or
	// stops being able to act, never when the draft behind it is edited.
	const offered = handler !== null;

	useEffect(() => {
		if (!offered) return;
		const { registerSurface, clearSurface } = useLiveCommandSurfaceStore.getState();
		registerSurface(slot, stable);
		return () => clearSurface(slot, stable);
	}, [slot, stable, offered]);
}

/** Publish the mounted builder's start-load-test handler. */
export function useRegisterLoadTestSurface(handler: () => void): void {
	useRegisterSurface("startLoadTest", handler);
}

/**
 * Publish the mounted builder's send handler, or `null` while it could not send
 * - see `canSendRequest`, the one predicate that decides which.
 */
export function useRegisterSendRequestSurface(handler: (() => void) | null): void {
	useRegisterSurface("sendRequest", handler);
}
