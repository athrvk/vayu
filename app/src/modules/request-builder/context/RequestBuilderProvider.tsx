/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Request state, variable resolution, execute and save actions, the response (persisted via the
 * store) and debounced autosave.
 */

import {
	useState,
	useCallback,
	useMemo,
	useEffect,
	useLayoutEffect,
	useRef,
	type ReactNode,
} from "react";
import { RequestBuilderContext } from "./RequestBuilderContext";
import { emptyDrafts, type BodyDrafts, type VariablesDraft } from "../utils/body-drafts";
import {
	NO_BULK_DRAFTS,
	bulkDraftsPatch,
	bulkTextPatch,
	unreadLineNotices,
	rebasedBulkDrafts,
	withBulkDraft,
	type BulkDraft,
	type BulkDrafts,
	type BulkTable,
} from "../utils/bulk-drafts";
import { UNSAVED_AUTO_KEY } from "./auto-record-slot";
import { retainKeys } from "./retain-keys";
import { createSendTracker, NO_SENDS, type InFlightSends, type SendTicket } from "./send-tracker";
import { useVariableResolver, useVariableWriter, useSaveManager } from "@/hooks";
import { resolveDataContract } from "@/lib/data-contract";
import { useDeferredVariables } from "@/components/layout/context-bar/code-composition";
import { mergeExternalWrite, type MergeOptions } from "@/lib/field-merge";
import { carryRowIds, sameRows } from "@/components/shared/KeyValueEditor/key-value";
import { hasIncompleteElement, SaveBlockedError } from "@/lib/elements";
import { useElementRefusals } from "@/components/shared/ElementList/useElementRefusals";
import { useDataFileLimits } from "@/hooks/useDataFileLimits";
import {
	useCollectionAncestors,
	useCollectionsQuery,
	useLastDesignRunQuery,
	useElementKindsQuery,
} from "@/queries";
import {
	useResponseStore,
	useExecutionEventsStore,
	useBoundRowStore,
	useTabsStore,
	useToastStore,
	type Tab,
} from "@/stores";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import { useRevealStore, type OperationRevealCommand } from "@/lib/graphql/reveal-store";
import { apiService } from "@/services";
import type { ResolvedElement } from "@/types";
import type {
	RequestState,
	ResponseState,
	RequestTab,
	StreamStartResult,
	VariableInfo,
	RequestBuilderContextValue,
	MergeableRequestField,
	RequestFieldConflicts,
} from "../types";
import { keepSigningKeyReferenceInAuth } from "@/services/oauth/signing-key";
import { resolveAuthForSend } from "../utils/auth-resolution";
import { requestHasTokens } from "../utils/request-tokens";
import { leaveDeferredField } from "../utils/sends-url";
import { createDefaultRequestState } from "../utils/request-state";
import { responseFromRunResult } from "../utils/restore-response";
import { sentRequestOf } from "../utils/execute-mapping";
import { useExecutionEvents } from "../hooks/useExecutionEvents";
import { useStreamFinalization } from "./stream-finalization";
import { useSendWithRow } from "../hooks/useSendWithRow";
import { useRequestModelLifecycle } from "../hooks/useRequestModelLifecycle";
import { EditorVariableTokensProvider } from "@/components/shared/EditorVariableTokens";

/**
 * Every field the per-field merge watches (`MergeableRequestField`), spelled out because
 * `mergeExternalWrite` iterates it.
 */
const MERGEABLE_FIELDS: readonly MergeableRequestField[] = [
	"name",
	"description",
	"method",
	"methodSource",
	"url",
	"params",
	"headers",
	"bodyMode",
	"body",
	"formData",
	"urlEncoded",
	"binaryFile",
	"mcpTool",
	"auth",
	"elements",
	"followRedirects",
	"maxRedirects",
	"timeout",
	"httpVersion",
	"verifySSL",
	"disableCookies",
	"disabledSystemHeaders",
	"disableUrlEncoding",
	"stream",
	"streamTextPath",
	"streamFirstContentMarker",
];

/**
 * The key/value tables. Their rows carry ephemeral ids every fetch makes anew, so they compare as
 * stored rows and are adopted with the draft's ids carried over, or every save's echo would remount
 * every row under the caret (#3663).
 */
const ROW_FIELDS = ["params", "headers", "formData", "urlEncoded"] as const;

/**
 * How many saves' values the merge recognises as echoes. Two: a save queued behind another
 * (`useSaveManager`) starts in the microtask after the first resolves, before the first's cache
 * write renders, so the first's echo arrives after the second recorded what it sends (#3664).
 */
const SENDS_REMEMBERED = 2;

const MERGE_OPTIONS: MergeOptions<RequestState, MergeableRequestField> = {
	equals: { params: sameRows, headers: sameRows, formData: sameRows, urlEncoded: sameRows },
};

/** `patch` with each table it adopts keeping the ids of `current`'s rows. */
function withCarriedRowIds(
	patch: Partial<RequestState>,
	current: RequestState
): Partial<RequestState> {
	const carried = { ...patch };
	for (const field of ROW_FIELDS) {
		const rows = patch[field];
		if (rows) carried[field] = carryRowIds(current[field], rows);
	}
	return carried;
}

/** `fields` plus every mergeable field `patch` writes. */
function withPatchedFields(
	fields: ReadonlySet<MergeableRequestField>,
	patch: Partial<RequestState>
): ReadonlySet<MergeableRequestField> {
	const next = new Set(fields);
	for (const field of Object.keys(patch) as MergeableRequestField[]) {
		if (MERGEABLE_FIELDS.includes(field)) next.add(field);
	}
	return next;
}

function withoutFields(
	fields: ReadonlySet<MergeableRequestField>,
	removed: Iterable<MergeableRequestField>
): ReadonlySet<MergeableRequestField> {
	const next = new Set(fields);
	for (const field of removed) next.delete(field);
	return next;
}

/** `request`'s values for exactly `fields`. */
function pickFields(
	request: RequestState,
	fields: Iterable<MergeableRequestField>
): Partial<RequestState> {
	// `Record<string, unknown>`: `field` is a plain union member, not a generic tied to
	// `request[field]`, so TypeScript cannot check each pair; `updateField` casts for the same
	// reason.
	const picked: Record<string, unknown> = {};
	for (const field of fields) picked[field] = request[field];
	return picked as Partial<RequestState>;
}

