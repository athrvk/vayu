/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ParamsPanel Component
 *
 * Query parameters, kept in step with the URL in the bar above.
 *
 * The bulk-edit machinery that used to be duplicated here and in `HeadersPanel`
 * is now `BulkEditor`; only the format differs, and that is what this passes.
 */

import { useCallback } from "react";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { BulkEditor } from "../../../shared/BulkEditor";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import type { KeyValueItem } from "@/types";
import { formatParamsToText, parseParamsFromText } from "../../../utils/params-format";
import { buildUrlWithParams } from "../../../utils/url";
import { EmptyTableHint } from "./EmptyTableHint";

export default function ParamsPanel() {
	const { request, updateField, resolveString } = useRequestBuilderContext();
	const variables = useVariableSupport();

	// Handle params change and sync to URL
	const handleParamsChange = useCallback(
		(newParams: KeyValueItem[]) => {
			// Filter out any system headers that shouldn't be in params (separation of concerns)
			const filteredParams = newParams.filter((param) => !param.system);

			updateField("params", filteredParams);

			// Sync to URL
			const newUrl = buildUrlWithParams(request.url, filteredParams);
			updateField("url", newUrl);
		},
		[request.url, updateField]
	);

	const resolvedUrl = resolveString(request.url);
	const displayParams = request.params.filter((param) => !param.system);

	return (
		<BulkEditor
			label="Query Parameters"
			format={() => formatParamsToText(request.params)}
			// Parsed here rather than in BulkEditor, because applying params also
			// means rewriting the URL - a params rule, not a bulk-edit one.
			onCommit={(text) => handleParamsChange(parseParamsFromText(text))}
			placeholder={"page=1\nlimit=10\nsort=name"}
			hint={
				/* Params keep `=` alone - a query string is written `k=v`, and a
				   value routinely contains a colon (`redirect=https://…`). Only the
				   Headers editor accepts both separators. Repeated keys are all
				   sent, joined with `&`, which is how an array parameter is
				   expressed. */
				<>
					<code className="bg-muted px-1 rounded-md">key=value</code>, one per line. A
					line with no <code className="bg-muted px-1 rounded-md">=</code> splits at{" "}
					<code className="bg-muted px-1 rounded-md">:</code>, and a bare key sends a
					valueless parameter. Repeated keys are kept and all sent.
				</>
			}
			tableHeader={
				<EmptyTableHint items={displayParams} noun="parameters">
					Add query parameters to send with this request.
				</EmptyTableHint>
			}
		>
			<div className="space-y-3">
				<KeyValueEditor
					items={displayParams}
					onChange={handleParamsChange}
					keyPlaceholder="Parameter"
					valuePlaceholder="Value"
					showResolved={true}
					allowDisable={true}
					variables={variables}
				/>

				{/*
				 * The resolved URL, on one line.
				 *
				 * Not redundant with the bar above, which is the thing worth being
				 * careful about: the bar shows the URL *with* its `{{variables}}`,
				 * this shows what will actually be sent. It was a `p-3` slab under a
				 * 13px label - two rows of chrome for one line of text - in a tab
				 * whose table is now 36px per row. It is a labelled line now.
				 */}
				<div className="flex items-baseline gap-2 text-xs">
					<span className="shrink-0 uppercase tracking-wide text-subtle-foreground">
						Sends
					</span>
					<span className="min-w-0 flex-1 break-all font-mono text-muted-foreground">
						{resolvedUrl || <span className="italic">No URL</span>}
					</span>
				</div>
			</div>
		</BulkEditor>
	);
}
