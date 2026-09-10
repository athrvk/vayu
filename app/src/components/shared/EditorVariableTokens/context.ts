/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * What a Monaco editor needs to paint and open the `{{tokens}}` in its text.
 *
 * A context rather than a hook the editor calls for itself: `CodeEditor` is a
 * `components/ui` primitive mounted in a dozen places, and an editor with no
 * provider above it simply paints nothing - the settings preview and the
 * response viewers, which have no variable scope at all.
 *
 * `EditorVariableTokensProvider` takes a `VariableSupport` as a prop rather
 * than reaching for one itself, so the write path is whatever the mounting
 * tree actually has: `RequestBuilderProvider` and the collection `ElementsTab`
 * (issue #1220 script support) each build one from `useVariableResolver` +
 * `useVariableWriter` (issue #1651) - the same read/write pair either way, so
 * a token opens editable under both trees whenever its scope is writable.
 * `EditorVariableTokensValue.classify`'s `scriptHint` and the provider's
 * `writableScopes` gate are what tell an editable token from a read-only one
 * (a scope nothing currently writes to, or a script's bare, not-interpolated
 * `{{name}}`).
 */

import { createContext, useContext } from "react";
import type { ScriptTokenHint, VariableTokenKind } from "@/lib/variable-token-kind";
import type { VariableOrigin } from "@/types";

/** Where on screen a token sits, in viewport coordinates. */
export interface TokenAnchorRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface TokenEditRequest {
	/** The variable name, without braces. */
	name: string;
	/** The token's rectangle, so the popover opens over it. */
	rect: TokenAnchorRect;
	/** Put focus back where it came from - the editor that asked. */
	onClose?: () => void;
	/** How a script's span reads, if it is one - see `ScriptTokenHint`. */
	scriptHint?: ScriptTokenHint;
}

/** A token the pointer is resting on, for the shared tooltip to answer. */
export interface TokenHoverRequest {
	/** The variable name, without braces. */
	name: string;
	/** The token's rectangle, so the tooltip points at it. */
	rect: TokenAnchorRect;
	/** How a script's span reads, if it is one - see `ScriptTokenHint`. */
	scriptHint?: ScriptTokenHint;
}

export interface EditorVariableTokensValue {
	/**
	 * What a name is, in `resolveTemplate`'s order - or, with `scriptHint`, what
	 * a script's own accessor read, `replaceIn` template or bare mention says
	 * instead (`classifyScriptToken`).
	 */
	classify: (name: string, scriptHint?: ScriptTokenHint) => VariableTokenKind;
	/** Every definition of a name, for the popover's shadowed list. */
	getVariableOrigins: (name: string) => VariableOrigin[];
	/** Open the shared popover over a token. */
	openTokenEditor: (request: TokenEditRequest) => void;
	/**
	 * Show the shared tooltip over a token, or take it down with `null`.
	 *
	 * One tooltip for the whole subtree, like the popover beside it: an editor
	 * says which token the pointer is on and the provider draws the same card the
	 * single-line fields draw over theirs.
	 */
	setHoveredToken: (request: TokenHoverRequest | null) => void;
}

export const EditorVariableTokensContext = createContext<EditorVariableTokensValue | null>(null);

/**
 * The provider's value, or `null` where there is none.
 *
 * Null-tolerant on purpose - see the file comment. Every caller is expected to
 * handle the absence rather than the app throwing on an editor that is simply
 * not in a request builder.
 */
export function useEditorVariableTokensContext(): EditorVariableTokensValue | null {
	return useContext(EditorVariableTokensContext);
}
