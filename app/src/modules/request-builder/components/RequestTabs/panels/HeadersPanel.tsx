/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HeadersPanel Component
 *
 * The headers table, plus the text form of the same thing.
 *
 * The bulk-edit machinery - the mode flag, the draft text, the toggle handler,
 * the toolbar and the textarea - used to live here *and* in `ParamsPanel`, in
 * duplicate. It is `BulkEditor` now; only the format differs between the two,
 * and that is what this file passes.
 */

import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { BulkEditor } from "../../../shared/BulkEditor";
import type { KeyValueItem } from "@/types";
import { useHeadersManager } from "../../../hooks/useHeadersManager";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import { STANDARD_HEADERS } from "@/constants/http";
import { EmptyTableHint } from "./EmptyTableHint";

export default function HeadersPanel() {
	const { request, updateField } = useRequestBuilderContext();
	const variables = useVariableSupport();

	const {
		displayHeaders,
		handleHeadersChange,
		handleBulkEdit,
		formatForBulkEdit,
		canEdit,
		canRemove,
		canDisable,
	} = useHeadersManager({
		headers: request.headers,
		onUpdate: (newHeaders: KeyValueItem[]) => updateField("headers", newHeaders),
	});

	return (
		<BulkEditor
			label="Headers"
			format={formatForBulkEdit}
			// `handleBulkEdit` parses *and* re-imposes the managed system headers,
			// which is a headers rule rather than a bulk-edit one - so it stays
			// here and BulkEditor only ever handles text.
			onCommit={handleBulkEdit}
			placeholder={
				"User-Agent: MyApp/1.0\nAuthorization: Bearer token\nContent-Type: application/json"
			}
			hint={
				<>
					<code className="bg-muted px-1 rounded-md">Name: value</code>, one per line -{" "}
					<code className="bg-muted px-1 rounded-md">=</code> works too. Repeated names
					are kept as separate headers.
				</>
			}
			tableHeader={
				<EmptyTableHint items={displayHeaders} noun="headers">
					Add headers to send with this request.
				</EmptyTableHint>
			}
		>
			<KeyValueEditor
				items={displayHeaders}
				onChange={handleHeadersChange}
				keyPlaceholder="Header"
				valuePlaceholder="Value"
				showResolved={true}
				allowDisable={true}
				keySuggestions={STANDARD_HEADERS}
				variables={variables}
				canEdit={canEdit}
				canRemove={canRemove}
				canDisable={canDisable}
			/>
		</BulkEditor>
	);
}
