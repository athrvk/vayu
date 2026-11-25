/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A past design run, opened as an editable copy of the request that was sent: read it, change it,
 * send it again. Nothing typed here reaches the saved request unless the Save button below is used,
 * and that asks first.
 *
 * ## Two things detach the copy, and neither is decoration
 *
 * **`id: null`** (set by `seedFromRun`) and **no `onSave`** below. Either alone is sufficient,
 * deliberately belt-and-braces, so do not delete one as redundant:
 *
 * - `useSaveManager` early-returns on `!entityId` in both its autosave effect and `performSave`, so
 *   a null id stops the write even if an `onSave` exists.
 * - `RequestBuilderProvider` passes `enabled: !!onSave`, so no `onSave` stops it even if an id
 *   appears.
 *
 * A null id also keeps the response store (keyed by request id) unwritten and stops
 * `useLastDesignRunQuery` from running.
 *
 * The absent prop looks like an oversight in the JSX below; it is not. Opening the *saved request*
 * in the builder has both an id and an `onSave`, so changing a header to compare against an old run
 * rewrites the saved request seconds later, which is what this view exists to prevent.
 *
 * Guarded by "does not save when the URL is edited" in `DesignRunView.test.tsx`, which fails when
 * both gates are removed together.
 */

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Save, Pin, PinOff, Loader2 } from "lucide-react";
import { RequestBuilderProvider } from "@/modules/request-builder/context";
import RequestBuilderLayout from "@/modules/request-builder/components/RequestBuilderLayout";
import {
	useRequestQuery,
	isRequestNotFound,
	queryKeys,
	useSetRunBaselineMutation,
} from "@/queries";
import { useEngine } from "@/hooks";
import { useSessionStore, useToastStore } from "@/stores";
import {
	Button,
	Badge,
	LabelSwap,
	ICON_MOTION,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { DetailSkeleton, ErrorState, SentBodyFileNote } from "@/components/shared";
import type { RequestState, ResponseState } from "@/modules/request-builder/types";
import {
	disabledDefaults,
	responseFromExecuteResult,
	elementsMayWriteVariables,
} from "@/modules/request-builder/utils/execute-mapping";
import { buildComposeBody } from "@/modules/request-builder/utils/compose-body";
import { responseFromRunResult } from "@/modules/request-builder/utils/restore-response";
import { humanizeOAuth2Error } from "@/constants/oauth2-fields";
import { ApiError } from "@/services";
import { seedFromRun, scriptPartToElement, type DesignRunSeed } from "./design-run-seed";
import SaveRunToRequestDialog from "./SaveRunToRequestDialog";
import SaveAgentRunButton from "./SaveAgentRunButton";
import { isUnsavedAgentRun } from "./save-run-as-request";
import { WithheldValuesNotice } from "./components/WithheldValuesNotice";
import type { Run, ResolvedElement } from "@/types";

interface DesignRunViewProps {
	run: Run;
}

/**
 * A run recorded before script parts existed has one glued script, replayed as a single
 * request-origin element per hook: `seedFromRun` cannot split it, so the string is the only record
 * of what ran. A blank one is left out (#3066): the engine refuses a script element with no text,
 * which would 400 the resend.
 */
function legacyElements(seed: DesignRunSeed): ResolvedElement[] {
	const pre = scriptPartToElement(
		{ origin: "request", script: seed.legacyPreScript },
		"script.pre"
	);
	const post = scriptPartToElement(
		{ origin: "request", script: seed.legacyPostScript },
		"script.post"
	);
	return [pre, post].flatMap((element) =>
		element ? [{ ...element, origin: { kind: "request" as const } }] : []
	);
}

export default function DesignRunView({ run }: DesignRunViewProps) {
	const { executeRequest: engineExecuteRequest, composeRequest: engineComposeRequest } =
		useEngine();
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const showToast = useToastStore((s) => s.showToast);
	const queryClient = useQueryClient();
	const [showSaveDialog, setShowSaveDialog] = useState(false);

	// A design run has no comparison to make, but a pin still keeps a known-good (or known-bad)
	// reply past retention and findable (#1509). The same mutation as RunItem's row pin; nothing
	// about it is load-run-specific.
	const setBaselineMutation = useSetRunBaselineMutation();
	const handleTogglePin = async () => {
		try {
			await setBaselineMutation.mutateAsync({ runId: run.id, baseline: !run.baseline });
		} catch {
			showToast(
				run.baseline ? "Couldn't unpin this run." : "Couldn't pin this run.",
				"error"
			);
		}
	};
	const PinIcon = run.baseline ? PinOff : Pin;
	const pinLabel = run.baseline ? "Unpin" : "Pin";
	const pinTooltip = run.baseline
		? "Unpin this run"
		: "Pin this run to keep it past retention and find it again later";

	/*
	 * The live request, when it still exists. It is the only source of credentials
	 * (`sanitize_config_snapshot` strips auth to its mode and replaces a credential header's value
	 * with `<redacted>` before storing a run), so the seed needs it to decide where headers and
	 * auth come from.
	 *
	 * Three outcomes, kept apart because `seedFromRun` treats a falsy `liveRequest` as "the request
	 * was deleted" and seeds the recorded wire headers, `Authorization` included, with
	 * `auth: { mode: "none" }`:
	 *
	 * - **Still loading.** `data` is falsy but the answer is not in. Seeding now bakes in the
	 *   deleted-request seed and the provider never corrects it (its reset effect keys on
	 *   `initialRequest?.id`, null before and after), so the pane is held until the query settles.
	 *   `isLoading` is `isPending && isFetching`, so a run with no `requestId` disables the query
	 *   and settles at once rather than hanging on the spinner.
	 * - **Settled, request gone.** A genuine deletion, thrown as `RequestNotFoundError`: the orphan
	 *   case that legitimately replays the recorded headers, so the *only* error allowed into
	 *   `seedFromRun`'s request-gone branch.
	 * - **Settled, lookup failed.** A transport failure throws something else. Each per-collection
	 *   list fetch has `.catch(() => [])` (`collections.ts`), so treating any error as "not found"
	 *   would turn one swallowed transient failure into a deletion; the test is for the sentinel
	 *   type. A non-sentinel error means the request could not be fetched, and seeding from it
	 *   would be guessing: show a retry.
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

	const seed = useMemo(() => seedFromRun(run, liveRequest ?? null), [run, liveRequest]);
	const liveCollectionId = liveRequest?.collectionId;

	/*
	 * Memoized: the provider reads it in an effect, not only in a `useState` initialiser, so a
	 * fresh object each render would re-run that effect and reset the pane.
	 */
	const initialResponse = useMemo<ResponseState | null>(
		() => responseFromRunResult(run.result, run.id),
		[run]
	);

	/*
	 * Replay: the inherited elements exactly as recorded (what the collection ran then, not what it
	 * reads now), then the copy's own, live and editable.
	 */
	const handleExecute = useCallback(
		async (
			request: RequestState,
			_dataRow?: Record<string, unknown>,
			signal?: AbortSignal
		): Promise<ResponseState | null> => {
			try {
				/*
				 * `buildComposeBody`, as the builder's own Send uses it (#2638), raw: the engine
				 * resolves {{variables}} and inherit auth at compose time (#226), against *today's*
				 * variables and chain, which is what a replay means here (D14). The detached copy
				 * is why replay uses the inline compose shape: there is no saved row behind an
				 * edited copy for a by-id compose to load.
				 *
				 * When the request is gone there is nothing to resolve: the seed put the recorded
				 * `Authorization` into the headers and `auth: { mode: "none" }` on the copy, so the
				 * replay goes out exactly as it ran (the engine drops a none-auth at compose).
				 */
				const elements: ResolvedElement[] = [
					...seed.inheritedElements,
					...legacyElements(seed),
					...request.elements.map((el): ResolvedElement => ({
						...el,
						origin: { kind: "request" },
					})),
				];

				const { body } = buildComposeBody({
					request,
					elements: { resolved: elements.length > 0 ? elements : undefined },
					// Undefined for an orphaned run, which resolves against
					// environment + globals.
					collectionId: liveCollectionId,
					environmentId: activeEnvironmentId,
				});
				const composed = await engineComposeRequest(body);

				const result = await engineExecuteRequest(
					{
						...composed,
						// Files the resend under the same request, beside the run it came from.
						...(run.requestId ? { requestId: run.requestId } : {}),
						// The engine defaults this replay refuses (issue #1229),
						// switched off in the copy's own Headers tab.
						...disabledDefaults(request),
					},
					activeEnvironmentId || undefined,
					signal
				);

				// Before the cancelled-send exit: Cancel only stops the renderer
				// waiting, so the engine still runs and records the replay (#3352).
				// A resend is a new run, so History has to hear about it.
				queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
				queryClient.invalidateQueries({ queryKey: queryKeys.runs.count() });
				// The request's Recent sends list too, which is not polled and lists this replay;
				// only when the run links a request, as a detached replay belongs to none.
				if (run.requestId) {
					queryClient.invalidateQueries({
						queryKey: queryKeys.runs.recentDesign(run.requestId),
					});
				}
				// Same gate as the builder's send path, from the same helper.
				if (elementsMayWriteVariables(elements)) {
					queryClient.invalidateQueries({ queryKey: queryKeys.environments.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.globals.all });
					queryClient.invalidateQueries({ queryKey: queryKeys.collections.all });
				}

				if (!result) return null;

				if (result.errorCode === "AUTH_REQUIRED") {
					showToast(
						"This request needs an OAuth 2.0 token. Open the Auth tab to get one.",
						"error"
					);
				} else if (result.errorCode === "AUTH_FAILED") {
					// Same engine message, same relabelling as the builder's send path.
					showToast(
						result.errorMessage
							? humanizeOAuth2Error(result.errorMessage)
							: "Couldn't get an OAuth 2.0 token. Check the Auth tab's token settings.",
						"error"
					);
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
					time: 0,
					size: 0,
					errorCode: error instanceof ApiError ? error.errorCode : "ENGINE_ERROR",
					errorMessage: errorMsg,
				};
			}
		},
		[
			seed,
			run.requestId,
			engineComposeRequest,
			engineExecuteRequest,
			activeEnvironmentId,
			liveCollectionId,
			queryClient,
			showToast,
		]
	);

	/*
	 * Hold the whole pane until the lookup settles rather than mount the builder on a seed that
	 * says "deleted": nothing could correct it, as the provider seeds once per `initialRequest.id`,
	 * null for every detached copy. The request builder's own loading skeleton, because this *is*
	 * the request builder.
	 */
	if (isResolvingRequest) {
		return <DetailSkeleton label="Loading run" />;
	}

	/*
	 * The lookup settled in a transport failure, not a deletion. Seeding from a run whose request
	 * could not be fetched would silently replay the recorded token as if the request were an
	 * orphan, so offer a retry. A genuine deletion is not caught here: it flows on and seeds the
	 * orphan copy, which is correct for one.
	 */
	if (requestLookupFailed) {
		const detail = requestLookupError instanceof Error ? requestLookupError.message : null;
		return (
			<ErrorState
				title="Couldn't load this run's request"
				detail={detail ?? "The request behind this run couldn't be fetched."}
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
				 * The mode this run sent, read-only. The Auth tab shows the request's *current*
				 * mode, so the two side by side are the only way to notice the auth changed since
				 * this ran. Only the mode survives storage. Absent when the run sent no auth.
				 */}
				{seed.recordedAuthMode && (
					<Badge variant="outline" className="text-xs shrink-0 font-normal">
						Run sent auth: {seed.recordedAuthMode}
					</Badge>
				)}
				{/* Which file a binary body sent, as the engine recorded it at
				    send time - the file on disk may have changed since, and the
				    sha256 is what says whether it did. */}
				{seed.requestBodyFile && <SentBodyFileNote file={seed.requestBodyFile} />}
				<div className="ml-auto flex items-center gap-2">
					{/*
					 * An agent's run with no saved request has nothing to write back to, so Save
					 * here makes the request and leads the header, the one thing this run still
					 * needs. A linked run keeps its overwrite button below, unpromoted.
					 */}
					{isUnsavedAgentRun(run) && <SaveAgentRunButton run={run} seed={seed} />}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								onClick={() => void handleTogglePin()}
								disabled={setBaselineMutation.isPending}
								aria-pressed={!!run.baseline}
							>
								{setBaselineMutation.isPending ? (
									<Loader2 className="size-icon-sm animate-spin" />
								) : (
									<PinIcon className="size-icon-sm" />
								)}
								<LabelSwap label={pinLabel} states={["Pin", "Unpin"]} />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{pinTooltip}</TooltipContent>
					</Tooltip>
					{/*
					 * Only while the request exists. Deleted, there is nothing to write back to, so
					 * the button is absent, not disabled: a disabled button invites a hunt for the
					 * condition that enables it, and none can be met here.
					 */}
					{liveRequest && (
						<Button variant="outline" size="sm" onClick={() => setShowSaveDialog(true)}>
							<Save className="size-icon-sm" data-icon-motion={ICON_MOTION.press} />
							Save to request
						</Button>
					)}
				</div>
			</div>

			{/* The seed carries the marker in a url, params or body the engine
			    withheld a secret from; sending the copy sends it literally. */}
			<WithheldValuesNotice withheld={seed.withheld} className="mx-4 mt-2 shrink-0" />
			<div className="flex-1 min-h-0">
				<RequestBuilderProvider
					initialRequest={seed.request}
					/* The copy has no request id and must not grow one - that null
					   is one of the two gates detaching it - but the provider still
					   has to tell two open run tabs apart when it files what a
					   setting changed. The run id is the identity it files under
					   (issue #1272); it names this tab, so the same open-tab sweep
					   bounds it. */
					memoryKey={run.id}
					initialResponse={initialResponse}
					inheritedElements={seed.inheritedElements}
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
