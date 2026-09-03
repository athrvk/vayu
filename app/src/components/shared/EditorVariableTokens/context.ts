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
 * `components/ui` primitive mounted in a dozen places, three of them outside any
 * request builder (the settings preview, the response viewers), and the write
 * path here belongs to `RequestBuilderProvider` - the one place that holds the
 * mutations `updateVariable` runs. An editor with no provider above it simply
 * paints nothing, which is exactly right for those three.
 */

import { createContext, useContext } from "react";
import type { VariableTokenKind } from "@/lib/variable-token-kind";
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
}

/** A token the pointer is resting on, for the shared tooltip to answer. */
export interface TokenHoverRequest {
	/** The variable name, without braces. */
	name: string;
	/** The token's rectangle, so the tooltip points at it. */
	rect: TokenAnchorRect;
}

export interface EditorVariableTokensValue {
	/** What a name is, in `resolveTemplate`'s order. */
	classify: (name: string) => VariableTokenKind;
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
