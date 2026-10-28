/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `Content type` column of a `form-data` row (#3022).
 *
 * A multipart server can require a part to carry its own `Content-Type`:
 * Salesforce's ContentVersion insert wants `entity_content` as
 * `application/json` beside the file part. The engine sends a row's
 * `contentType` as that part's header, on a text part as well as a file part;
 * until this column only an import or a curl paste could set it.
 *
 * Empty is the old behaviour, so clearing the field drops the member rather
 * than storing "": a text part then sends no `Content-Type` line, and a file
 * part's type is derived by the engine from the file.
 */

import type { KeyValueItem, KeyValueRowExtra, VariableSupport } from "@/types";
import VariableInput from "../VariableInput";

/** The header-band label of the column. */
export const CONTENT_TYPE_HEADER = "Content type";

/** `item` with its part type set to `value`, or without one when `value` is empty. */
export function withContentType(item: KeyValueItem, value: string): KeyValueItem {
	const { contentType: _previous, ...rest } = item;
	return value === "" ? rest : { ...rest, contentType: value };
}

/** The column's `rowExtra`, bound to the table's variable scope. */
export function contentTypeExtra(variables?: VariableSupport): KeyValueRowExtra {
	return {
		header: CONTENT_TYPE_HEADER,
		render: (item, { replaceItem, disabled }) => (
			<VariableInput
				value={item.contentType ?? ""}
				onChange={(value) => replaceItem(withContentType(item, value))}
				placeholder={item.type === "file" ? "Auto" : "None"}
				disabled={disabled}
				variables={variables}
				size="sm"
				aria-label={`Content type of ${item.key || "this part"}`}
			/>
		),
	};
}