interface RequestBuilderProviderProps {
	children: ReactNode;
	initialRequest?: Partial<RequestState>;
	/**
	 * The identity this builder files its per-builder memory under: the Send-with-row picker's row
	 * index (#1272) and the Bulk edit drafts (#3666). The reversible settings (the body mode's
	 * `Content-Type`, the Event stream toggle's `Accept`, the GraphQL mode's `method`) mark
	 * ownership on the request itself (#1481, #1505). Defaults to `request.id`. The History run
	 * view passes its run id: its copy is deliberately id-less (`design-run-seed.ts` sets
	 * `id: null`, one of the two detaching gates), and two open run tabs would otherwise share one
	 * identity. Pass an id the tab strip names, so a record under it is bounded by that tab.
	 */
	memoryKey?: string;
	/**
	 * Starting response for an id-less builder, which cannot read the store (the History run view,
	 * from the run). Keep it stable (memoize it): the reset below reads it, not only the
	 * initialiser.
	 */
	initialResponse?: ResponseState | null;
	/**
	 * Elements shown as "runs before your own" instead of the live chain (#1512): the History run
	 * view passes what the run recorded, so a past run lists the scripts that ran, not today's.
	 */
	inheritedElements?: ResolvedElement[];
	/**
	 * The whole glued script a run recorded before script parts existed, shown read-only: its
	 * collection and request halves cannot be separated, so the editor above is empty.
	 */
	legacyPreScript?: string;
	legacyPostScript?: string;
	collectionId?: string | null;
	/**
	 * Send the request and return the exchange. `dataRow` is Send-with-row's one row (#601): the
	 * URL, headers and body bind against it and both scripts read it as `pm.iterationData`;
	 * undefined is a plain Send. `signal` is the send's Cancel (#3352): a handler ignoring it still
	 * has its answer dropped, but the engine finishes a send nobody reads.
	 */
	onExecute?: (
		request: RequestState,
		dataRow?: Record<string, unknown>,
		signal?: AbortSignal
	) => Promise<ResponseState | null>;
	/**
	 * Send a stream-flagged request (#574). Apart from `onExecute`: a buffered send returns the
	 * exchange, a streamed one the run to follow, with no exchange yet. A builder without it cannot
	 * stream (the History run view's detached copy), and Send falls back to buffering, not nothing.
	 */
	onExecuteStream?: (
		request: RequestState,
		dataRow?: Record<string, unknown>
	) => Promise<StreamStartResult | null>;
	/**
	 * Save the request. `changedFields` is exactly what the user touched since the draft last
	 * agreed with the server (#1436); a field adopted from an external write is never in it, so
	 * `onSave`'s payload does not write it back.
	 */
	onSave?: (
		request: RequestState,
		changedFields: ReadonlySet<MergeableRequestField>
	) => Promise<void>;
	onStartLoadTest?: (request: RequestState) => void;
}

