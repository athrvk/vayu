/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Code section's resolved input: `POST /compose` of the request the tab
 * shows, from the editor when a builder holds it (#2638).
 *
 * The editor's body is built by `buildComposeBody` with the inputs Send gives
 * it (the draft, the builder's collection chain, the request as owner and its
 * collection), so the snippet is the request Send would put on the wire, edits
 * not yet autosaved included. With no builder holding the request (one still
 * mounting) it composes the
 * saved row by id and says so, because that snippet trails the editor.
 *
 * It is also the one composition the "Sends" line and the tab title read
 * (#2741): they never call `/compose` themselves, they share this query's cache
 * entry for `deferredVariables` - the engine's answer to "does a pre-request
 * script run before this send", which the renderer must not re-derive.
 */

import { queryOptions, useQuery } from "@tanstack/react-query";
import { apiService } from "@/services/api";
import { queryKeys } from "@/queries/keys";
import { useSessionStore } from "@/stores";
import {
	editorDraftFor,
	useLiveCommandSurfaceStore,
	type EditorDraft,
} from "@/lib/commands/live-surfaces";
import { buildComposeBody } from "@/modules/request-builder/utils/compose-body";
import type { RequestState } from "@/modules/request-builder/types";
import type { ComposedRequest, ComposeRequestRequest } from "@/types";

/**
 * The execution settings the snippet reads beside the composed payload, which
 * `POST /compose` does not carry (see `CodeSection` on `stream`).
 */
export type SnippetSettings = Pick<RequestState, "stream" | "disableCookies">;

export interface CodeComposition {
	payload: ComposedRequest;
	/**
	 * The names a pre-request script runs before, which the payload still holds
	 * as `{{name}}` (#2521). Empty when nothing was deferred.
	 */
	deferredVariables: string[];
	/** The draft's settings when the editor was composed; null for the saved row. */
	editorSettings: SnippetSettings | null;
}

function compositionOf(
	payload: ComposedRequest,
	editorSettings: SnippetSettings | null
): CodeComposition {
	return { payload, deferredVariables: payload.deferredVariables ?? [], editorSettings };
}

/** The compose body for @p draft - the one Send builds for the same draft. */
export function editorComposeBody(
	draft: EditorDraft,
	requestId: string,
	environmentId: string | null
): ComposeRequestRequest {
	return buildComposeBody({
		request: draft.request,
		// Send's own filter (#3066): the snippet omits what Send leaves out.
		elements: {
			chain: draft.ancestors,
			ownerId: requestId,
			onlyRunnable: { kinds: draft.elementKinds },
		},
		collectionId: draft.request.collectionId ?? undefined,
		environmentId,
	}).body;
}

export async function composeForCode(
	requestId: string,
	environmentId: string | null
): Promise<CodeComposition> {
	const draft = editorDraftFor(requestId);
	if (!draft) {
		const payload = await apiService.composeRequest({
			requestId,
			...(environmentId ? { environmentId } : {}),
		});
		return compositionOf(payload, null);
	}
	const payload = await apiService.composeRequest(
		editorComposeBody(draft, requestId, environmentId)
	);
	const { stream, disableCookies } = draft.request;
	return compositionOf(payload, { stream, disableCookies });
}

/**
 * The key's "editor or saved" half: whether a builder holds @p requestId.
 * Flips when a builder takes the request on or lets it go, not per keystroke -
 * the slot is rewritten only when the builder's request id changes.
 */
export function useEditorHeld(requestId: string): boolean {
	return useLiveCommandSurfaceStore((s) => !!requestId && s.editorDraft?.requestId === requestId);
}

/**
 * The composition query, shared by every reader of one request's entry. The
 * options carry what must agree across readers - the key and the cost policy -
 * and each reader adds its own `enabled` and mount behaviour.
 *
 * `staleTime: Infinity`: a compose is a round trip, and a reader would
 * otherwise pay one per keystroke behind it (#1310). An entry is refreshed by
 * an explicit act instead - the Code section's refresh button, or an
 * invalidation from a committed write, the renderer's own PUT or an MCP
 * agent's, to this request, its collection chain, an environment or the globals
 * (`invalidateCompositions`, #1438, #1877). `invalidateQueries` refetches a
 * mounted, enabled observer whatever its `staleTime`, so this value gates the
 * cost without gating correctness.
 */
export function compositionOptions(
	requestId: string,
	environmentId: string | null,
	editorHeld: boolean
) {
	return queryOptions({
		queryKey: queryKeys.compose.forRequest(
			requestId,
			environmentId,
			editorHeld ? "editor" : "saved"
		),
		queryFn: () => composeForCode(requestId, environmentId),
		staleTime: Infinity,
		retry: false,
	});
}

const NO_NAMES: readonly string[] = [];

/**
 * The names the engine left written for a pre-request script to set at send
 * (#2521), for the request @p requestId - empty until the composition lands,
 * and for a request with no id (an unsaved draft has nothing to compose by).
 *
 * @p enabled is the caller's reason to pay for a compose at all; the "Sends"
 * line asks only when its URL holds a `{{` token, so a literal URL costs
 * nothing (#1310). The mount behaviour is the default: a tab switch back to a
 * cached entry does not refetch it.
 */
export function useDeferredVariables(requestId: string, enabled: boolean): readonly string[] {
	const environmentId = useSessionStore((s) => s.activeEnvironmentId);
	const editorHeld = useEditorHeld(requestId);
	const { data } = useQuery({
		...compositionOptions(requestId, environmentId, editorHeld),
		enabled: enabled && !!requestId,
	});
	return data?.deferredVariables ?? NO_NAMES;
}
