/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

// Cross-cutting UI types for components, hooks and the preload contract. View state lives with its
// store: `DrawerView` in layout-store, `TabType` in tabs-store.

import type { ReactNode } from "react";
import type { BoundField, DataFieldContext } from "@/lib/data-bind-escaping";
import type {
	DataContractScope,
	FormFieldEntry,
	ResolvedVariable,
	VariableCreateOptions,
	VariableOrigin,
	VariableScope,
} from "./domain";

/** App theme preference. `system` follows the OS via Electron's nativeTheme. */
export type ThemeSource = "system" | "light" | "dark";

/** Accent scheme, applied as the `data-color-scheme` attribute. */
export type { ColorScheme } from "@/constants/color-schemes";

/**
 * The variable scope a variable-aware input edits inside, handed in rather than reached for.
 * Optional at every consumer, and absent is a real state: a surface with no scope (an inbox's
 * canned reply headers) is a plain text field, with nothing to resolve, autocomplete or edit. The
 * members are one concept and travel together; each is meaningless without the rest.
 */
export interface VariableSupport {
	/**
	 * `{{name}}` substituted to preview what is sent: a picked row's cell bound for @p context the
	 * way the send's bind writes it, plus why the send would refuse the row (#2639).
	 */
	resolveField: (input: string, context?: DataFieldContext) => BoundField;
	/** Every name in scope, for token rendering and the `{{` autocomplete. */
	getAllVariables: () => Record<string, ResolvedVariable>;
	/** Every definition of a name, winner and losers alike. Display-only. */
	getVariableOrigins: (name: string) => VariableOrigin[];
	/**
	 * Writes a name's value from a token's edit popover. An edit passes the `sourceId` of the
	 * definition it showed, so the write lands there and not in the field's own collection; a
	 * create passes none (#3683) and may carry `options`, which an edit never does.
	 */
	updateVariable: (
		name: string,
		value: string,
		scope: VariableScope,
		sourceId?: string,
		options?: VariableCreateOptions
	) => void;
	/** Scopes `updateVariable` can write now, so the picker never offers a missing target. */
	writableScopes: VariableScope[];
	/**
	 * The data contract the chain declares (#600). Optional within a scope, not with it: most
	 * collections declare none. Absent means "nothing declared" for every `{{data.*}}` token, so a
	 * consumer that never sets it keeps the #564 prop-thread contract. Resolved once here, not per
	 * token: the lookup walks the chain against the collections cache, and tokens render inside a
	 * `memo` row that must not repeat it per keystroke.
	 */
	dataColumns?: DataContractScope;
	/**
	 * Hides every secret value in displayed text, so the key/value Σ peek shows resolved text
	 * without printing a secret. Applied to what is drawn, never to what is cached or sent. Absent:
	 * nothing is marked secret (no scope, or a consumer that sets none).
	 */
	maskSecrets?: (text: string) => string;
	/**
	 * Names `POST /compose` left written because a pre-request script runs first
	 * (`deferredVariables`, #2521, #2741). A token naming one is not painted with its stored value:
	 * that is not what is sent. Only the engine's answer; the renderer has no rule for which
	 * requests are scripted. Absent (nothing to compose, or a consumer that sets none) paints
	 * stored values.
	 */
	deferredVariables?: readonly string[];
}

/**
 * A table row with an ephemeral React key `id`, never persisted: strip it with
 * `toKeyValueEntries()` before an API call. It extends `FormFieldEntry`, not `KeyValueEntry`,
 * because one table serves params, headers and both form modes; the file members are optional and
 * offered only under `allowFiles`. It lives here, beside {@link VariableSupport}, and not in
 * `modules/request-builder/types.ts`: a `components/shared/` primitive cannot take its props type
 * from a feature module (#567).
 */
export interface KeyValueItem extends FormFieldEntry {
	id: string;
}

/** What a {@link KeyValueRowExtra} control is handed besides its row. */
export interface KeyValueRowExtraContext {
	/**
	 * Replaces the row with `next`, keeping its `id`. The table's edits leave members it does not
	 * know untouched, so a control owning one writes the whole row: spread it, then set or drop the
	 * member.
	 */
	replaceItem: (next: KeyValueItem) => void;
	/** The row is off or the table read-only: the control should not take input. */
	disabled: boolean;
}

/**
 * A caller's control in every row, under a column of its own. `render` is a prop of the memo'd
 * `KeyValueRow` (#1716): keep its identity stable (`useCallback`). The trailing spare row gets an
 * empty cell, because it is dropped on save while blank and a choice made there would be lost.
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
	 * Offer each row a file part, `form-data` only: a header, query param or urlencoded field has
	 * no file form on the wire and the engine refuses one.
	 */
	allowFiles?: boolean;
	/** A caller's per-row control in its own column; absent leaves the grid unchanged. */
	rowExtra?: KeyValueRowExtra;
	/**
	 * The variable scope, handed in by whoever mounts the table. Omitted where there is none (the
	 * inbox's canned reply headers): nothing resolves, no `ResolvedPeek`, no `{{` autocomplete,
	 * which is the correct reading of such a surface. A prop, not a context read, because
	 * `useRequestBuilderContext()` throws outside `RequestBuilderProvider` (#564).
	 */
	variables?: VariableSupport;
	/**
	 * Field kind of every key and value, for a picked row's bind preview: `header` for the Headers
	 * table, `plain` (the default) elsewhere, as the engine's bind treats them.
	 */
	fieldContext?: DataFieldContext;
	canEdit?: (item: KeyValueItem, field: keyof KeyValueItem) => boolean;
	canRemove?: (item: KeyValueItem) => boolean;
	canDisable?: (item: KeyValueItem) => boolean;
}
