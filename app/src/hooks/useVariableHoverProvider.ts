/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * "What does this `{{name}}` resolve to?", in the Monaco editors.
 *
 * Every single-line field in the request builder has answered that on hover for
 * a long time - `VariableInput` paints a token strip and a tooltip over it. The
 * body and GraphQL editors never did: the value was visible while the
 * completion list was open and never again, so the one place you write the
 * longest payloads was the one place a variable said nothing about itself
 * (issue #1220).
 *
 * **The same answer, from the same origins list.** The tooltip and the popover
 * already agree about what wins (a bound row above every scope, a secret as the
 * word `secret`, the definitions that lost listed beneath); this reads the same
 * resolver and the same `getVariableOrigins`, through the shared
 * `classifyVariableToken`. Hovering and clicking are two readings of one token,
 * and a token that answers them differently is worse than one that answers both
 * wrongly (`docs/app/variable-resolution.md`).
 *
 * **Registered for the body languages only**, the same list as `{{` completion
 * and for the same reason: a script does not reach variables through braces, so
 * `{{name}}` in a script is literal text the engine never interpolates.
 *
 * Called once, in App - a hover provider is global per language, so one
 * registration covers every editor instance. The same shape as
 * `useVariableCompletionProvider` beside it.
 */

import { useEffect } from "react";
import { useLoadedMonaco } from "@/lib/monaco-loader";
import type * as Monaco from "monaco-editor";
import { useVariableResolver } from "./useVariableResolver";
import { useActiveCollectionId, useActiveRequestId } from "./useActiveCollectionId";
import { useDataContract } from "./useDataContract";
import { BODY_LANGUAGES } from "./useVariableCompletionProvider";
import { boundRowFor, useBoundRowStore } from "@/stores";
import { classifyVariableToken } from "@/lib/variable-token-kind";
import { isVariableTokenModel } from "@/lib/variable-token-models";
import { variableHoverMarkdown, variableTokensInLine } from "@/lib/monaco-variable-tokens";
import { EDIT_VARIABLE_CHORD } from "@/constants/shortcuts";
import { formatChord, isMac } from "@/lib/platform";

/**
 * The line under the value, telling a reader how to change it.
 *
 * Both routes, because they are not interchangeable: the click is what a mouse
 * user will try, and the chord is the whole keyboard path - there is no token
 * to Tab to inside a canvas.
 */
function editHint(): string {
	return `${isMac ? "⌘" : "Ctrl"}-click or ${formatChord(EDIT_VARIABLE_CHORD)} to edit`;
}

export function useVariableHoverProvider() {
	// Passive by design: null until an editor has loaded Monaco - see
	// `useVariableCompletionProvider`, which registers the same way.
	const monaco = useLoadedMonaco();
	const collectionId = useActiveCollectionId();
	/*
	 * The row the builder is bound to, through the store that exists for
	 * "surfaces that preview a request from outside it" (issue #1074) - the tab
	 * strip's problem exactly, and now this one's. Without it the resolver here
	 * would rank the scopes while `EditableVariable`, one field above, ranks the
	 * row over them, and the same `{{email}}` would read two ways.
	 */
	const bound = useBoundRowStore((s) => s.bound);
	const activeRequestId = useActiveRequestId();
	const boundRow = boundRowFor(bound, activeRequestId);
	const { getAllVariables, getVariableOrigins } = useVariableResolver({ collectionId, boundRow });
	const dataColumns = useDataContract(collectionId);

	useEffect(() => {
		if (!monaco) return;

		const provider: Monaco.languages.HoverProvider = {
			provideHover(model, position) {
				/*
				 * One provider serves every `json` model in the app, a response
				 * body included - and a `{{userId}}` in a payload someone was sent
				 * is data, not a variable to define. The editors that paint tokens
				 * mark their model; nothing else answers here.
				 */
				if (!isVariableTokenModel(model)) return null;
				// One line, not the whole model: a hover asks about one position.
				const range = variableTokensInLine(
					model.getLineContent(position.lineNumber),
					position.lineNumber
				).find(
					(token) =>
						position.column >= token.startColumn && position.column <= token.endColumn
				);
				if (!range) return null;

				const kind = classifyVariableToken(range.name, {
					variables: getAllVariables(),
					dataColumns,
				});
				const contents = variableHoverMarkdown(
					range.name,
					kind,
					getVariableOrigins(range.name),
					kind.state === "runtime" ? undefined : editHint()
				);

				return {
					range: {
						startLineNumber: position.lineNumber,
						endLineNumber: position.lineNumber,
						startColumn: range.startColumn,
						endColumn: range.endColumn,
					},
					contents: contents.map((value) => ({ value })),
				};
			},
		};

		const disposables = BODY_LANGUAGES.map((language) =>
			monaco.languages.registerHoverProvider(language, provider)
		);
		return () => disposables.forEach((d) => d.dispose());
	}, [monaco, getAllVariables, getVariableOrigins, dataColumns]);
}
