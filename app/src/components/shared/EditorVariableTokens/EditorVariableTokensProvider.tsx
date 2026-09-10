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

import { useCallback, useMemo, useState } from "react";
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
		setActive((previous) => ({ ...request, key: (previous?.key ?? 0) + 1 }));
	}, []);

	const value = useMemo<EditorVariableTokensValue>(
		() => ({
			classify,
			getVariableOrigins,
			openTokenEditor,
			setHoveredToken: setHovered,
		}),
		[classify, getVariableOrigins, openTokenEditor]
	);

	const close = useCallback(() => {
		active?.onClose?.();
		setActive(null);
	}, [active]);

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
						focusOnOpen
						onOpenChange={(open) => {
							if (!open) close();
						}}
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
