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
 * Mounted by `RequestBuilderProvider` around its children, because that is what
 * holds `updateVariable` and the scopes it can write to. Everything an editor
 * needs to paint or open a token arrives through the context; an editor with no
 * provider above it paints nothing.
 */

import { useCallback, useMemo, useState } from "react";
import { VariablePopover } from "@/components/ui";
import { useVariableSupport } from "@/modules/request-builder/hooks/useVariableSupport";
import { classifyVariableToken, type VariableTokenKind } from "@/lib/variable-token-kind";
import {
	EditorVariableTokensContext,
	type EditorVariableTokensValue,
	type TokenEditRequest,
} from "./context";

/**
 * The open request, plus the sequence number that makes each open a fresh
 * mount. `VariablePopover` seeds its edit buffer from `varInfo` when it is
 * first rendered open (`defaultOpen`), so opening a second token has to be a
 * new component instance rather than new props on the old one.
 */
interface ActiveRequest extends TokenEditRequest {
	key: number;
}

export function EditorVariableTokensProvider({ children }: { children: React.ReactNode }) {
	const variables = useVariableSupport();
	const [active, setActive] = useState<ActiveRequest | null>(null);

	/*
	 * One snapshot per change, not one per token: `getAllVariables` copies the
	 * whole map on every call, and a body with fifty tokens would otherwise copy
	 * it fifty times on every keystroke that redraws the decorations.
	 */
	const allVariables = useMemo(() => variables.getAllVariables(), [variables]);
	const dataColumns = variables.dataColumns;

	const classify = useCallback(
		(name: string): VariableTokenKind =>
			classifyVariableToken(name, { variables: allVariables, dataColumns }),
		[allVariables, dataColumns]
	);

	const openTokenEditor = useCallback((request: TokenEditRequest) => {
		setActive((previous) => ({ ...request, key: (previous?.key ?? 0) + 1 }));
	}, []);

	const value = useMemo<EditorVariableTokensValue>(
		() => ({
			classify,
			getVariableOrigins: variables.getVariableOrigins,
			openTokenEditor,
		}),
		[classify, variables.getVariableOrigins, openTokenEditor]
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
	const kind = active ? classify(active.name) : null;
	const scoped = kind && kind.state !== "runtime" ? kind : null;

	return (
		<EditorVariableTokensContext.Provider value={value}>
			{children}
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
						onValueChange={variables.updateVariable}
						saveMode="auto"
						origins={variables.getVariableOrigins(active.name)}
						writableScopes={variables.writableScopes}
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
