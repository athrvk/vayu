/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Query parameters, in step with the URL bar, and under them the path variables (#1764): one row
 * per `:name` segment, plus any declared path row the URL does not use. Both tables edit one
 * `params` array split by `in`, each writing its half beside the other's. Path rows take their keys
 * from the URL, so their table locks the key and offers no remove (a row comes and goes with its
 * segment, `syncPathRows`); for the same reason they are outside bulk edit and the table shows in
 * both modes. Bulk edit is `BulkEditor`; this passes the format.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCollectionAncestors } from "@/queries/collections";
import { useRequestBuilderContext } from "../../../context";
import { createStableResolve } from "@/lib/dynamic-variable-cache";
import KeyValueEditor from "@/components/shared/KeyValueEditor";
import { withTrailingBlank } from "@/components/shared/KeyValueEditor/key-value";
import { Eyebrow } from "@/components/ui";
import { BulkEditor } from "../../../shared/BulkEditor";
import { useVariableSupport } from "../../../hooks/useVariableSupport";
import type { KeyValueItem } from "@/types";
import { formatParamsToText } from "../../../utils/params-format";
import { bulkTextPatch, queryTablePatch } from "../../../utils/bulk-drafts";
import { resolveAuthForSend } from "../../../utils/auth-resolution";
import { displayPathRows, isPathRow, pathRowsOf, queryRowsOf } from "../../../utils/path-variables";
import {
	deferredNamesInSends,
	sendsCacheInput,
	sendsHasTokens,
	sendsResolver,
	type SendsResolved,
} from "../../../utils/sends-url";
import { useDeferredVariables } from "@/components/layout/context-bar/code-composition";
import { deferredNote } from "@/lib/deferred-note";
import { containsVariableToken } from "@/constants/variables";
import {
	SECRET_UI_MASK,
	authSecrets,
	collectSecrets,
	createSecretMasker,
} from "@/services/codegen";
import { EmptyTableHint } from "./EmptyTableHint";

/*
 * The "Sends" line's resolved URL, cached across this panel's unmount. A `useMemo` is useless: this
 * tab is not force-mounted (`RequestTabs/index.tsx` force-mounts Body and Elements), so Params →
 * Headers → Params builds a new component with nothing to memoize against, and a `{{$randomInt}}`
 * in the URL rerolled per round trip. `lib/dynamic-variable-cache.ts` says why module scope and why
 * keyed by request id, not URL text.
 */
const stableResolvedUrl = createStableResolve<SendsResolved>();

// Module constants: `KeyValueEditor` keeps its callbacks stable only while these are (#1716).
const PATH_KEY_LOCKED = (_item: KeyValueItem, field: keyof KeyValueItem) => field !== "key";
const PATH_NOT_REMOVABLE = () => false;

