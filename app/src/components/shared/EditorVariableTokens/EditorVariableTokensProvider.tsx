/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `{{token}}` popover, for editors that draw their text instead of laying
 * it out (issue #1220).
 *
 * `VariableInput` hangs a `VariablePopover` off the token itself, because there
 * the token is a real `<span>`. Monaco has no such node, so this provider keeps
 * one popover for the whole subtree and positions it over whichever token an
 * editor asks about - a fixed-position anchor at the rectangle the editor
 * measured, with the *same* popover component, the same origins and the same
 * writer behind it. Two popovers would be two answers to "what is this value".
 *
 * Mounted around whichever tree holds editors that interpolate variables, fed
 * a `VariableSupport` by the caller - `RequestBuilderProvider` and the
 * collection's `ElementsTab` each build one from `useVariableResolver` +
 * `useVariableWriter` (issue #1651), the same `updateVariable`/`writableScopes`
 * pair under a shared hook rather than the request builder's own, since a
 * variable's scope was never actually request-shaped - global, a collection's
 * own, and the session's active environment are all writable from either tree
 * on the same terms (issue #1220 script support). Taking `support` as a prop
 * rather than reading `useVariableSupport()` itself is the same #564 move that
 * type made in the first place: a hook that throws with no
 * `RequestBuilderProvider` above it is exactly what kept this provider
 * unusable outside the request builder. Everything an editor needs to paint
 * or open a token arrives through the context; an editor with no provider
 * above it paints nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VariablePopover } from "@/components/ui";
import {
	classifyScriptToken,
	type ScriptTokenHint,
	type VariableTokenKind,
} from "@/lib/variable-token-kind";
import type { VariableOrigin, VariableSupport } from "@/types";
import {
	EditorVariableTokensContext,
	type EditorVariableTokensValue,
	type TokenEditRequest,
	type TokenHoverRequest,
} from "./context";
import { TokenHoverCard } from "./TokenHoverCard";

/**
 * The origins a script's span should be judged against - the accessor's own
 * scope only for a `"scope"` read (never a bound row, which that accessor
 * cannot see), the row alone for a `"row"` read, none at all for a `"bare"`
 * mention (it is not a read, so nothing shadows it), and everything for a
 * caller with no hint - a body-language token, `pm.variables.get`, or a
 * `replaceIn(...)` template, all of which answer from the whole ladder.
 *
 * Filtering matters beyond tidiness: `TokenHoverCard`'s `HoverAnswer` checks
 * `origins` for a `"row"` entry *before* looking at `kind` at all, so an
 * unfiltered list would show "Bound row" for `pm.environment.get("email")`
 * while a row happens to be picked - true of `pm.variables`, false of the one
 * scope this accessor actually reads.
 */
function originsForHint(
	origins: VariableOrigin[],
	scriptHint: ScriptTokenHint | undefined
): VariableOrigin[] {
	if (!scriptHint) return origins;
	if (scriptHint.via === "bare") return [];
	if (scriptHint.via === "row") return origins.filter((o) => o.scope === "row");
	return origins.filter((o) => o.scope === scriptHint.scope);
}

/**
 * The open request, plus the sequence number that makes each open a fresh
 * mount. `VariablePopover` seeds its edit buffer from `varInfo` when it is
 * first rendered open (`defaultOpen`), so opening a second token has to be a
 * new component instance rather than new props on the old one.
 */
interface ActiveRequest extends TokenEditRequest {
	key: number;
}

export function EditorVariableTokensProvider({
	children,
	support,
}: {
	children: React.ReactNode;
	/** What every editor under this provider paints, opens and writes through. */
	support: VariableSupport;
}) {
	const [active, setActive] = useState<ActiveRequest | null>(null);
	const [hovered, setHovered] = useState<TokenHoverRequest | null>(null);

	/**
	 * Whether the currently open instance has ever actually held focus - as
	 * opposed to having merely been mounted, unfocused, by a hover (issue #1220
	 * hover redesign).
	 *
	 * A permanent document-level listener rather than one scoped to `active`'s
	 * lifetime: React runs a child's mount effects (Radix's own auto-focus among
	 * them) before this component's, so a listener attached only once `active`
	 * changes could miss the very focus move it exists to catch. Attached once,
	 * for the app's life, and reset explicitly at the one place an open begins.
	 */
	const tookFocusRef = useRef(false);
	/*
	 * What `close`/`closeTokenEditor` read, so both can stay stable
	 * (`useCallback(..., [])`) like every other value on this context -
	 * `onOpenChange`'s inline `close()` call already needed that stability
	 * once `closeTokenEditor` existed alongside it, since a callback that
	 * changes identity on every `active` transition is also a callback whose
	 * closure over `active` is stale everywhere it was captured before the
	 * next transition (an editor's own `hoverAt`/`scheduleHoverClose`
	 * included).
	 */
	const activeRef = useRef<ActiveRequest | null>(null);
	useEffect(() => {
		activeRef.current = active;
	}, [active]);
	useEffect(() => {
		const onFocusIn = (e: FocusEvent) => {
			if (
				e.target instanceof HTMLElement &&
				e.target.closest('[data-slot="popover-content"]')
			) {
				tookFocusRef.current = true;
			}
		};
		document.addEventListener("focusin", onFocusIn);
		return () => document.removeEventListener("focusin", onFocusIn);
	}, []);

	/*
	 * One snapshot per change, not one per token: `getAllVariables` copies the
	 * whole map on every call, and a body with fifty tokens would otherwise copy
	 * it fifty times on every keystroke that redraws the decorations.
	 */
	const allVariables = useMemo(() => support.getAllVariables(), [support]);
	const dataColumns = support.dataColumns;
	const getVariableOrigins = support.getVariableOrigins;

	const classify = useCallback(
		(name: string, scriptHint?: ScriptTokenHint): VariableTokenKind =>
			classifyScriptToken(name, scriptHint, {
				variables: allVariables,
				dataColumns,
				getVariableOrigins,
			}),
		[allVariables, dataColumns, getVariableOrigins]
	);

	const openTokenEditor = useCallback((request: TokenEditRequest) => {
		// Opening takes the hover down: the popover says everything the tooltip
		// does, over the same rectangle, and two cards on one token is one too
		// many. The editor cancels its own timer; this covers the chord, which
		// opens with no pointer involved.
		setHovered(null);
		// This open has not taken focus yet - `focus: false` (a hover) never
		// will on its own, and `focus: true` (the chord) is about to, which the
		// permanent listener above will catch.
		tookFocusRef.current = false;
		setActive((previous) => ({ ...request, key: (previous?.key ?? 0) + 1 }));
	}, []);

	const close = useCallback(() => {
		// A hover-opened popover that never took focus closes silently: calling
		// `onClose` here is what sends `editor.focus()` back to the editor
		// (`useEditorVariableTokens.ts`'s `open`), and doing that for a popover
		// the reader never actually reached would yank focus away from wherever
		// they are really typing - a different field, another editor entirely.
		if (tookFocusRef.current) activeRef.current?.onClose?.();
		setActive(null);
	}, []);

	const closeTokenEditor = useCallback(
		(token?: string) => {
			const current = activeRef.current;
			if (!current) return;
			// A hover-armed close names the token it was scheduled for. One
			// provider serves every editor, so by the time this fires the pointer
			// may already have opened a *different* editor's token - closing
			// unconditionally would tear that one down instead (issue #1220 hover
			// redesign, cross-editor race). An open with no `hoverToken` (the
			// chord, or a caller that predates this) is never second-guessed.
			if (current.hoverToken !== undefined && current.hoverToken !== token) return;
			close();
		},
		[close]
	);

	const value = useMemo<EditorVariableTokensValue>(
		() => ({
			classify,
			getVariableOrigins,
			openTokenEditor,
			closeTokenEditor,
			setHoveredToken: setHovered,
		}),
		[classify, getVariableOrigins, openTokenEditor, closeTokenEditor]
	);

	/*
	 * A run-time token has no stored variable behind it, so there is nothing for
	 * the popover to edit. The editors never ask for one; this is the guard that
	 * keeps that true rather than an assumption about every future caller.
	 */
	const kind = active ? classify(active.name, active.scriptHint) : null;
	const scoped = kind && kind.state !== "runtime" ? kind : null;

	/*
	 * No scope this support can write to at all (both trees pass
	 * `useVariableWriter`, so this is rare rather than the collection tab's
	 * permanent state - see its own comment): fall back to `VariablePopover`'s
	 * own read-only state rather than handing it a `updateVariable` that would
	 * appear to save and silently doesn't. `writableScopes` already carries
	 * this fact for the create picker; this is the same fact read for the edit
	 * path, which - unlike create - the popover does not gate on
	 * `writableScopes` itself.
	 */
	const canWrite = support.writableScopes.length > 0;

	return (
		<EditorVariableTokensContext.Provider value={value}>
			{children}
			{hovered && (
				<TokenHoverCard
					// A fresh card per token, so Radix positions against the new
					// rectangle rather than animating the old one across the editor.
					key={`${hovered.name}:${hovered.rect.left}:${hovered.rect.top}`}
					request={hovered}
					kind={classify(hovered.name, hovered.scriptHint)}
					origins={originsForHint(getVariableOrigins(hovered.name), hovered.scriptHint)}
					editable={canWrite}
				/>
			)}
			{active && scoped && (
				<div
					// Fixed, because the rectangle came from `getBoundingClientRect`
					// on the editor: it is where the token is *now*.
					style={{
						position: "fixed",
						left: active.rect.left,
						top: active.rect.top,
						width: active.rect.width,
						height: active.rect.height,
						// The anchor is a measurement, not a target - a click here goes
						// to the editor underneath, as it did before the popover opened.
						pointerEvents: "none",
					}}
				>
					<VariablePopover
						key={active.key}
						name={active.name}
						varInfo={scoped.info}
						resolved={scoped.state !== "undefined"}
						onValueChange={canWrite ? support.updateVariable : undefined}
						saveMode="auto"
						origins={originsForHint(getVariableOrigins(active.name), active.scriptHint)}
						writableScopes={support.writableScopes}
						defaultOpen
						// Undefined (no caller left that omits it) behaves as `true`,
						// matching the chord's own long-standing behaviour - see
						// `TokenEditRequest.focus`.
						focusOnOpen={active.focus ?? true}
						onOpenChange={(open) => {
							if (!open) close();
						}}
						onContentMouseEnter={active.onContentMouseEnter}
						onContentMouseLeave={active.onContentMouseLeave}
						// Never a Tab stop: the popover it opens took focus, and the
						// anchor itself is an invisible box over Monaco's canvas. It
						// still carries a name - `VariablePopover` gives its trigger
						// `role="button"`, and a button with no name is a button a
						// screen reader cannot describe even when nothing can reach it.
						tabIndex={-1}
						trigger={<span className="sr-only">{`{{${active.name}}}`}</span>}
						triggerClassName="block h-full w-full"
					/>
				</div>
			)}
		</EditorVariableTokensContext.Provider>
	);
}
