/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// UI State Types
// Cross-cutting UI types shared across components, hooks, and the Electron
// preload contract. View/navigation state now lives with its owning store
// (DrawerView in layout-store, TabType in tabs-store).

import type { ResolvedVariable, VariableOrigin, VariableScope } from "./domain";

/** App theme preference. `system` follows the OS via Electron's nativeTheme. */
export type ThemeSource = "system" | "light" | "dark";

/**
 * Accent color scheme, applied via the `data-color-scheme` attribute.
 * Re-exported from the single source of truth in `@/constants/color-schemes`.
 */
export type { ColorScheme } from "@/constants/color-schemes";

/**
 * The variable scope a variable-aware input is editing inside, handed in rather
 * than reached for.
 *
 * `VariableInput` and the key/value table used to call
 * `useRequestBuilderContext()` in their bodies, and that hook *throws* with no
 * `RequestBuilderProvider` above it - so the app's densest table could not
 * render anywhere but the request builder, and every other surface that wanted
 * key/value rows hand-rolled its own (issue #564). A hand-rolled copy never
 * receives the primitive's fixes.
 *
 * Optional at every consumer, and its absence is a real state rather than a
 * degraded one: a surface with no variable scope - an inbox's canned reply
 * headers, say - has nothing to resolve, nothing to autocomplete and no
 * definition to edit, so the field is a plain text field. The members travel
 * together because they are one concept - the variable scope - and each is
 * meaningless without the rest: without `getAllVariables` there are no tokens
 * to render, and a token with no `updateVariable` offers an edit that goes
 * nowhere.
 */
export interface VariableSupport {
	/** `{{name}}` substituted, for a preview of what will actually be sent. */
	resolveString: (input: string) => string;
	/** Every name in scope, for token rendering and the `{{` autocomplete. */
	getAllVariables: () => Record<string, ResolvedVariable>;
	/** Every definition of a name, winner and losers alike. Display-only. */
	getVariableOrigins: (name: string) => VariableOrigin[];
	/** Write a new value for a name, from a token's edit popover. */
	updateVariable: (name: string, value: string, scope: VariableScope) => void;
	/**
	 * The scopes `updateVariable` can actually write to right now, so the
	 * popover's scope picker cannot offer a target that does not exist.
	 */
	writableScopes: VariableScope[];
}