export default function ParamsPanel() {
	const {
		request,
		updateField,
		resolveString,
		getAllVariables,
		bulkDrafts,
		setBulkDraft,
		commitBulkDraft,
	} = useRequestBuilderContext();
	const draft = bulkDrafts.params ?? null;
	const variables = useVariableSupport();

	// Derived, never written by rendering: an unanswered `:name` still gets a row, stored on the
	// first edit, so opening a request does not mark it edited.
	const pathParams = displayPathRows(pathRowsOf(request.params), request.url);

	// The callbacks read the request through a ref, so their identity survives a keystroke
	// rewriting `request.params`; listing it in deps handed `KeyValueEditor` a new `onChange` per
	// character and re-rendered every row (#1716).
	const latest = useRef({
		params: request.params,
		url: request.url,
		disableUrlEncoding: request.disableUrlEncoding,
	});
	useEffect(() => {
		latest.current = {
			params: request.params,
			url: request.url,
			disableUrlEncoding: request.disableUrlEncoding,
		};
	}, [request.params, request.url, request.disableUrlEncoding]);

	// The same rule a params draft commits by (`queryTablePatch`).
	const handleParamsChange = useCallback(
		(newParams: KeyValueItem[]) => {
			const { params, url } = queryTablePatch(latest.current, newParams);
			updateField("params", params);
			updateField("url", url);
		},
		[updateField]
	);

	// Values only: the URL text does not change, as a path value fills its segment at send time.
	// The editor's appended blank row is not a path row and is dropped.
	const handlePathParamsChange = useCallback(
		(newPathParams: KeyValueItem[]) => {
			updateField("params", [
				...queryRowsOf(latest.current.params),
				...newPathParams.filter(isPathRow),
			]);
		},
		[updateField]
	);

	// Not called inline: `{{$randomInt}}`-style variables change on every call
	// (`lib/dynamic-variables.ts`), and this panel re-renders and *remounts* on far more than URL
	// edits, so the line seemed to change on its own. A request with no id shares one entry
	// (nothing else is stable; two blank tabs preview one value). What it resolves is
	// `utils/sends-url.ts`'s, shared with the tab title, so they agree on path rows and encoding.
	//
	// A name a pre-request script sets at send is the engine's to name (`POST /compose`'s
	// `deferredVariables`, from the Code section's cache entry) and is drawn as written (#2741).
	// Only a URL with a `{{token}}` asks, so a literal one never pays a compose.
	//
	// The auth is the effective one, `inherit` walked: a key a collection places in the query is on
	// the wire, so it is on the line, masked below (#3425). So is a query-placed OAuth 2.0 token (a
	// stand-in, as it is fetched at send) and a GraphQL GET's document, sent as query parameters
	// (#3437); method and body tell those apart. An open draft is what Send commits, so the line
	// describes it.
	const ancestors = useCollectionAncestors(request.collectionId);
	const auth = resolveAuthForSend(request.auth, ancestors);
	const drafted = draft ? bulkTextPatch(request, "params", draft.text) : null;
	const sends = {
		url: drafted?.url ?? request.url,
		params: drafted?.params ?? request.params,
		disableUrlEncoding: request.disableUrlEncoding,
		auth,
		method: request.method,
		body: { mode: request.bodyMode, content: request.body },
	};
	const engineDeferred = useDeferredVariables(request.id ?? "", sendsHasTokens(sends));
	const deferred = deferredNamesInSends(sends, engineDeferred);
	const { url: resolvedUrl, secret: appendedKey } = stableResolvedUrl(
		request.id ?? "new",
		sendsCacheInput(sends, deferred),
		sendsResolver(resolveString)
	);
	// Masked here, after the cache: the cache keeps the resolved URL (a `{{$randomInt}}` stays as
	// rolled) and only what is drawn is hidden. The appended key is masked as sent, not
	// re-resolved. The auth as written covers a literal credential; a `{{token}}` is a template,
	// not a secret, so it stays out and an unset or deferred name shows as the text going out.
	const secrets = [
		...collectSecrets(getAllVariables(), undefined),
		...authSecrets(auth).filter((text) => !containsVariableToken(text)),
		...(appendedKey === null ? [] : [appendedKey]),
	];
	const sendsText = createSecretMasker(secrets, true, undefined, SECRET_UI_MASK).apply(
		resolvedUrl
	);
	// The blank row is derived where rows render, as Headers does (`useHeadersManager`), since
	// `request.params` does not always carry it: a URL edit goes through `mergeParamsFromUrl`,
	// which drops the enabled blank row, so the tab lost its spare row until the next table edit
	// (#2155). Memoised so the blank row keeps one id, or focus would leave it per key.
	const displayParams = useMemo(
		() => withTrailingBlank(queryRowsOf(request.params)),
		[request.params]
	);

	return (
		<BulkEditor
			label="Query parameters"
			format={() => formatParamsToText(request.params)}
			draft={draft}
			onDraftChange={(next) => setBulkDraft("params", next)}
			onCommit={() => commitBulkDraft("params")}
			placeholder={"page=1\nlimit=10\nsort=name"}
			hint={
				/*
				 * Params keep `=` alone: a query is `k=v` and a value often has a colon
				 * (`redirect=https://…`); only Headers accepts both separators. Repeated keys are
				 * all sent, joined with `&`, as an array parameter is.
				 */
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
			 * The resolved URL on one line, in both modes. It stays visible while bulk-editing,
			 * since that is when a pasted block most wants checking against the URL it produces,
			 * and it is not the bar above, which shows `{{variables}}` unresolved.
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
						<span className="shrink-0 uppercase tracking-wide text-muted-foreground">
							Sends
						</span>
						<span className="min-w-0 flex-1 break-all font-mono text-muted-foreground">
							{sendsText || <span className="italic">No URL</span>}
						</span>
					</div>
					{deferred.length > 0 && (
						<p className="text-label text-muted-foreground m-0 break-words">
							{deferredNote(deferred)}
						</p>
					)}
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
