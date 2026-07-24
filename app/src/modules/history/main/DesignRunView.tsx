/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * DesignRunView
 *
 * A past design run, opened as an editable copy of the request that was sent.
 * Read it, change it, send it again. Nothing typed here reaches the saved
 * request unless the Save button below is used, and that asks first.
 *
 * ## Two things detach the copy, and neither is decoration
 *
 * **`id: null`** (set by `seedFromRun`) and **no `onSave`** below. Either alone
 * is sufficient today, which is deliberate belt-and-braces, so do not read one
 * as redundant and delete it:
 *
 * - `useSaveManager` early-returns on `!entityId` in both its autosave effect
 *   and `performSave`, so a null id stops the write even if an `onSave` exists.
 * - `RequestBuilderProvider` passes `enabled: !!onSave`, so no `onSave` stops it
 *   even if an id appears.
 *
 * A null id also keeps the response store - which is keyed by request id - from
 * being written to, and stops `useLastDesignRunQuery` from running.
 *
 * The absent prop looks like an oversight in the JSX below. It is not. The bug
 * this view exists to remove was opening the *saved request* in the builder:
 * that has both an id and an `onSave`, so changing a header to compare against
 * an old run rewrote the saved request seconds later.
 *
 * Guarded by "does not save when the URL is edited" in `DesignRunView.test.tsx`,
 * which fails when both gates are removed together.
 */

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { RequestBuilderProvider } from "@/modules/request-builder/context";
import RequestBuilderLayout from "@/modules/request-builder/components/RequestBuilderLayout";
import { useRequestQuery, useCollectionAncestors, isRequestNotFound, queryKeys } from "@/queries";
import { useEngine, useVariableResolver } from "@/hooks";
import { useSessionStore, useToastStore } from "@/stores";
import { Button, Badge } from "@/components/ui";
import { ErrorState } from "@/components/shared";
import type { RequestState, ResponseState } from "@/modules/request-builder/types";
import { resolveAuthForSend } from "@/modules/request-builder/utils/auth-resolution";
import { toFlatHeaders } from "@/modules/request-builder/utils/key-value";
import {
	buildExecBody,
	responseFromExecuteResult,
} from "@/modules/request-builder/utils/execute-mapping";
import { generateUUID } from "@/modules/request-builder/utils/id";
import { responseFromRunResult } from "@/modules/request-builder/utils/restore-response";
import { seedFromRun } from "./design-run-seed";
import SaveRunToRequestDialog from "./SaveRunToRequestDialog";
import type { Run, ScriptPart } from "@/types";

interface DesignRunViewProps {
	run: Run;
}

