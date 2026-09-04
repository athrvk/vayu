/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's half of the right-click menu (#1359).
 *
 * The menu itself is composed in the main process, which already knows the
 * editing state Chromium hands it: whether the field is editable, what is
 * selected, which of Cut / Copy / Paste can act, the link under the pointer.
 * What it cannot see is what the element *means here* - that this field is the
 * URL bar, which imports a pasted curl command; that the pointer is on a
 * `{{token}}`, which has a popover; that this is a Monaco editor, which draws
 * its own menu and wants no second one. That is what this announces.
 *
 * **Marked, not guessed.** A main-process handler cannot read the DOM, and a
 * coordinate round trip would have to undo the page zoom to hit-test a point.
 * The surfaces that mean something carry an attribute instead, spread from
 * `contextProps` so the name is spelled once, and the announcement is taken
 * from the `contextmenu` event's own target - the element the user actually
 * hit, with no geometry in the middle.
 *
 * **Announced synchronously, on the way past.** The listener runs before
 * Chromium asks the browser process for a menu, so a blocking `setContextTarget`
 * is what makes the announcement and the `context-menu` event a matched pair.
 * The listener captures, because Monaco stops the event from propagating: the
 * marker on its container is what keeps a second menu from opening over the
 * editor's own, and a bubble-phase listener would never see it to say so.
 */

import type { ContextMenuCommand, ContextMenuTarget } from "@/types/electron";

/** Marks a surface whose Vayu meaning the main process cannot see. */
export const CONTEXT_ATTRIBUTE = "data-context";

/** Marks a `{{token}}`, by name, so the menu can offer to edit it. */
export const VARIABLE_ATTRIBUTE = "data-context-variable";

/**
 * The surfaces that mean something to the menu.
 *
 * Short by design: a read-only pane needs no marker, because the selection
 * already says Copy is the only offer, and a plain editable field needs none
 * either, because `isEditable` says the rest. Only these carry an offer, or a
 * refusal, the params cannot imply. Mirrors `ContextKind` in
 * `electron/context-menu.ts`.
 *
 * `own-menu` is that refusal: a surface that draws its own right-click menu -
 * a collection row, a tab (#1360) - and wants no second one over it. Monaco
 * keeps its own name because it is not one of ours; the two are answered the
 * same way.
 */
export type ContextKind = "url-bar" | "monaco" | "own-menu";

/**
 * The props that mark a surface, spread onto it:
 * `<div {...contextProps("monaco")}>`.
 *
 * Spread rather than written out, and typed by the parameter, for the reasons
 * `regionProps` is (`components/layout/region-focus.ts`): a JSX attribute name
 * has to be a literal, so writing it by hand puts the one name in as many
 * places as there are markers, none of which a rename would carry.
 */
export function contextProps(kind: ContextKind): Record<typeof CONTEXT_ATTRIBUTE, ContextKind> {
	return { [CONTEXT_ATTRIBUTE]: kind };
}

/** The props that mark one `{{token}}`: `<span {...variableProps(name)}>`. */
export function variableProps(name: string): Record<typeof VARIABLE_ATTRIBUTE, string> {
	return { [VARIABLE_ATTRIBUTE]: name };
}

/** What the right-clicked element means, and the token element itself if it is one. */
export interface ResolvedContext {
	target: ContextMenuTarget;
	/** The token under the pointer, kept so "Edit variable" can open its popover. */
	token: HTMLElement | null;
}

function markedKind(element: Element | null): ContextKind | null {
	const value = element?.closest(`[${CONTEXT_ATTRIBUTE}]`)?.getAttribute(CONTEXT_ATTRIBUTE);
	return value === "url-bar" || value === "monaco" || value === "own-menu" ? value : null;
}

/** Read what a right-click landed on, in the terms the menu is composed from. */
export function resolveContext(eventTarget: EventTarget | null): ResolvedContext {
	const element = eventTarget instanceof Element ? eventTarget : null;
	const token = element?.closest<HTMLElement>(`[${VARIABLE_ATTRIBUTE}]`) ?? null;
	return {
		target: {
			kind: markedKind(element),
			variable: token?.getAttribute(VARIABLE_ATTRIBUTE) || null,
		},
		token,
	};
}

/**
 * Open the popover for a token the menu was opened on.
 *
 * A click, because that is the popover's one way in: `VariablePopover` holds its
 * own open state and offers no prop to force it (`components/ui/variable-popover.tsx`),
 * and the token is a `role="button"` whose click handler opens it. Going through
 * that handler is also what makes the menu item honest - it opens the same
 * popover the same click opens, rather than a second path to the same component
 * that could drift from it.
 *
 * The element is re-checked rather than trusted: a menu is modal, and a render
 * in the meantime can have replaced or removed the token it was opened over.
 */
export function openVariablePopover(token: HTMLElement | null, name: string): boolean {
	if (!token || !token.isConnected) return false;
	if (token.getAttribute(VARIABLE_ATTRIBUTE) !== name) return false;
	token.click();
	return true;
}

/** What the bridge needs from the window it runs in, so a test can pass fakes. */
export interface ContextMenuBridgeHost {
	setContextTarget?: (target: ContextMenuTarget) => void;
	onContextMenuCommand?: (callback: (command: ContextMenuCommand) => void) => () => void;
}

/**
 * Announce every right-click, and answer the commands the renderer owns.
 *
 * Returns the teardown. Outside Electron there is no bridge to talk to and this
 * does nothing at all, which is also what makes it safe to call from a test that
 * never stubs `electronAPI`.
 */
export function installContextMenuBridge(
	host: ContextMenuBridgeHost | undefined,
	view: Pick<Window, "addEventListener" | "removeEventListener">
): () => void {
	if (!host?.setContextTarget) return () => {};
	const announce = host.setContextTarget;

	let token: HTMLElement | null = null;

	const onContextMenu = (event: Event) => {
		const resolved = resolveContext(event.target);
		token = resolved.token;
		announce(resolved.target);
	};

	// Capture, so Monaco's own handler cannot stop this from seeing the click.
	view.addEventListener("contextmenu", onContextMenu, true);

	const stopListeningForCommands = host.onContextMenuCommand?.((command) => {
		if (command.type !== "edit-variable") return; // the URL bar owns the other
		openVariablePopover(token, command.name);
	});

	return () => {
		view.removeEventListener("contextmenu", onContextMenu, true);
		stopListeningForCommands?.();
	};
}