export default function RequestBuilderProvider({
	children,
	initialRequest,
	memoryKey: declaredMemoryKey,
	initialResponse,
	inheritedElements,
	legacyPreScript,
	legacyPostScript,
	collectionId,
	onExecute,
	onExecuteStream,
	onSave,
	onStartLoadTest,
}: RequestBuilderProviderProps) {
	const [request, setRequestState] = useState<RequestState>(() => ({
		...createDefaultRequestState(),
		...initialRequest,
		collectionId: collectionId || null,
	}));

	// The catalogue's `required` keys per kind (#1635), for `handleSave` to judge whether
	// `elements` is safe to send; `useElementKindsQuery` caches it, so it costs nothing beyond
	// `ElementsPanel`'s fetch.
	const { data: elementKinds } = useElementKindsQuery();
	const { errors: elementErrors, refuse: refuseElement } = useElementRefusals(request.elements);

	// The request on screen. One provider serves every request tab, so an in-flight execute must
	// tell whether its result still belongs on screen; a ref, since `executeRequest` closed over
	// the request active at Send.
	const currentRequestIdRef = useRef<string | null>(request.id ?? null);
	useEffect(() => {
		currentRequestIdRef.current = request.id ?? null;
	}, [request.id]);

	// The response, in the store so it survives view switches.
	const getResponse = useResponseStore((s) => s.getResponse);
	const storeSetResponse = useResponseStore((s) => s.setResponse);
	const [response, setLocalResponse] = useState<ResponseState | null>(() => {
		const requestId = initialRequest?.id;
		if (requestId) {
			const stored = getResponse(requestId);
			if (stored) {
				return stored as ResponseState;
			}
		}
		// Nothing stored: a detached copy has no id to look one up, so it hands its response in.
		return initialResponse ?? null;
	});

	const setResponse = useCallback(
		(newResponse: ResponseState | null) => {
			setLocalResponse(newResponse);
			const requestId = request.id;
			if (requestId && newResponse) {
				storeSetResponse(requestId, newResponse);
			}
		},
		[request.id, storeSetResponse]
	);

	// The last design run from the backend, for an app reload.
	const {
		run: lastDesignRun,
		report: lastDesignRunReport,
		isLoading: isLoadingLastRun,
	} = useLastDesignRunQuery(request.id);
	/*
	 * The request the backend restore has answered for; null once the provider gets another
	 * request, so a return to an earlier one asks again. State, as the restore reads it during
	 * render. A stored response adopted at mount counts as an answer, or the Send clearing the pane
	 * would be refilled from the previous design run (#3421).
	 */
	const [restoredFor, setRestoredFor] = useState<string | null>(() =>
		response && request.id ? request.id : null
	);
	const [restoredResponse, setRestoredResponse] = useState<ResponseState | null>(null);
	// A stream this request holds, live or finished until another Send or a clear, owns the pane:
	// the last design run must not fill it meanwhile.
	const holdsStream = useExecutionEventsStore(
		(s) => !!s.runId && !!s.requestId && s.requestId === request.id
	);

	/*
	 * Load the response from the backend when nothing is cached and the last design run has one (an
	 * app reload). Derived during render, not in an effect: it reads query state and writes
	 * component state, so an effect would paint the empty viewer first. Persisting to the store is
	 * outside React, so that half stays in the effect below.
	 */
	if (
		request.id &&
		!response &&
		!isLoadingLastRun &&
		!holdsStream &&
		restoredFor !== request.id
	) {
		setRestoredFor(request.id);
		const restored = responseFromRunResult(
			lastDesignRunReport?.results?.[0],
			lastDesignRun?.id
		);
		if (restored) {
			setLocalResponse(restored);
			setRestoredResponse(restored);
		}
	}

	const restoredForId = restoredFor;
	useEffect(() => {
		if (restoredResponse && restoredForId) {
			storeSetResponse(restoredForId, restoredResponse);
		}
	}, [restoredResponse, restoredForId, storeSetResponse]);

	/*
	 * Kept per request id (`tab-selection-store`), so the active sub-tab survives `Shell.tsx`
	 * unmounting this builder; the reset block below restores it when `initialRequest.id` changes
	 * without a remount, as switching request tabs reuses this provider.
	 */
	const getRequestTab = useTabSelectionStore((s) => s.getRequestTab);
	const setRequestTab = useTabSelectionStore((s) => s.setRequestTab);
	const [activeTab, setActiveTabState] = useState<RequestTab>(
		() => (initialRequest?.id ? getRequestTab(initialRequest.id) : null) ?? "params"
	);
	const setActiveTab = useCallback(
		(tab: RequestTab) => {
			setActiveTabState(tab);
			if (request.id) setRequestTab(request.id, tab);
		},
		[request.id, setRequestTab]
	);

	/*
	 * The context bar's GraphQL outline scrolls the query editor, which exists only while Body is
	 * shown (Radix unmounts the rest), so a click from a hidden Body brings the tab forward and
	 * `GraphQLBody` serves the command on mount. This end only opens the tab: `GraphQLBody`
	 * consumes and clears, as it knows whether the operation still exists, and clearing here would
	 * race it. This end clears only a command nothing under it can serve (another request's, or one
	 * whose request no longer has a GraphQL body), which would otherwise replay at the next GraphQL
	 * body to mount.
	 */
	const clearReveal = useRevealStore((s) => s.clearReveal);
	const requestId = request.id ?? null;
	const bodyMode = request.bodyMode;
	useEffect(() => {
		const serve = (command: OperationRevealCommand | null) => {
			if (!command) return;
			if (command.requestId !== requestId || bodyMode !== "graphql") {
				clearReveal();
				return;
			}
			setActiveTab("body");
		};
		// Read as well as subscribed, so a command outliving its request is dropped when the next
		// arrives.
		serve(useRevealStore.getState().pending);
		return useRevealStore.subscribe((s) => serve(s.pending));
	}, [requestId, bodyMode, clearReveal, setActiveTab]);
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

	/*
	 * How many edits this request has seen: the generation `handleSave` checks before reporting
	 * clean. `onSave(request)` serialises the state at save start, so a keystroke during the round
	 * trip is not in the payload; clearing `hasUnsavedChanges` unconditionally marked it saved and
	 * lost it (`useSaveManager` never re-armed, the Dock said "Saved"). Comparing generations
	 * across the await stops a save claiming an edit it never carried, as `save-store.ts` keeps an
	 * early timer off a later save. A ref *and* state: the ref survives the await, the state is
	 * what `useSaveManager` watches to restart its debounce.
	 */
	const changeTokenRef = useRef(0);
	const [changeToken, setChangeToken] = useState(0);
	/**
	 * Bump the generation without claiming an unsaved change. `markDirty` is for user edits. A
	 * foreign write mid-save (#1436) is no edit (usually adopted with nothing to save) but must
	 * move the generation, or `handleSave` could not tell "the response is what went out" from
	 * "something happened in the air" and would clear `hasUnsavedChanges` over a field the merge
	 * just changed. Called only from effects and handlers, never render: `changeTokenRef` must
	 * update synchronously before the next render for `handleSave` to read it across an `await`,
	 * and a ref write in render is what React (and `react-hooks/refs`) forbid, since renders can be
	 * discarded. The merge flags a foreign write by changing `baseline`; the effect after it bumps
	 * the generation outside render.
	 */
	const bumpGeneration = useCallback(() => {
		changeTokenRef.current += 1;
		setChangeToken(changeTokenRef.current);
	}, []);
	const markDirty = useCallback(() => {
		bumpGeneration();
		setHasUnsavedChanges(true);
	}, [bumpGeneration]);

	/*
	 * The per-field merge state for #1436, all `useState`, so the merge reads and adjusts it during
	 * render as `lastReset` does: state derived from props, where an effect would paint the
	 * previous request's fields for a frame. `baseline` is the value the draft last agreed on with
	 * the server, not necessarily `request` (what the user typed). `touchedFields` is which fields
	 * the user edited since that baseline: `setRequest` adds, a successful save clears; it tells
	 * "adopt silently" from "conflict", and is what `handleSave` sends.
	 */
	const [baseline, setBaseline] = useState<RequestState>(request);
	const [touchedFields, setTouchedFields] = useState<ReadonlySet<MergeableRequestField>>(
		() => new Set()
	);
	const [fieldConflicts, setFieldConflicts] = useState<RequestFieldConflicts>({});
	/**
	 * What the last `SENDS_REMEMBERED` saves sent, by field, newest last (#3664), so the merge
	 * tells a save's echo from another's write. Added before `onSave` is awaited and kept after,
	 * since the echoing cache write can render either side of the resolve; a rejected save removes
	 * its entry (no echo, so a later outside write of the value must conflict). A settled save's
	 * values stay until pushed out, so an outside write equal to one reads as an echo; accepted, as
	 * only the baseline moves. State: the merge reads it during render.
	 */
	const [recentSends, setRecentSends] = useState<readonly Partial<RequestState>[]>([]);
	/**
	 * The request was deleted elsewhere while this tab has it (#1436). Turns `useSaveManager`'s
	 * `enabled` off, so an armed autosave never PUTs to an id that now 404s.
	 */
	const [requestGone, setRequestGone] = useState(false);
	/**
	 * The `initialRequest` object the merge last processed. `index.tsx` makes a new one only when
	 * `fetchedRequest` changes, so this reference check keeps the merge (a JSON diff over every
	 * field) off every keystroke.
	 */
	const [lastProcessedInitialRequest, setLastProcessedInitialRequest] = useState<
		Partial<RequestState> | undefined
	>(undefined);

	/*
	 * The generation bump a foreign write earns (`bumpGeneration`), from an effect, not the merge
	 * block. Skips its first run: `baseline`'s mount is no foreign write.
	 */
	const isFirstBaselineEffectRef = useRef(true);
	useEffect(() => {
		if (isFirstBaselineEffectRef.current) {
			isFirstBaselineEffectRef.current = false;
			return;
		}
		bumpGeneration();
	}, [baseline, bumpGeneration]);

	/*
	 * What the unseen body modes hold, here rather than in `BodyPanel`: Radix unmounts an inactive
	 * `TabsContent`, so a panel ref, and the stashed JSON, would vanish on a glance at Headers. Not
	 * reset by the request-change block: drafts carry their `requestId` and `switchBody` drops
	 * another request's, so a second reset would be a copy of that rule, and would fire on a *save*
	 * that first gives an unsaved request its id, wiping live drafts.
	 */
	const bodyDraftsRef = useRef<BodyDrafts>(emptyDrafts(initialRequest?.id ?? null));
	const getBodyDrafts = useCallback(() => bodyDraftsRef.current, []);
	const setBodyDrafts = useCallback((drafts: BodyDrafts) => {
		bodyDraftsRef.current = drafts;
	}, []);

	/*
	 * The GraphQL Variables pane's in-progress text, which the body cannot always hold. Here for
	 * the drafts' reason, and like them not reset on a request change: it names its request and
	 * `ownVariablesDraft` drops another's.
	 */
	const variablesDraftRef = useRef<VariablesDraft | null>(null);
	const getVariablesDraft = useCallback(() => variablesDraftRef.current, []);
	const setVariablesDraft = useCallback((draft: VariablesDraft) => {
		variablesDraftRef.current = draft;
	}, []);

	/*
	 * The identity every per-builder map here is filed under: the picker's row index and the Bulk
	 * edit drafts. One provider serves every tab, so a single-record slot held whichever request
	 * used it last, and the request before kept what the app changed for it (#1269). A request tab
	 * is its request; a builder over something else says so with `memoryKey`, as two id-less
	 * builders are not one (#1272). Spelled once: the maps share a sweep, and two spellings drift.
	 */
	const memoryKey = declaredMemoryKey ?? request.id ?? UNSAVED_AUTO_KEY;
	/*
	 * Which builder is on screen, for a save that runs after the provider moved on:
	 * `useSaveManager` flushes the previous request's save from a passive cleanup with that
	 * request's `handleSave`. A layout effect, so the ref is current before any passive cleanup of
	 * the same commit.
	 */
	const shownMemoryKeyRef = useRef(memoryKey);
	useLayoutEffect(() => {
		shownMemoryKeyRef.current = memoryKey;
	}, [memoryKey]);

	/*
	 * The Params and Headers Bulk edit drafts (#3666), per builder and swept with the open tabs.
	 * Not reset on a request change: filed under `memoryKey`, a draft is read only by its own
	 * request and returns with it.
	 */
	const [bulkDraftsByKey, setBulkDraftsByKey] = useState<Record<string, BulkDrafts>>({});
	const bulkDrafts = bulkDraftsByKey[memoryKey] ?? NO_BULK_DRAFTS;
	const setBulkDrafts = useCallback(
		(key: string, update: (drafts: BulkDrafts) => BulkDrafts) =>
			setBulkDraftsByKey((previous) => {
				const next = update(previous[key] ?? NO_BULK_DRAFTS);
				if (Object.keys(next).length > 0) return { ...previous, [key]: next };
				if (!(key in previous)) return previous;
				const { [key]: _closed, ...rest } = previous;
				return rest;
			}),
		[]
	);
	const setBulkDraft = useCallback(
		(table: BulkTable, draft: BulkDraft | null) =>
			setBulkDrafts(memoryKey, (drafts) => withBulkDraft(drafts, table, draft)),
		[memoryKey, setBulkDrafts]
	);

	// The row memory below is bounded by the same sweep (#1271): one rule over every per-builder
	// map.

	const { data: collections = [] } = useCollectionsQuery();

	/**
	 * The data contract in scope (#600): the nearest declaring ancestor of this request's
	 * collection, from the collections loaded above. Resolved once and carried on the context, so
	 * `VariableInput` and the rows paint `{{data.*}}` against it without the query cache. Undefined
	 * is ordinary: most collections declare nothing.
	 */
	const dataColumns = useMemo(
		() => resolveDataContract(collectionId, collections) ?? undefined,
		[collectionId, collections]
	);

	/*
	 * Send-with-row (#601): the rows this request could bind and the one last sent with. Here, not
	 * in `UrlBar`, because the *preview* needs it as much as the picker (#1062): a row reaching the
	 * engine beside composition left the URL bar, tab title and token painting previewing an
	 * environment value the send answered from the row. The provider already owns both inputs (the
	 * contract and the row cap), so this takes props off the context.
	 *
	 * The index is session-lived, never persisted: "the row I am iterating on" belongs to this
	 * session, and persisting it would point a saved number at a file whose rows are not saved.
	 * Keyed by request (#659 item 1): `Shell` renders `<RequestBuilder />` at one position for
	 * every request tab, so React keeps its state, and a single number followed the user across
	 * requests. The row cap the declared file is measured against (#751) is read here, as the
	 * config query is the provider's.
	 */
	const { maxRows: dataFileMaxRows } = useDataFileLimits();
	const sendWithRow = useSendWithRow(dataColumns, dataFileMaxRows);
	const [rowIndexByRequest, setRowIndexByRequest] = useState<Record<string, number>>({});
	// Filed under the same identity, for the same reason.
	const lastRowIndex = rowIndexByRequest[memoryKey] ?? null;
	const rememberRowIndex = useCallback(
		(index: number) =>
			setRowIndexByRequest((previous) => ({ ...previous, [memoryKey]: index })),
		[memoryKey]
	);
	/*
	 * A Send without a row leaves the request bound to none (#1062). A pick is the row this request
	 * is sent with, not a setting, and Send and its chord send *without* one, so a pick kept across
	 * a plain Send would preview the row's value beside a request just sent with the environment's.
	 * Otherwise the memory survives a tab switch and a return (#659): neither is a send.
	 */
	const forgetRowIndex = useCallback(
		() =>
			setRowIndexByRequest((previous) => {
				if (!(memoryKey in previous)) return previous;
				const { [memoryKey]: _forgotten, ...rest } = previous;
				return rest;
			}),
		[memoryKey]
	);
	const retainRowIndexes = useCallback(
		(live: ReadonlySet<string>) =>
			setRowIndexByRequest((previous) => retainKeys(previous, live)),
		[]
	);

	/*
	 * What bounds every per-builder map: the open tabs (#1269, #1271, #1272). An entry (a picked
	 * row index, a Bulk edit draft) is read only by its builder, so with no tab it is never read
	 * again, and an unpruned store leaks. `MAX_OPEN_TABS` caps the strip, so this caps the maps.
	 * Subscribed, not selected, like the reveal command: re-rendering on every tab focus would
	 * charge the working request. Both maps are state, read during render, so `retainKeys` returns
	 * the same map when it drops nothing and React bails out. A run tab is swept like a request
	 * tab: History's copy files under its run id (#1272), naming a tab. Run and request ids come
	 * from different tables and cannot collide; a run tab with no builder (load test, scenario)
	 * keeps only an unwritten key. The id-less key survives: it names no tab, and its builder's
	 * memory nothing else could keep.
	 */
	useEffect(() => {
		const retainOpen = (tabs: readonly Tab[]) => {
			const live = new Set<string>([UNSAVED_AUTO_KEY]);
			for (const tab of tabs) {
				if (tab.entityId === null) continue;
				if (tab.type === "request" || tab.type === "run") live.add(tab.entityId);
			}
			retainRowIndexes(live);
			setBulkDraftsByKey((previous) => retainKeys(previous, live));
		};
		return useTabsStore.subscribe((s) => retainOpen(s.openTabs));
	}, [retainRowIndexes]);

	// The editors' models are bounded by the same tabs (#3136).
	useRequestModelLifecycle();

	/**
	 * The row the preview resolves against: the picked one, once its file has been read. Null until
	 * then, including an index restored by "Repro row N" before the picker opened: previewing
	 * against an unloaded row is worse than previewing the composition.
	 */
	const boundRow = useMemo(
		() =>
			lastRowIndex === null
				? undefined
				: (sendWithRow.parsed?.rows[lastRowIndex] ?? undefined),
		[lastRowIndex, sendWithRow.parsed]
	);

	/*
	 * Publish the bound row for the one preview outside this provider, the tab strip (#1074):
	 * `useTabDescriptors` labels every tab from one list-wide resolver and cannot read this
	 * context, and a tab labelled from the environment over a bar showing the file's value is the
	 * split #1062 closed. Cleared on unmount and whenever there is no row, so the slot cannot
	 * outlive its builder.
	 */
	const setBoundRow = useBoundRowStore((s) => s.setBoundRow);
	const boundRequestId = request.id ?? null;
	useEffect(() => {
		setBoundRow(
			boundRow && boundRequestId ? { requestId: boundRequestId, row: boundRow } : null
		);
		return () => setBoundRow(null);
	}, [boundRow, boundRequestId, setBoundRow]);

	const {
		resolveString,
		resolveField: resolveStoredField,
		resolveObject,
		getVariable: resolverGetVariable,
		getAllVariables: resolverGetAllVariables,
		getVariableOrigins,
	} = useVariableResolver({ collectionId: collectionId || undefined, boundRow });

	/**
	 * The auth this request sends: `inherit` walked by the shared resolver, then `{{variables}}`
	 * resolved for preview; null without credentials. Preview only (execution resolves engine-side,
	 * `POST /compose`); its reader is the GraphQL schema cache's identity, which keyed on auth *as
	 * typed* left `inherit` one constant, so editing the ancestor's credential or the token's
	 * variable served the schema fetched with the old one (#383).
	 */
	const collectionAncestors = useCollectionAncestors(collectionId);
	const resolvedAuth = useMemo<Record<string, unknown> | null>(() => {
		const forSend = resolveAuthForSend(request.auth, collectionAncestors);
		// A jwt_bearer `privateKey` names a secret variable; resolving it would put the PEM in this
		// memo and the schema cache's identity digest.
		return forSend ? keepSigningKeyReferenceInAuth(resolveObject(forSend), forSend) : null;
	}, [request.auth, collectionAncestors, resolveObject]);

	/*
	 * Names a pre-request script sets at send (#2521), so token painters stop showing stored values
	 * as sent (#2741). Asked once here, as painting is per editor, and only while the request has a
	 * `{{token}}`, so a literal request costs no compose. The answer is the Code section's cache
	 * entry, refreshed by its invalidations, never per keystroke.
	 */
	const hasTokens = useMemo(() => requestHasTokens(request), [request]);
	const deferredVariables = useDeferredVariables(request.id ?? "", hasTokens);
	// The field previews (the rows' sigma peek, Body's Resolved pane) leave the same names written,
	// so none prints a value the script replaces.
	const resolveField = leaveDeferredField(resolveStoredField, deferredVariables);

	// Variable writes, shared with the collection Elements tab (useVariableWriter).
	const { updateVariable, writableScopes } = useVariableWriter({
		collectionId: collectionId || undefined,
	});

	/*
	 * Reset when the provider gets another request, during render, not in an effect: state derived
	 * from props, which an effect would paint stale first. Triggered by `id` / `initialResponse`,
	 * never the `initialRequest` object, which a parent re-render replaces by reference and which
	 * would discard unsaved edits. `collectionId` alone is no full reset (#1436): a moved request
	 * is the same request, and the block below updates just that field. The mount is covered by the
	 * `useState` initialisers.
	 */
	const [lastReset, setLastReset] = useState({
		id: initialRequest?.id,
		collectionId,
		initialResponse,
	});
	const isReset =
		!!initialRequest &&
		(lastReset.id !== initialRequest.id || lastReset.initialResponse !== initialResponse);
	if (initialRequest && isReset) {
		setLastReset({ id: initialRequest.id, collectionId, initialResponse });
		setRestoredResponse(null);
		const seeded: RequestState = {
			...createDefaultRequestState(),
			...initialRequest,
			collectionId: collectionId || null,
		};
		setRequestState(seeded);
		setHasUnsavedChanges(false);
		// Another request: the merge state starts over from what it was handed (#1436).
		setBaseline(seeded);
		setTouchedFields(new Set());
		setFieldConflicts({});
		setRecentSends([]);
		setRequestGone(false);
		setLastProcessedInitialRequest(initialRequest);

		const requestId = initialRequest.id;
		if (requestId) {
			const stored = getResponse(requestId);
			setLocalResponse(stored ? (stored as ResponseState) : null);
			// Let the backend restore run again for this request, unless a stored response answered
			// (#3421).
			setRestoredFor(stored ? requestId : null);
		} else {
			setRestoredFor(null);
			/*
			 * No id, so no stored response: fall back to the one handed in, or a detached copy
			 * opens on "No response yet".
			 */
			setLocalResponse(initialResponse ?? null);
		}

		// Restore or default the active tab for the request now on screen, as the mount initializer
		// does: switching request tabs reuses this provider.
		setActiveTabState(requestId ? (getRequestTab(requestId) ?? "params") : "params");
	} else if (initialRequest && lastReset.collectionId !== collectionId) {
		/*
		 * The same request moved to another collection (#1436, `move_item`): only `collectionId`
		 * moves; dirty fields survive.
		 */
		setLastReset((prev) => ({ ...prev, collectionId }));
		const nextCollectionId = collectionId || null;
		setRequestState((prev) => ({ ...prev, collectionId: nextCollectionId }));
		setBaseline((prev) => ({ ...prev, collectionId: nextCollectionId }));
	}

	/*
	 * The request was deleted elsewhere (#1436): `index.tsx` keeps this provider mounted so the
	 * draft survives to be offered, but stops passing `initialRequest` once the fetch 404s.
	 * `request.id` guards against a new id-less builder (History's detached copy), which has no
	 * `initialRequest` either and is not "gone".
	 */
	if (!initialRequest && request.id && !requestGone) {
		setRequestGone(true);
	} else if (initialRequest && requestGone) {
		setRequestGone(false);
	}

	/*
	 * The per-field three-way merge (#1436). A field untouched since the last known-good value
	 * adopts an external change silently, through `setRequestState`, never `setRequest`: adopting
	 * is no edit, and dirtying it would save back what was just read. A touched field the fetch
	 * disagrees with is left and surfaced in `fieldConflicts`. `mergeExternalWrite` diffs; this
	 * applies the outcome.
	 *
	 * Our save's echo is no outside write even when the user typed through the round trip (#3664):
	 * the cache returns what was sent, disagreeing with `baseline` and draft. `recentSends`
	 * recognises it by value, moves `baseline` and leaves the field touched, so the next save sends
	 * the newer draft; a value no recent save sent still conflicts. Gated on `initialRequest`'s
	 * identity (a content diff over every field; `index.tsx` makes a new object only on a real
	 * fetch change). Skipped in a reset render (#3662): the reset queued `baseline` and cleared
	 * `touchedFields`, so this render still reads the previous request's values and would report
	 * them as conflicts.
	 */
	if (initialRequest && !isReset && initialRequest !== lastProcessedInitialRequest) {
		setLastProcessedInitialRequest(initialRequest);
		const incoming: RequestState = { ...baseline, ...initialRequest };
		const outcome = mergeExternalWrite(
			MERGEABLE_FIELDS,
			request,
			baseline,
			incoming,
			touchedFields,
			{ ...MERGE_OPTIONS, sent: recentSends }
		);
		if (outcome.changed) {
			if (Object.keys(outcome.patch).length > 0) {
				const patch = outcome.patch;
				setRequestState((prev) => ({ ...prev, ...withCarriedRowIds(patch, prev) }));
			}
			// The generation bump happens in the effect keyed on `baseline`, so nothing in render
			// writes the ref `handleSave` reads.
			setBaseline(outcome.nextBaseline);
		}
		if (JSON.stringify(outcome.conflicts) !== JSON.stringify(fieldConflicts)) {
			setFieldConflicts(outcome.conflicts);
		}
	}

	/**
	 * Adopt the incoming value for one conflicted field (#1436's "Take theirs"), sibling of #1437's
	 * `InfoTab.takeTheirName`.
	 */
	const takeExternalField = useCallback(
		(field: MergeableRequestField) => {
			const value = fieldConflicts[field];
			if (value === undefined) return;
			// `updateField`'s cast: `field` and `value` match by construction, which a computed
			// property cannot tell TypeScript.
			const patch = { [field]: value } as Partial<RequestState>;
			setRequestState((current) => ({ ...current, ...withCarriedRowIds(patch, current) }));
			setBaseline((prev) => ({ ...prev, ...patch }));
			setTouchedFields((prev) => {
				if (!prev.has(field)) return prev;
				const next = new Set(prev);
				next.delete(field);
				return next;
			});
			setFieldConflicts((prev) => {
				const next = { ...prev };
				delete next[field];
				return next;
			});
		},
		[fieldConflicts]
	);

	/*
	 * Hand the stored name back when an edit is refused. `baseline` holds the last fetched value of
	 * every mergeable field, `name` included, and always exists once a request is loaded.
	 */
	const restoreStoredName = useCallback(() => {
		setRequestState((prev) =>
			prev.name === baseline.name ? prev : { ...prev, name: baseline.name }
		);
	}, [baseline.name]);

	/** Mark `fields` as agreed with the server at the values `saved` carried. */
	const recordSaved = useCallback(
		(saved: RequestState, fields: ReadonlySet<MergeableRequestField>) => {
			if (fields.size === 0) return;
			setTouchedFields((prev) => withoutFields(prev, fields));
			const savedPatch = pickFields(saved, fields);
			setBaseline((prev) => ({ ...prev, ...savedPatch }));
		},
		[]
	);

	/*
	 * Write a save's carried drafts into the request on screen (#3666), leaving the textarea open:
	 * autosave fires on its own timer, often mid-typing, and must not close the editor under the
	 * caret. No bump, no dirty flag: the edit is in the payload, and `handleSave` marks it unsaved
	 * if the save fails. Skipped once another request is shown (the goodbye flush), whose state
	 * this is not; the draft, filed under its own key, is still rebased. Answers whether the shown
	 * request took them.
	 */
	const adoptSavedDrafts = useCallback(
		(key: string, patch: Partial<RequestState>): boolean => {
			setBulkDrafts(key, rebasedBulkDrafts);
			if (shownMemoryKeyRef.current !== key) return false;
			setRequestState((prev) => ({ ...prev, ...patch }));
			setTouchedFields((prev) => withPatchedFields(prev, patch));
			return true;
		},
		[setBulkDrafts]
	);

	// The centralized save: autosave, the keyboard shortcut and status.
	const handleSave = useCallback(async () => {
		if (!onSave) return;
		// From state, not the ref: this closure's `request` is what `onSave` serialises and
		// `changeToken` the generation behind it; the ref holds the newest edit's, which is what it
		// is compared against.
		const savedGeneration = changeToken;
		// What this save records (values sent, fields settled, dirty flag) is its request's state,
		// and the provider may show another by then: the goodbye flush starts after the switch, and
		// any save can settle after one (#3730). An id-less request given its id by this save reads
		// as not shown, at no cost: the new id resets the provider (`lastReset`) to the request
		// this save stored.
		const isShown = () => shownMemoryKeyRef.current === memoryKey;
		// An open Bulk edit draft is saved as if committed (#3666), built into the snapshot here
		// since `request` will not hold it until a render.
		const draftPatch = bulkDraftsPatch(request, bulkDrafts);
		const saving = draftPatch ? { ...request, ...draftPatch } : request;
		const adoptedDrafts = !!draftPatch && adoptSavedDrafts(memoryKey, draftPatch);
		// A snapshot of the set, so a `setRequest` during the await cannot add to what this save
		// claims sent.
		const changedFields = draftPatch
			? withPatchedFields(touchedFields, draftPatch)
			: touchedFields;
		// `buildUpdatePayload` sends the whole `elements` array when touched (#1635), and the
		// engine 400s the *whole* payload on one refused element (a fresh `config: {}`, a
		// schema-rejected value, #3048). So only the list is held back: "elements" stays touched,
		// its baseline the last saved list, and `SaveBlockedError` (thrown once the rest is
		// recorded) keeps `useSaveManager` at `"pending"` rather than backing off a retry of an
		// unchanged payload.
		const elementsHeldBack =
			changedFields.has("elements") &&
			hasIncompleteElement(saving.elements, elementKinds ?? []);
		const sentFields = elementsHeldBack
			? withoutFields(changedFields, ["elements"])
			: changedFields;
		if (elementsHeldBack && sentFields.size === 0) throw new SaveBlockedError();
		const sent = pickFields(saving, sentFields);
		if (isShown()) setRecentSends((prev) => [...prev, sent].slice(-SENDS_REMEMBERED));
		try {
			await onSave(saving, sentFields);
		} catch (error) {
			// By identity, not position: a later save may have appended.
			setRecentSends((prev) => prev.filter((entry) => entry !== sent));
			// The request holds the drafts now, and this save did not write them.
			if (adoptedDrafts && isShown()) setHasUnsavedChanges(true);
			// The engine names the refused element (#3043); the failure still reaches
			// `useSaveManager` for its toast and Dock status.
			if (sentFields.has("elements")) refuseElement(error, saving.elements);
			throw error;
		}
		// An edit or foreign write landed in flight: `changeTokenRef` moved and the payload is not
		// the whole story, so the request stays dirty and `useSaveManager` keeps debouncing. The
		// sent fields stay touched (a fresh edit to one would otherwise be forgotten), their
		// baseline left to the merge, which recognises this payload's echo through `recentSends`
		// (#3664). A switch also moves the generation, but which request is shown is asked
		// outright, not inferred.
		const settled = isShown() && changeTokenRef.current === savedGeneration;
		if (settled) recordSaved(saving, sentFields);
		if (elementsHeldBack) throw new SaveBlockedError();
		if (settled) setHasUnsavedChanges(false);
	}, [
		request,
		bulkDrafts,
		memoryKey,
		adoptSavedDrafts,
		changeToken,
		touchedFields,
		onSave,
		elementKinds,
		refuseElement,
		recordSaved,
	]);

	const {
		forceSave,
		status: saveStatus,
		isSaving,
	} = useSaveManager({
		entityId: request.id || null,
		onSave: handleSave,
		hasChanges: hasUnsavedChanges,
		changeToken,
		// Not just `!!onSave`: a request deleted elsewhere (#1436) must not have an armed autosave
		// PUT to an id that now 404s.
		enabled: !!onSave && !requestGone,
	});

	const setRequest = useCallback(
		(updates: Partial<RequestState>) => {
			setRequestState((prev) => ({ ...prev, ...updates }));
			const editedFields = (Object.keys(updates) as (keyof RequestState)[]).filter((field) =>
				MERGEABLE_FIELDS.includes(field as MergeableRequestField)
			) as MergeableRequestField[];
			if (editedFields.length > 0) {
				setTouchedFields((prev) => {
					const next = new Set(prev);
					for (const field of editedFields) next.add(field);
					return next;
				});
			}
			markDirty();
		},
		[markDirty]
	);

	/*
	 * A commit that left lines out says so (#3694); the parsed rows are written, so it is a notice,
	 * never a refusal. Send and the Table toggle report; a Save keeps the editor on the same text
	 * and autosave would repeat the notice every pass, so neither does.
	 */
	const showToast = useToastStore((s) => s.showToast);
	const reportUnreadLines = useCallback(
		(drafts: BulkDrafts) => {
			for (const message of unreadLineNotices(drafts)) showToast(message, "warning");
		},
		[showToast]
	);

	/*
	 * Send's commit (#3666): what is on screen is sent, so every open draft is written and closed.
	 * Returns the request the Send carries, built here as `request` holds the drafts only next
	 * render.
	 */
	const commitBulkDraftsForSend = useCallback((): RequestState => {
		const patch = bulkDraftsPatch(request, bulkDrafts);
		reportUnreadLines(bulkDrafts);
		setBulkDrafts(memoryKey, () => NO_BULK_DRAFTS);
		if (!patch) return request;
		setRequest(patch);
		return { ...request, ...patch };
	}, [request, bulkDrafts, memoryKey, setBulkDrafts, setRequest, reportUnreadLines]);

	const commitBulkDraft = useCallback(
		(table: BulkTable) => {
			const draft = bulkDrafts[table];
			if (!draft) return;
			const patch = bulkTextPatch(request, table, draft.text);
			if (patch) setRequest(patch);
			reportUnreadLines({ [table]: draft });
			setBulkDraft(table, null);
		},
		[request, bulkDrafts, setBulkDraft, setRequest, reportUnreadLines]
	);

	const saveRequest = useCallback(async () => {
		await forceSave();
	}, [forceSave]);

	// The one field that is state, not data (#1229): which engine defaults this send refuses. Never
	// written to the request, so it must not dirty the tab, as `setRequest` would, leading autosave
	// to PUT a request nobody changed.
	const setDisabledDefaultHeaders = useCallback((names: string[]) => {
		setRequestState((prev) => ({ ...prev, disabledDefaultHeaders: names }));
	}, []);

	const updateField = useCallback(
		<K extends keyof RequestState>(field: K, value: RequestState[K]) => {
			setRequest({ [field]: value } as Partial<RequestState>);
		},
		[setRequest]
	);

	const getVariable = useCallback(
		(name: string): VariableInfo | null => {
			const info = resolverGetVariable(name);
			if (!info) return null;
			return { value: info.value, scope: info.scope, secret: info.secret };
		},
		[resolverGetVariable]
	);

	// Passed through, not re-picked per field: a hand-copied projection drops fields (it once lost
	// `sourceName` / `sourceId` and `type` / `typedValue`), and the resolver already makes this
	// shape.
	const getAllVariables = useCallback(
		(): Record<string, VariableInfo> => resolverGetAllVariables(),
		[resolverGetAllVariables]
	);

	/*
	 * The live stream this builder started, if the store still holds it, selected against
	 * `request.id` as the execute result is: one provider serves every tab, so another request's
	 * stream must not show.
	 */
	const streamRunId = useExecutionEventsStore((s) =>
		s.requestId && s.requestId === requestId ? s.runId : null
	);
	const isStreaming = useExecutionEventsStore(
		(s) => s.isStreaming && !!s.requestId && s.requestId === requestId
	);
	// One subscription, owned here: the store names the stream, and the provider outlives every
	// panel reading it.
	useExecutionEvents();

	/*
	 * Every finished stream lands in its own request's stored response, whichever request is shown
	 * (#3382); the live pane only when that request is showing. Only a builder that can stream
	 * finalizes: History's detached copy has no stream handler and must not race this for the
	 * global store.
	 */
	const landStreamResponse = useCallback(
		(ownerId: string, restored: ResponseState) => {
			storeSetResponse(ownerId, restored);
			if (currentRequestIdRef.current === ownerId) setLocalResponse(restored);
		},
		[storeSetResponse]
	);
	useStreamFinalization(!!onExecuteStream, landStreamResponse);

	/** Stop the stream this builder started, at the engine. */
	const stopStream = useCallback(async () => {
		if (!streamRunId) return;
		try {
			await apiService.stopRun(streamRunId);
			// Nothing set on success: the engine ends the run, and the relay's `complete` frame
			// (`reason: "stopped"`) ends the stream here; ending it locally would report a reason
			// the run never recorded.
		} catch (error) {
			console.error("Failed to stop the event stream:", error);
		}
	}, [streamRunId]);

	/*
	 * Requests with a send in flight (#3352), under `memoryKey` like the other maps. `isExecuting`
	 * is derived for the request on screen, so leaving mid-send and returning finds it sending, and
	 * its Send stays refused until its own answer lands.
	 */
	const [inFlightSends, setInFlightSends] = useState<InFlightSends>(NO_SENDS);
	const [sendTracker] = useState(() => createSendTracker(setInFlightSends));
	const isExecuting = inFlightSends.has(memoryKey);
	const canCancelSend = inFlightSends.get(memoryKey)?.cancellable ?? false;
	const cancelSend = useCallback(() => sendTracker.cancel(memoryKey), [sendTracker, memoryKey]);

	/**
	 * Execute the request. `dataRow` is Send-with-row's row (#601), passed to both handlers: a
	 * stream-flagged request in a data-driven collection binds a row as a buffered one does, and a
	 * row dropped on that path would be the written-but-never-read defect plainly.
	 */
	const executeRequest = useCallback(
		async (dataRow?: Record<string, unknown>) => {
			// A Send without a row un-binds this request: previews must describe what is going out.
			if (!dataRow) forgetRowIndex();
			// Snapshot at Send: if the user switches requests before it resolves, the result lands
			// on the request that ran.
			const executingRequest = commitBulkDraftsForSend();
			const executingId = executingRequest.id;
			// What save-as-example records as this response's request (#1763), taken here, not at
			// Save, so edits made while reading stay out; only a saved request can hold an example.
			const sent = executingId ? sentRequestOf(executingRequest) : undefined;
			// This Send supersedes the note that another request took this one's feed, and any
			// finalisation of its earlier stream.
			if (executingId) useExecutionEventsStore.getState().beginSend(executingId);
			/*
			 * Persist under the request that ran, so returning to it shows its response;
			 * `storeSetResponse` is keyed by id and safe after the provider moved on. The live view
			 * is touched only while that request is shown (the ref is current, unlike
			 * `executingId`). An answer from an overtaken or cancelled send is dropped, never
			 * landing over the newer one.
			 */
			const land = (send: SendTicket, result: ResponseState) => {
				if (!send.isCurrent()) return;
				if (executingId) storeSetResponse(executingId, result);
				if (currentRequestIdRef.current === executingId) setLocalResponse(result);
			};

			/*
			 * A stream-flagged request takes the other endpoint answer (#574):
			 * `202 {runId, eventsUrl}`, no exchange. Without a stream handler the buffered path is
			 * the fallback: a silent Send is worse.
			 */
			if (executingRequest.stream && onExecuteStream) {
				const send = sendTracker.begin(memoryKey);
				setLocalResponse(null);
				if (executingId) useResponseStore.getState().clearResponse(executingId);
				// The pane is this Send's now; marked answered here, not when the stream opens, or
				// a loading last-design query resolving during the `202` wait would fill the
				// earlier run (#3421).
				if (executingId) setRestoredFor(executingId);
				// The previous stream's rows belong to the replaced send; cleared here, not on the
				// first event, so a stream that never opens leaves nothing stale. Another request's
				// live stream keeps running at the engine, and the store notes it for that
				// request's pane.
				useExecutionEventsStore.getState().handOver(executingId);
				try {
					const started = await onExecuteStream(executingRequest, dataRow);
					if (!started) return;
					if (!started.ok) {
						land(send, started.response);
						return;
					}
					// An overtaken send's stream is not followed: the feed is the newer send's.
					if (!send.isCurrent()) return;
					useExecutionEventsStore.getState().startStream({
						requestId: executingId,
						runId: started.runId,
						eventsUrl: started.eventsUrl,
						leftOut: started.leftOut,
						sent,
					});
				} catch (error) {
					console.error("Request execution failed:", error);
				} finally {
					/*
					 * Finished though the stream just began: the engine has the transfer and
					 * answered, and a spinner would hide the Events tab behind "Sending…" for the
					 * stream's life. `isStreaming` reports the rest.
					 */
					send.finish();
				}
				return;
			}

			if (!onExecute) return;

			/*
			 * The previous response stays on screen for the whole send: clearing it threw away the
			 * exchange being read (a blank flash, or nothing to compare against on a slow request).
			 * `isExecuting` marks it stale, and every path out of `onExecute` resolves to a
			 * replacing response (a failure is a `status: 0` one, `handleExecute` in
			 * `request-builder/`), so it is never left standing as this send's answer. Cancel
			 * leaves it as the last answer, the request idle at once. The streaming path still
			 * clears, and must: its pane's placeholder from the relay's `open` frame is built only
			 * with no stored response, and it clears the store entry too, since the mount
			 * initialiser and the switch reset read the store and a stale entry would resurface.
			 */
			const send = sendTracker.begin(memoryKey, { cancellable: true });

			try {
				const executed = await onExecute(executingRequest, dataRow, send.signal);
				const result = executed && sent ? { ...executed, sentRequest: sent } : executed;
				if (result) land(send, result);
			} catch (error) {
				if (!send.signal.aborted) console.error("Request execution failed:", error);
			} finally {
				send.finish();
			}
		},
		[
			commitBulkDraftsForSend,
			memoryKey,
			sendTracker,
			onExecute,
			onExecuteStream,
			storeSetResponse,
			forgetRowIndex,
		]
	);

	// Start a load test, carrying an open Bulk edit draft as Send does (#3666).
	const startLoadTest = useCallback(() => {
		if (onStartLoadTest) {
			onStartLoadTest(commitBulkDraftsForSend());
		}
	}, [commitBulkDraftsForSend, onStartLoadTest]);

	const contextValue = useMemo<RequestBuilderContextValue>(
		() => ({
			request,
			setRequest,
			updateField,
			setDisabledDefaultHeaders,
			restoreStoredName,
			fieldConflicts,
			takeExternalField,
			getBodyDrafts,
			setBodyDrafts,
			getVariablesDraft,
			setVariablesDraft,
			bulkDrafts,
			setBulkDraft,
			commitBulkDraft,
			response,
			setResponse,
			inheritedElements,
			elementErrors,
			legacyPreScript,
			legacyPostScript,
			memoryKey,
			activeTab,
			setActiveTab,
			isExecuting,
			canCancelSend,
			cancelSend,
			isStreaming,
			stopStream,
			isSaving,
			hasUnsavedChanges,
			saveStatus,
			resolveString,
			resolveField,
			resolveVariables: resolveString,
			resolvedAuth,
			getVariable,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			dataColumns,
			deferredVariables,
			sendWithRow,
			lastRowIndex,
			rememberRowIndex,
			executeRequest,
			saveRequest,
			startLoadTest,
			canStartLoadTest: !!onStartLoadTest,
		}),
		[
			request,
			setRequest,
			updateField,
			setDisabledDefaultHeaders,
			restoreStoredName,
			fieldConflicts,
			takeExternalField,
			getBodyDrafts,
			setBodyDrafts,
			getVariablesDraft,
			setVariablesDraft,
			bulkDrafts,
			setBulkDraft,
			commitBulkDraft,
			response,
			setResponse,
			inheritedElements,
			elementErrors,
			legacyPreScript,
			legacyPostScript,
			memoryKey,
			activeTab,
			setActiveTab,
			isExecuting,
			canCancelSend,
			cancelSend,
			isStreaming,
			stopStream,
			isSaving,
			hasUnsavedChanges,
			saveStatus,
			resolveString,
			resolveField,
			resolvedAuth,
			getVariable,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			dataColumns,
			deferredVariables,
			sendWithRow,
			lastRowIndex,
			rememberRowIndex,
			executeRequest,
			saveRequest,
			startLoadTest,
			onStartLoadTest,
		]
	);

	return (
		<RequestBuilderContext.Provider value={contextValue}>
			{/*
			 * Inside the context, not around it: code editors' `{{token}}` popover is the
			 * single-line fields', and needs this provider's `updateVariable` and `writableScopes`
			 * to edit or create (#1220); every variable-interpolating Monaco is under here.
			 * `contextValue` already holds every `VariableSupport` field, so it goes through as
			 * `support`, not via `useVariableSupport()`, which calls `useRequestBuilderContext()`
			 * and would throw here, before this component renders its own provider.
			 */}
			<EditorVariableTokensProvider support={contextValue}>
				{children}
			</EditorVariableTokensProvider>
		</RequestBuilderContext.Provider>
	);
}