export default function DesignRunView({ run }: DesignRunViewProps) {
	const { executeRequest: engineExecuteRequest } = useEngine();
	const { activeEnvironmentId } = useSessionStore();
	const showToast = useToastStore((s) => s.showToast);
	const queryClient = useQueryClient();
	const [showSaveDialog, setShowSaveDialog] = useState(false);

	/*
	 * The live request, when it still exists. It is the only source of
	 * credentials - `sanitize_config_snapshot` strips auth down to its mode
	 * before storing a run - so the seed needs it to decide where headers and
	 * auth come from.
	 *
	 * Three outcomes, and all three have to be kept apart, because `seedFromRun`
	 * treats a falsy `liveRequest` as "the request was deleted" - it seeds the
	 * recorded wire headers, `Authorization` included, and `auth: { mode: "none" }`:
	 *
	 * - **still loading.** `data` is falsy but the answer is not in yet. Seeding
	 *   now bakes in the deleted-request seed, and the provider never corrects
	 *   it: its reset effect keys on `initialRequest?.id`, which is null before
	 *   and after. So the pane is held until the query settles. `isLoading` is
	 *   `isPending && isFetching`, so a run with no `requestId` disables the
	 *   query and settles at once rather than hanging on the spinner.
	 *
	 * - **settled, request gone.** A genuine deletion, thrown as
	 *   `RequestNotFoundError`. This is the orphan case that legitimately
	 *   replays the recorded headers, so it is the *only* error allowed to reach
	 *   `seedFromRun`'s request-gone branch.
	 *
	 * - **settled, lookup failed.** A transport failure throws something else.
	 *   Crucially `.catch(() => [])` on each per-collection list fetch
	 *   (`collections.ts`) means one swallowed transient failure surfaces as a
	 *   `RequestNotFoundError` too would be wrong - so we test for the sentinel
	 *   type, not just "there was an error". A non-sentinel error means the
	 *   request could not be fetched, and seeding a copy from it would be
	 *   guessing: show a retry instead.
	 */
	const {
		data: liveRequest,
		isLoading: isResolvingRequest,
		isError: requestLookupErrored,
		error: requestLookupError,
		refetch: refetchRequest,
	} = useRequestQuery(run.requestId ?? null);

	// A real deletion (the sentinel) is the orphan case and seeds normally; any
	// other settled error is a transport failure that must not seed at all.
	const requestLookupFailed = requestLookupErrored && !isRequestNotFound(requestLookupError);

	const collectionAncestors = useCollectionAncestors(liveRequest?.collectionId);
	const { resolveString, resolveObject } = useVariableResolver({
		collectionId: liveRequest?.collectionId || undefined,
	});

	const seed = useMemo(() => seedFromRun(run, liveRequest ?? null), [run, liveRequest]);

	/*
	 * Memoized because the provider reads it in an effect, not only in a
	 * `useState` initialiser - a fresh object each render would re-run that
	 * effect and reset the pane.
	 */
	const initialResponse = useMemo<ResponseState | null>(
		() => responseFromRunResult(run.result, run.id),
		[run]
	);

	/**
	 * Replay: the recorded collection parts, then the editor's own part.
	 *
	 * The collection parts go out exactly as they were stored, which is the
	 * point of a snapshot - it runs the collection's scripts as they were then,
	 * not as they read now.
	 *
	 * A run recorded before script parts existed has no parts at all, only the
	 * one glued string, and `seedFromRun` cannot fill the editor from it - so
	 * the editor is empty and the string is the only record of what ran. It is
	 * replayed as a single request-origin part. Dropping it (which is what
	 * happened while nothing read `legacyPreScript`) meant a resend of any
	 * pre-existing run silently executed no script at all.
	 */
	const replayParts = useCallback(
		(
			collectionParts: ScriptPart[],
			legacyScript: string | undefined,
			ownScript: string
		): ScriptPart[] | undefined => {
			const parts = [...collectionParts];
			if (legacyScript?.trim()) parts.push({ origin: "request", script: legacyScript });
			if (ownScript.trim()) parts.push({ origin: "request", script: ownScript });
			return parts.length > 0 ? parts : undefined;
		},
		[]
	);

	const handleExecute = useCallback(
		async (request: RequestState): Promise<ResponseState | null> => {
			try {
				const resolvedUrl = resolveString(request.url);

				const headersRecord = toFlatHeaders(request.headers);
				headersRecord["X-Request-ID"] = generateUUID();
				const version =
					typeof __VAYU_VERSION__ !== "undefined" ? __VAYU_VERSION__ : "0.1.1";
				headersRecord["X-Vayu-Version"] = version;

				const resolvedHeaders = Object.fromEntries(
					Object.entries(headersRecord).map(([key, value]) => [
						resolveString(key),
						resolveString(value),
					])
				);
				// Shared with the builder's own send path - see execute-mapping.ts
				const execBody = buildExecBody(request, resolveString);

				/*
				 * Auth is resolved fresh from the saved request, using the same
				 * helpers the builder uses - not a third copy of the rules.
				 * When the request is gone there is nothing to resolve: the seed
				 * put the recorded `Authorization` into the headers above, so the
				 * replay goes out exactly as it ran.
				 */
				const rawAuth = resolveAuthForSend(request.auth, collectionAncestors);
				const execAuth = rawAuth
					? (resolveObject(rawAuth) as Record<string, unknown>)
					: undefined;

				const preScriptParts = replayParts(
					seed.collectionPreScripts,
					seed.legacyPreScript,
					request.preRequestScript
				);
				const postScriptParts = replayParts(
					seed.collectionPostScripts,
					seed.legacyPostScript,
					request.testScript
				);

				const result = await engineExecuteRequest(
					{
						method: request.method,
						url: resolvedUrl,
						headers: resolvedHeaders,
						body: execBody,
						auth: execAuth,
						preRequestScripts: preScriptParts,
						postRequestScripts: postScriptParts,
						// Always sent, never elided - the engine defaults to
						// following, so an omitted `false` would follow the
						// redirect the run was recorded not following.
						followRedirects: request.followRedirects,
						maxRedirects: request.maxRedirects,
						// Files the new run under the same request, so a resend
						// lands beside the run it came from.
						...(run.requestId ? { requestId: run.requestId } : {}),
					},
					activeEnvironmentId || undefined
				);

				if (!result) return null;

				if (result.errorCode === "AUTH_REQUIRED") {
					showToast(
						"OAuth 2.0 token required - open the Auth tab and click Get Token",
						"error"
					);
				} else if (result.errorCode === "AUTH_FAILED") {
					showToast(result.errorMessage || "OAuth 2.0 token request failed", "error");
				}

				// A resend is a new run, so History has to hear about it.
				queryClient.invalidateQueries({ queryKey: queryKeys.runs.list() });
				if (preScriptParts) {
					queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
				}

				// Shared with the builder's own send path - see execute-mapping.ts
				return responseFromExecuteResult(result);
			} catch (error) {
				console.error("Replaying the run failed:", error);
				const errorMsg = error instanceof Error ? error.message : String(error);
				return {
					status: 0,
					statusText: "Error",
					headers: {},
					body: errorMsg,
					bodyType: "text",
					time: 0,
					size: 0,
					errorCode: "INTERNAL_ERROR",
					errorMessage: errorMsg,
				};
			}
		},
		[
			seed,
			run.requestId,
			replayParts,
			engineExecuteRequest,
			activeEnvironmentId,
			resolveString,
			resolveObject,
			collectionAncestors,
			queryClient,
			showToast,
		]
	);

	/*
	 * Hold the whole pane until the lookup settles, rather than mounting the
	 * builder on a seed that says "deleted" and hoping to correct it. There is
	 * no correction available: the provider seeds once per `initialRequest.id`,
	 * and that id is null for every detached copy. Same spinner as the request
	 * builder's own loading state, because this *is* the request builder.
	 */
	if (isResolvingRequest) {
		return (
			<div className="flex-1 flex items-center justify-center h-full">
				<div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-[vayu-spin_0.7s_linear_infinite]" />
			</div>
		);
	}

	/*
	 * The lookup settled in a transport failure, not a deletion. Seeding the
	 * copy from a run whose request could not be fetched would silently replay
	 * the recorded token as though the request were an orphan - so offer a retry
	 * instead of guessing. A genuine deletion is not caught here: it flows on and
	 * seeds the orphan copy, which is correct for one.
	 */
	if (requestLookupFailed) {
		const detail = requestLookupError instanceof Error ? requestLookupError.message : null;
		return (
			<ErrorState
				title="Couldn't load this run's request"
				detail={detail ?? "The request behind this run could not be fetched."}
				onRetry={() => void refetchRequest()}
			/>
		);
	}

	return (
		<div className="flex flex-col h-full min-h-0">
			<div className="flex items-center gap-2 px-4 py-2 border-b border-rule surface-card shrink-0">
				<span className="text-xs text-muted-foreground">
					You are editing a copy - nothing here is saved.
				</span>
				{/*
				 * The mode this run actually sent, read-only. The Auth tab shows the
				 * request's *current* mode, so seeing both side by side is the only
				 * way to notice the request's auth changed since this ran. Only the
				 * mode survives storage, so there is nothing more to show. Absent
				 * when the run sent no auth.
				 */}
				{seed.recordedAuthMode && (
					<Badge variant="outline" className="text-xs shrink-0 font-normal">
						Run sent auth: {seed.recordedAuthMode}
					</Badge>
				)}
				{/*
				 * The Save button exists only while the request does. When it has
				 * been deleted there is nothing to write back to, so it is absent
				 * rather than disabled - a disabled button invites a hunt for the
				 * condition that would enable it, and none can be met here.
				 */}
				{liveRequest && (
					<Button
						variant="outline"
						size="sm"
						className="ml-auto"
						onClick={() => setShowSaveDialog(true)}
					>
						<Save className="w-3.5 h-3.5 mr-1.5" />
						Save this run to the request
					</Button>
				)}
			</div>

			<div className="flex-1 min-h-0">
				<RequestBuilderProvider
					initialRequest={seed.request}
					initialResponse={initialResponse}
					inheritedPreScripts={seed.collectionPreScripts}
					inheritedPostScripts={seed.collectionPostScripts}
					legacyPreScript={seed.legacyPreScript}
					legacyPostScript={seed.legacyPostScript}
					collectionId={null}
					onExecute={handleExecute}
					/* No `onSave`. See the note at the top of this file - that
					   absence is one of the two things detaching the copy. */
				>
					<RequestBuilderLayout />
				</RequestBuilderProvider>
			</div>

			{/* Mounted only while open: the dialog computes the diff on render,
			    and there is no reason to diff a run nobody is saving. */}
			{liveRequest && showSaveDialog && (
				<SaveRunToRequestDialog
					open={showSaveDialog}
					onOpenChange={setShowSaveDialog}
					seed={seed}
					run={run}
					liveRequest={liveRequest}
				/>
			)}
		</div>
	);
}
