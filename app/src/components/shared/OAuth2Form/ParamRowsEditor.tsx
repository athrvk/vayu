/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One of an OAuth 2.0 config's extra request parameter lists
 * (`authorizationParams`, `tokenParams`, `refreshParams`, issue #2536) as the
 * app's key/value table.
 *
 * The table needs row ids and a trailing blank row that the stored list does
 * not carry, so the rows live here as `KeyValueItem`s and are written back as
 * `OAuth2ParamRow`s; an empty list is written back as `undefined`, so a config
 * that sets none stays as it was.
 *
 * The token and refresh lists (`sendAs`) give every row a "Send in" select,
 * because the engine sends each row in the body, the token URL's query or a
 * header (#2571). Body is an absent `sendAs`, so choosing it removes the member
 * and a config that never used the select is unchanged; choosing URL or Header
 * writes it. The authorization list has no select: the sign-in request carries
 * every row in its query. A row that is not touched keeps whatever `sendAs` it
 * arrived with, and the trailing spare row has no select (see `KeyValueRowExtra`).
 */

import { useCallback, useId, useMemo, useState } from "react";
import {
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui";
import type {
	KeyValueItem,
	KeyValueRowExtra,
	OAuth2ParamRow,
	OAuth2ParamSendAs,
	VariableSupport,
} from "@/types";
import KeyValueEditor from "../KeyValueEditor";
import { toKeyValueEntries, toKeyValueItems } from "../KeyValueEditor/key-value";

interface ParamRowsEditorProps {
	label: string;
	hint: string;
	rows: OAuth2ParamRow[] | undefined;
	onChange: (rows: OAuth2ParamRow[] | undefined) => void;
	variables?: VariableSupport;
	/** Offer the per-row "Send in" select: the token and refresh lists, not the authorization one. */
	sendAs?: boolean;
}

/** A row's `sendAs` rides the table's spreads without being on its row type. */
type ParamItem = KeyValueItem & { sendAs?: OAuth2ParamSendAs };

const SEND_IN_OPTIONS: ReadonlyArray<{ value: OAuth2ParamSendAs; label: string }> = [
	{ value: "body", label: "Body" },
	{ value: "url", label: "URL" },
	{ value: "header", label: "Header" },
];

/** The rows of a stored list; a malformed list or row reads as none. */
function storedRows(rows: unknown): OAuth2ParamRow[] {
	if (!Array.isArray(rows)) return [];
	return rows.filter((row): row is OAuth2ParamRow => typeof row === "object" && row !== null);
}

const toItems = (rows: OAuth2ParamRow[] | undefined): KeyValueItem[] =>
	toKeyValueItems(storedRows(rows).map((row) => ({ ...row, enabled: row.enabled !== false })));

function toRows(items: KeyValueItem[]): OAuth2ParamRow[] {
	return toKeyValueEntries(items).map((entry) => {
		// Not on the table's row type: it rides through the table's spreads untouched.
		const { sendAs } = entry as { sendAs?: OAuth2ParamSendAs };
		return {
			key: entry.key,
			value: entry.value,
			enabled: entry.enabled,
			...(sendAs !== undefined && { sendAs }),
		};
	});
}

/**
 * Whether two lists say the same thing. Field by field rather than by
 * serialising: the engine hands rows back with their members in another order,
 * and a mismatch here rebuilds the table's row ids under the cursor.
 */
function sameRows(a: OAuth2ParamRow[] | undefined, b: OAuth2ParamRow[] | undefined): boolean {
	const left = storedRows(a);
	const right = storedRows(b);
	return (
		left.length === right.length &&
		left.every(
			(row, i) =>
				row.key === right[i].key &&
				row.value === right[i].value &&
				(row.enabled !== false) === (right[i].enabled !== false) &&
				row.sendAs === right[i].sendAs
		)
	);
}

/** `item` sent in `target`: Body drops the member, so it stays the absent default. */
function withSendAs(item: ParamItem, target: OAuth2ParamSendAs): ParamItem {
	const { sendAs: _previous, ...rest } = item;
	return target === "body" ? rest : { ...rest, sendAs: target };
}

export default function ParamRowsEditor({
	label,
	hint,
	rows,
	onChange,
	variables,
	sendAs = false,
}: ParamRowsEditorProps) {
	const labelId = useId();
	const [held, setHeld] = useState(() => ({ items: toItems(rows), source: rows }));

	// The list changed from outside (another request, a save's reply that
	// differs): rebuild the table from it. An edit made here comes back equal.
	let { items } = held;
	if (!sameRows(rows, held.source)) {
		items = toItems(rows);
		setHeld({ items, source: rows });
	}

	const handleChange = (next: KeyValueItem[]) => {
		const written = toRows(next);
		setHeld({ items: next, source: written });
		onChange(written.length > 0 ? written : undefined);
	};

	// Stable across renders: `KeyValueRow` is memo'd (#1716) and takes it as a prop.
	const renderSendIn: KeyValueRowExtra["render"] = useCallback(
		(item, { replaceItem, disabled }) => (
			<Select
				value={(item as ParamItem).sendAs ?? "body"}
				onValueChange={(target: OAuth2ParamSendAs) =>
					replaceItem(withSendAs(item as ParamItem, target))
				}
				disabled={disabled}
			>
				<SelectTrigger
					className="h-control-sm text-xs"
					aria-label={`Send ${item.key || "this parameter"} in`}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{SEND_IN_OPTIONS.map(({ value, label }) => (
						<SelectItem key={value} value={value}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		),
		[]
	);
	const rowExtra = useMemo(
		() => (sendAs ? { header: "Send in", render: renderSendIn } : undefined),
		[sendAs, renderSendIn]
	);

	return (
		<div role="group" aria-labelledby={labelId} className="space-y-1.5">
			<Label id={labelId}>{label}</Label>
			<KeyValueEditor
				items={items}
				onChange={handleChange}
				keyPlaceholder="Parameter"
				valuePlaceholder="Value"
				variables={variables}
				rowExtra={rowExtra}
			/>
			<p className="text-label text-muted-foreground">{hint}</p>
		</div>
	);
}
