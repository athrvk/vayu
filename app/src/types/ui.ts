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

import type { ReactNode } from "react";
import type { BoundField, DataFieldContext } from "@/lib/data-bind-escaping";
import type {
	DataContractScope,
	FormFieldEntry,
	ResolvedVariable,
	VariableOrigin,
	VariableScope,
} from "./domain";

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
	/**
	 * `{{name}}` substituted, for a preview of what will actually be sent: a
	 * picked row's cell written for the field's @p context as the send's bind
	 * writes it, and why the send would refuse the row (issue #2639).
	 */
	resolveField: (input: string, context?: DataFieldContext) => BoundField;
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
	/**
	 * The data contract in scope, when the chain declares one (issue #600).
	 *
	 * Optional, and unlike the members above it is optional *within* a scope
	 * rather than with it: most collections declare no contract, and a field in
	 * one is still fully variable-aware. Absent therefore means "nothing
	 * declared", which is the state phase 1 left every `{{data.*}}` token in -
	 * so a consumer that never sets it behaves exactly as it did (the #564
	 * prop-thread contract holds).
	 *
	 * It sits here rather than being looked up per token because the lookup is a
	 * chain walk against the collections cache, and the tokens are rendered
	 * inside a `memo`-wrapped row that must not re-run one per keystroke.
	 */
	dataColumns?: DataContractScope;
	/**
	 * Hides every secret variable's value in a text a surface displays, so the
	 * key/value Σ peek can show resolved text without printing a secret. Applied
	 * to what is drawn, never to what is cached or sent.
	 *
	 * Optional: absent means the scope marks nothing secret (every consumer built
	 * before this member, and surfaces with no scope), and the text is shown as is.
	 */
	maskSecrets?: (text: string) => string;
	/**
	 * The names `POST /compose` left written because a pre-request script runs
	 * before the send (`deferredVariables`, #2521, #2741). A token naming one is
	 * not painted as the stored value it holds: that is not what will be sent.
	 *
	 * Only ever the engine's answer; the renderer has no rule of its own for
	 * which requests are scripted. Optional: absent (every scope with no request
	 * to compose, and every consumer built before this member) paints as it did.
	 */
	deferredVariables?: readonly string[];
}

/**
 * UI-layer extension of KeyValueEntry with a stable React key (`id`).
 * The `id` is ephemeral - it is NOT persisted to the backend.
 * Strip it with `toKeyValueEntries()` before sending to the API.
 *
 * It extends `FormFieldEntry` rather than `KeyValueEntry` because one table
 * serves params, headers and both form modes, and only `form-data` rows carry
 * the file members - all optional, so a header row is unchanged. The editor
 * only offers them where `allowFiles` says it may.
 *
 * It lives here, beside {@link VariableSupport}, rather than in
 * `modules/request-builder/types.ts`: it is the row model of a shared
 * primitive, and a primitive under `components/shared/` cannot take its own
 * props type from a feature module (issue #567).
 */
export interface KeyValueItem extends FormFieldEntry {
	id: string;
}

/** What a {@link KeyValueRowExtra} control is handed besides its row. */
export interface KeyValueRowExtraContext {
	/**
	 * Replaces the row with `next` (its `id` is kept). The table's own edits
	 * leave members it does not know about untouched, so a control that owns
	 * one writes the whole row: spread the row it was given, then set or drop
	 * its member.
	 */
	replaceItem: (next: KeyValueItem) => void;
	/** The row is off or the table read-only: the control should not take input. */
	disabled: boolean;
}

/**
 * A caller's own control in every row of the table, under a column of its own.
 *
 * `render` is a prop of the memo'd `KeyValueRow` (#1716), so the caller keeps
 * its identity stable (`useCallback`). The trailing spare row gets an empty
 * cell, not the control: it is dropped on save while blank, so a choice made
 * there would be lost.
 */
export interface KeyValueRowExtra {
	/** The column's header-band label. */
	header: string;
	render: (item: KeyValueItem, context: KeyValueRowExtraContext) => ReactNode;
}

/** Props of the shared key/value table (`components/shared/KeyValueEditor`). */
export interface KeyValueEditorProps {
	items: KeyValueItem[];
	onChange: (items: KeyValueItem[]) => void;
	keyPlaceholder?: string;
	valuePlaceholder?: string;
	showResolved?: boolean;
	allowDisable?: boolean;
	readOnly?: boolean;
	keySuggestions?: string[];
	/**
	 * Offer each row a file part (`form-data` only). Off everywhere else,
	 * because a header, a query param and a urlencoded field have no file form
	 * on the wire - the engine refuses one - so the affordance would promise
	 * something that cannot be sent.
	 */
	allowFiles?: boolean;
	/**
	 * A per-row control of the caller's own, with a column of its own. Omitted by
	 * every other table, which keeps the track it always had.
	 */
	rowExtra?: KeyValueRowExtra;
	/**
	 * The variable scope the table edits inside, handed in by whoever mounts it.
	 *
	 * Omitted where there is none - the inbox's canned reply headers, say - and
	 * the table then resolves nothing, shows no `ResolvedPeek` and offers no
	 * `{{` autocomplete. That is the correct reading of a surface with no
	 * variables, not a degraded one. It is a prop rather than a context read
	 * because the hook that used to supply it *throws* outside
	 * `RequestBuilderProvider`, which made this table structurally unusable
	 * anywhere else (#564).
	 */
	variables?: VariableSupport;
	/**
	 * What kind of field every key and value is, for the bind a picked row's
	 * preview shows: `header` for the Headers table, `plain` (the default) for
	 * the rest, as the engine's bind treats them.
	 */
	fieldContext?: DataFieldContext;
	canEdit?: (item: KeyValueItem, field: keyof KeyValueItem) => boolean;
	canRemove?: (item: KeyValueItem) => boolean;
	canDisable?: (item: KeyValueItem) => boolean;
}
