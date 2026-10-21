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
 * mounts itself, so it can always offer them. Some actions do not fit that shape.
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
 * **Four named slots, not a registry.** The second one arrived in #1243: Send
 * has the identical live-draft problem, so it joined as a slot rather than as a
 * second channel. The third, `exportRun` (#2139), is a finished run's export
 * menu: what it sends depends on that menu's own state (whether the comparison
 * with the baseline is ticked), which lives in the mounted run view and nowhere
 * else. The three command slots are spelled the same way on `CommandSurfaces`.
 * `LiveSurfaceSlot` stays a closed union - a fifth slot is a decision taken
 * here, not a name a caller can invent by passing a string.
 *
 * **The fourth, `editorDraft` (#2638), is a read, not a command.** The context
 * bar's Code section has the same live-draft problem as Send: a snippet of the
 * saved row is the old URL after an edit. The builder publishes a getter over
 * its editor state and the collection chain it composes Send with, and the
 * section builds its compose body from that through `buildComposeBody`, the
 * builder Send itself uses - so it is the payload Send would send, not the
 * second copy the paragraph above rules out. The getter is read when the
 * section composes; the slot changes hands when the builder's request does,
 * never per keystroke. It is not on `CommandSurfaces`: no palette row acts on it.
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

import { useCallback, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import type { RunExportAction } from "@/lib/run-export-formats";
import type { RequestState } from "@/modules/request-builder/types";
import type { Collection } from "@/types";

/** The mounted builder's editor state, as it stands when it is read. */
export interface EditorDraft {
	request: RequestState;
	/** The collection chain, root first, that the builder composes Send with. */
	ancestors: Collection[];
}

/**
 * The `editorDraft` slot's contents. `requestId` names the builder's request for
 * a subscriber deciding whether this is its draft; `read` answers at call time.
 */
export interface EditorDraftSource {
	requestId: string | null;
	read: () => EditorDraft;
}

/** What each slot holds when it is filled - the one place a slot is declared. */
interface LiveSurfaceHandlers {
	/** The mounted request builder's start-load-test handler. */
	startLoadTest: () => void;
	/**
	 * The mounted request builder's send handler - absent while that builder is
	 * on screen but could not send (a run in flight, an empty URL).
	 */
	sendRequest: () => void;
	/**
	 * The mounted export menu of a finished load run, which delivers `action`
	 * the way the menu's own item would - absent while an export is in flight.
	 */
	exportRun: (action: RunExportAction) => void;
	/** The mounted request builder's editor state, for the Code section to compose. */
	editorDraft: EditorDraftSource;
}

/** The slots a mounted feature can fill, named once for both directions. */
export type LiveSurfaceSlot = keyof LiveSurfaceHandlers;

type LiveSurfaceSlots = { [S in LiveSurfaceSlot]: LiveSurfaceHandlers[S] | null };

interface LiveCommandSurfaceState extends LiveSurfaceSlots {
	registerSurface: <S extends LiveSurfaceSlot>(slot: S, handler: LiveSurfaceHandlers[S]) => void;
	/** Drops `handler` from `slot` if it is still the registered one. */
	clearSurface: <S extends LiveSurfaceSlot>(slot: S, handler: LiveSurfaceHandlers[S]) => void;
}

/**
 * A one-slot patch. The write is keyed by `S`, so the compiler holds the
 * handler to that slot's own shape - no cast, which is how a slot would start
 * accepting a handler, or a name, nobody declared.
 */
function fill<S extends LiveSurfaceSlot>(
	slot: S,
	handler: LiveSurfaceHandlers[S] | null
): Partial<LiveSurfaceSlots> {
	const patch: Partial<LiveSurfaceSlots> = {};
	patch[slot] = handler;
	return patch;
}

export const useLiveCommandSurfaceStore = create<LiveCommandSurfaceState>((set) => ({
	startLoadTest: null,
	sendRequest: null,
	exportRun: null,
	editorDraft: null,
	registerSurface: (slot, handler) => set(fill(slot, handler)),
	clearSurface: (slot, handler) =>
		set((state) => (state[slot] === handler ? fill(slot, null) : state)),
}));

/**
 * A wrapper over a ref that keeps one identity for the caller's lifetime and
 * calls whatever `handler` was rendered last.
 *
 * The builder's own handlers close over the draft, so their identity changes on
 * every keystroke; registering that directly would write to the store - and
 * re-render the palette - once per character typed. The wrapper is written once
 * and reads the current handler when it is called.
 */
function useStableHandler<A extends unknown[]>(
	handler: ((...args: A) => void) | null
): (...args: A) => void {
	const latest = useRef(handler);
	useEffect(() => {
		latest.current = handler;
	}, [handler]);
	return useCallback((...args: A) => latest.current?.(...args), []);
}

/**
 * Publish `stable` in `slot` while `offered`; withdrawing the offer clears it
 * without unmounting.
 *
 * Keyed on the *offer*, not the handler: a slot changes hands when a feature
 * starts or stops being able to act, never when the state behind it is edited.
 */
function useOfferSurface<S extends LiveSurfaceSlot>(
	slot: S,
	stable: LiveSurfaceHandlers[S],
	offered: boolean
): void {
	useEffect(() => {
		if (!offered) return;
		const { registerSurface, clearSurface } = useLiveCommandSurfaceStore.getState();
		registerSurface(slot, stable);
		return () => clearSurface(slot, stable);
	}, [slot, stable, offered]);
}

/** Publish the mounted builder's start-load-test handler. */
export function useRegisterLoadTestSurface(handler: () => void): void {
	const stable = useStableHandler(handler);
	useOfferSurface("startLoadTest", stable, true);
}

/**
 * Publish the mounted builder's send handler, or `null` while it could not send
 * - see `canSendRequest`, the one predicate that decides which.
 */
export function useRegisterSendRequestSurface(handler: (() => void) | null): void {
	const stable = useStableHandler(handler);
	useOfferSurface("sendRequest", stable, handler !== null);
}

/**
 * Publish a finished run's export handler, or `null` while it could not export
 * (one already in flight). Only the active tab's view is mounted, so at most one
 * menu holds the slot; the identity-checked clear covers the hand-over.
 */
export function useRegisterExportRunSurface(
	handler: ((action: RunExportAction) => void) | null
): void {
	const stable = useStableHandler(handler);
	useOfferSurface("exportRun", stable, handler !== null);
}

/**
 * Publish the mounted builder's editor state as a read.
 *
 * The draft goes into a ref and the slot holds a getter over it, so typing
 * writes no store. The source is rebuilt when the request id changes, so a
 * subscriber keyed on `requestId` hears a tab switch inside one mounted builder.
 */
export function useRegisterEditorDraftSurface(draft: EditorDraft): void {
	const latest = useRef(draft);
	useEffect(() => {
		latest.current = draft;
	}, [draft]);
	const requestId = draft.request.id;
	const source = useMemo<EditorDraftSource>(
		() => ({ requestId, read: () => latest.current }),
		[requestId]
	);
	useOfferSurface("editorDraft", source, true);
}

/**
 * The published editor draft for @p requestId, read now, or undefined.
 *
 * Checks the draft's own id rather than the source's: within one commit the ref
 * can already hold the next request's draft while the slot still names the
 * last, and a draft composed under the wrong request's id is the stale-snippet
 * defect this channel exists to remove.
 */
export function editorDraftFor(requestId: string): EditorDraft | undefined {
	const draft = useLiveCommandSurfaceStore.getState().editorDraft?.read();
	return draft?.request.id === requestId ? draft : undefined;
}
