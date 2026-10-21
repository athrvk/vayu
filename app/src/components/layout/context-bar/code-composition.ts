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
 * mounting, a deleted request kept on screen for its draft) it composes the
 * saved row by id and says so, because that snippet trails the editor.
 */

import { apiService } from "@/services/api";
import { editorDraftFor, type EditorDraft } from "@/lib/commands/live-surfaces";
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
	/** The draft's settings when the editor was composed; null for the saved row. */
	editorSettings: SnippetSettings | null;
}

/** The compose body for @p draft - the one Send builds for the same draft. */
export function editorComposeBody(
	draft: EditorDraft,
	requestId: string,
	environmentId: string | null
): ComposeRequestRequest {
	return buildComposeBody({
		request: draft.request,
		elements: { chain: draft.ancestors, ownerId: requestId },
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
		return { payload, editorSettings: null };
	}
	const payload = await apiService.composeRequest(
		editorComposeBody(draft, requestId, environmentId)
	);
	const { stream, disableCookies } = draft.request;
	return { payload, editorSettings: { stream, disableCookies } };
}
