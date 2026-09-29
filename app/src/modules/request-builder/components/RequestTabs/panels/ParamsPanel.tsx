/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ParamsPanel Component
 *
 * Query parameters, kept in step with the URL in the bar above, and under them
 * the path variables (issue #1764): one row per `:name` segment of the URL.
 *
 * The two tables edit one `params` array, split by `in`, so each writes its
 * own half back beside the other's untouched. Path rows take their keys from
 * the URL, so their table locks the key and offers no remove - a row comes and
 * goes with its segment (`syncPathRows`). They are outside bulk edit for the
 * same reason, and the table stays visible in both modes.
 *
 * The bulk-edit machinery that used to be duplicated here and in `HeadersPanel`
 * is now `BulkEditor`; only the format differs, and that is what this passes.
 */

import { useCallback } from "react";
import { useRequestBuilderContext } from "../../../context";
import { createStableResolve } from "@/lib/dynamic-variable-cache";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { Eyebrow } from "@/components/ui";
import { BulkEditor } from "../../../shared/BulkEditor";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import type { KeyValueItem } from "@/types";
import {
	formatParamsToText,
	parseParamsFromText,
	isNoOpParamsEdit,
} from "../../../utils/params-format";
import { buildUrlWithParams } from "../../../utils/url";
import {
	isPathRow,
	pathRowsOf,
	queryRowsOf,
	substitutePathVariables,
} from "../../../utils/path-variables";
import { EmptyTableHint } from "./EmptyTableHint";

/*
 * The "Sends" line's resolved URL, cached across this panel's own unmount.
 *
 * A `useMemo` here would be worthless: this tab is not force-mounted
 * (`RequestTabs/index.tsx` force-mounts Body and Elements only), so Params →
 * Headers → Params destroys the component and builds a new one, and a first
 * render has no previous value to memoize against - a `{{$randomInt}}` in the
 * URL rerolled on every round trip through another tab. See
 * `lib/dynamic-variable-cache.ts` for why this is module scope and why it is
 * keyed by request id rather than by the URL text.
 */
const stableResolvedUrl = createStableResolve();

// Module constants for the path table's gates: `KeyValueEditor` keeps its
// callbacks stable only while these are (issue #1716).
const PATH_KEY_LOCKED = (_item: KeyValueItem, field: keyof KeyValueItem) => field !== "key";
const PATH_NOT_REMOVABLE = () => false;

export default function ParamsPanel() {
	const { request, updateField, resolveString } = useRequestBuilderContext();
	const variables = useVariableSupport();

	const pathParams = pathRowsOf(request.params);

	// The query table's rows, written back beside the path rows it never shows,
	// and the URL's query rebuilt from them. `buildUrlWithParams` skips path
	// rows itself, so the `:name` segments are left as they are.
	const handleParamsChange = useCallback(
		(newParams: KeyValueItem[]) => {
			// Filter out any system headers that shouldn't be in params (separation of concerns)
			const queryParams = newParams.filter((param) => !param.system && !isPathRow(param));
			const params = [...queryParams, ...pathRowsOf(request.params)];

			updateField("params", params);
			updateField("url", buildUrlWithParams(request.url, params));
		},
		[request.url, request.params, updateField]
	);

	// Values only: the URL does not change, because a path row's value goes into
	// its segment at send time, never into the URL text. The editor appends its
	// trailing blank row on every change; it is not a path row and is dropped.
	const handlePathParamsChange = useCallback(
		(newPathParams: KeyValueItem[]) => {
			updateField("params", [
				...queryRowsOf(request.params),
				...newPathParams.filter(isPathRow),
			]);
		},
		[request.params, updateField]
	);

	// Not called inline: a dynamic variable like `{{$randomInt}}` generates a
	// fresh value on every call (`lib/dynamic-variables.ts`'s own contract), and
	// this panel both re-renders and *remounts* on far more than a URL edit, so
	// the line read as changing on its own rather than describing one resolved
	// URL. A request with no id yet shares one entry: an unsaved draft has
	// nothing else stable to key on, and the only cost is two blank new tabs
	// previewing the same generated value.
	// Path values go in first, as the engine composes them: before `{{}}`
	// resolution, so a `{{var}}` held in a value still resolves.
	const resolvedUrl = stableResolvedUrl(
		request.id ?? "new",
		substitutePathVariables(request.url, pathParams),
		resolveString
	);
	const displayParams = queryRowsOf(request.params).filter((param) => !param.system);

	return (
		<BulkEditor
			label="Query parameters"
			format={() => formatParamsToText(request.params)}
			// Parsed here rather than in BulkEditor, because applying params also
			// means rewriting the URL - a params rule, not a bulk-edit one. A commit
			// that changes nothing is skipped outright, so opening the editor and
			// switching straight back cannot re-enable a disabled row (issue #1480).
			onCommit={(text) => {
				if (isNoOpParamsEdit(text, request.params)) return;
				handleParamsChange(parseParamsFromText(text));
			}}
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
					valueless parameter. Repeated keys are kept and all sent. A leading{" "}
					<code className="bg-muted px-1 rounded-md">// </code> disables the row;
					everything after the separator's first space is sent exactly as typed.
				</>
			}
			tableHeader={
				<EmptyTableHint items={displayParams} noun="parameters">
					Add query parameters to send with this request.
				</EmptyTableHint>
			}
			/*
			 * The resolved URL, on one line, in both modes - not just the table's.
			 * It was a `p-3` slab under a 13px label - two rows of chrome for one
			 * line of text - in a tab whose table is now 36px per row. It is a
			 * labelled line now, and it stays visible while bulk-editing because
			 * that is exactly when a pasted block of params most wants checking
			 * against the URL it will produce - not redundant with the bar above,
			 * which shows the URL *with* its `{{variables}}` rather than resolved.
			 */
			after={
				<>
					{pathParams.length > 0 && (
						<section aria-labelledby="params-path-variables" className="space-y-1.5">
							<Eyebrow>
								<span id="params-path-variables">Path variables</span>
							</Eyebrow>
							<KeyValueEditor
								items={pathParams}
								onChange={handlePathParamsChange}
								keyPlaceholder="Variable"
								valuePlaceholder="Value"
								showResolved={true}
								allowDisable={true}
								variables={variables}
								canEdit={PATH_KEY_LOCKED}
								canRemove={PATH_NOT_REMOVABLE}
							/>
						</section>
					)}
					<div className="flex items-baseline gap-2 text-xs">
						<span className="shrink-0 uppercase tracking-wide text-subtle-foreground">
							Sends
						</span>
						<span className="min-w-0 flex-1 break-all font-mono text-muted-foreground">
							{resolvedUrl || <span className="italic">No URL</span>}
						</span>
					</div>
				</>
			}
		>
			<KeyValueEditor
				items={displayParams}
				onChange={handleParamsChange}
				keyPlaceholder="Parameter"
				valuePlaceholder="Value"
				showResolved={true}
				allowDisable={true}
				variables={variables}
			/>
		</BulkEditor>
	);
}
