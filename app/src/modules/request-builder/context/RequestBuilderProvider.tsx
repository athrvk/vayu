/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBuilder Provider
 *
 * Provides:
 * - Request state management
 * - Variable resolution layer
 * - Execute/save actions
 * - Response state (persisted via store)
 * - Auto-save with debouncing
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
 * Every `RequestState` field the per-field merge below watches - everything
 * `MergeableRequestField` allows, spelled out because `mergeExternalWrite`
 * needs the list to iterate, not just the type.
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
];

/**
 * The key/value tables. Their rows carry ephemeral ids every fetch makes anew,
 * so they are compared as stored rows and adopted with the draft's ids carried
 * over, or every save's echo would remount every row under the caret (#3663).
 */
const ROW_FIELDS = ["params", "headers", "formData", "urlEncoded"] as const;

/**
 * How many saves' values the merge recognises as echoes. Two, not one: a save
 * queued behind another (`useSaveManager`) starts in the microtask after the
 * first resolves, before the first's cache write has rendered, so the first's
 * echo arrives after the second has already recorded what it sends (#3664).
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
	// `Record<string, unknown>`, not `Partial<RequestState>`: `field` is a plain
	// union member here, not a generic correlated with `request[field]`, so
	// TypeScript cannot verify the pair matches per assignment - the same reason
	// `updateField` casts at its call site.
	const picked: Record<string, unknown> = {};
	for (const field of fields) picked[field] = request[field];
	return picked as Partial<RequestState>;
}

interface RequestBuilderProviderProps {
	children: ReactNode;
	initialRequest?: Partial<RequestState>;
	/**
	 * The identity this builder files its per-builder memory under - the
	 * Send-with-row picker's row index (issue #1272), the one per-request map
	 * left provider-side now that the three reversible-setting records (the
	 * body mode's `Content-Type`, the Event stream toggle's `Accept`, the
	 * GraphQL mode's `method`) all mark ownership on the request's own state
	 * instead (issues #1481, #1505).
	 *
	 * Defaults to `request.id`, which is what a request tab wants. The History
	 * run view passes its run id, because the copy it renders is deliberately
	 * id-less (`design-run-seed.ts` sets `id: null`, one of the two gates that
	 * detach it) and two open run tabs would otherwise be one identity. Pass an
	 * id the tab strip can name - a record keyed under it is bounded by that
	 * tab, exactly as a request's is.
	 */
	memoryKey?: string;
	/**
	 * Starting response for a builder with no id, which cannot read the store.
	 * Used by the History run view, where the response comes from the run.
	 *
	 * Keep the reference stable (memoize it): it is read by the reset effect
	 * below, not only by the `useState` initialiser.
	 */
	initialResponse?: ResponseState | null;
	/**
	 * Elements to show as "runs before your own" instead of the live collection
	 * chain (issue #1512). The History run view passes what the run recorded,
	 * so a copy of a past run lists the scripts that actually ran, not the
	 * ones the collection carries today.
	 */
	inheritedElements?: ResolvedElement[];
	/**
	 * The whole glued script a run recorded before script parts existed. Shown
	 * read-only, because its collection and request halves cannot be separated
	 * and the editor above is therefore necessarily empty.
	 */
	legacyPreScript?: string;
	legacyPostScript?: string;
	collectionId?: string | null;
	/**
	 * Send the request and return the exchange.
	 *
	 * `dataRow` is the one row a Send-with-row binds (issue #601) - the URL,
	 * headers and body substitute against it and both scripts read it as
	 * `pm.iterationData`. Undefined is the ordinary Send.
	 *
	 * `signal` is the send's Cancel (#3352). A handler that ignores it still
	 * has its answer dropped, but the engine finishes a send nobody reads.
	 */
	onExecute?: (
		request: RequestState,
		dataRow?: Record<string, unknown>,
		signal?: AbortSignal
	) => Promise<ResponseState | null>;
	/**
	 * Send a stream-flagged request (issue #574). Separate from `onExecute`
	 * because the two answers are different things, not two shapes of one: a
	 * buffered send returns the exchange, a streamed one returns the run to
	 * follow and there is no exchange yet. A builder given no handler cannot
	 * stream - the History run view's detached copy is one - and Send falls back
	 * to the buffered path rather than doing nothing.
	 */
	onExecuteStream?: (
		request: RequestState,
		dataRow?: Record<string, unknown>
	) => Promise<StreamStartResult | null>;
	/**
	 * Save the request. `changedFields` is exactly what the user has touched
	 * since the draft last agreed with the server (issue #1436) - a field
	 * silently adopted from an external write is never in it, so the payload
	 * `onSave` builds does not write that field back.
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
	// Request state
	const [request, setRequestState] = useState<RequestState>(() => ({
		...createDefaultRequestState(),
		...initialRequest,
		collectionId: collectionId || null,
	}));

	// The catalogue's `required` keys per kind (issue #1635) - `handleSave`
	// below needs it to decide whether `elements` is safe to send; cached by
	// `useElementKindsQuery` itself, so this costs nothing beyond the fetch
	// `ElementsPanel` already makes.
	const { data: elementKinds } = useElementKindsQuery();
	const { errors: elementErrors, refuse: refuseElement } = useElementRefusals(request.elements);

	// The id of the request currently on screen. This single provider is reused
	// across request tabs (no per-tab key), so an execute that is still in flight
	// when the user switches requests must be able to tell whether its result
	// still belongs on screen. A ref, not the closure's `request`, because the
	// running executeRequest closed over the request that was active at Send.
	const currentRequestIdRef = useRef<string | null>(request.id ?? null);
	useEffect(() => {
		currentRequestIdRef.current = request.id ?? null;
	}, [request.id]);

	// Response state - use store for persistence across view switches
	const getResponse = useResponseStore((s) => s.getResponse);
	const storeSetResponse = useResponseStore((s) => s.setResponse);
	const [response, setLocalResponse] = useState<ResponseState | null>(() => {
		// Initialize from store if available
		const requestId = initialRequest?.id;
		if (requestId) {
			const stored = getResponse(requestId);
			if (stored) {
				return stored as ResponseState;
			}
		}
		// Nothing stored - a detached copy has no id to look one up by, so it
		// hands its response in directly.
		return initialResponse ?? null;
	});

	// Wrapper to update both local state and store
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

	// Fetch last design run from backend (for app reload scenarios)
	const {
		run: lastDesignRun,
		report: lastDesignRunReport,
		isLoading: isLoadingLastRun,
	} = useLastDesignRunQuery(request.id);
	/*
	 * The request the backend restore below has already answered for - null once
	 * the provider is handed a different request, which is what lets a return to
	 * an earlier request ask again. State rather than a ref because the restore
	 * reads it while rendering. A stored response adopted at mount counts as an
	 * answer: otherwise the Send that clears the pane would be refilled from the
	 * previous design run (#3421).
	 */
	const [restoredFor, setRestoredFor] = useState<string | null>(() =>
		response && request.id ? request.id : null
	);
	const [restoredResponse, setRestoredResponse] = useState<ResponseState | null>(null);
	// A stream this request holds, live or finished until another Send or a clear,
	// owns the pane: the last design run must not fill it meanwhile.
	const holdsStream = useExecutionEventsStore(
		(s) => !!s.runId && !!s.requestId && s.requestId === request.id
	);

	/*
	 * Load the response from the backend when nothing is cached locally and the
	 * last design run has one (the app-reload case).
	 *
	 * Derived while rendering rather than in an effect: it reads query state and
	 * writes component state, so an effect would paint the empty viewer first and
	 * replace it a frame later. Persisting to the response store is a write to
	 * something outside React, so that half stays in the effect below.
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

	// UI state
	/*
	 * Kept per request id (`tab-selection-store`), so the active sub-tab
	 * survives `Shell.tsx` unmounting this builder when its workspace tab is
	 * not on screen. The reset block further down restores it again when
	 * `initialRequest.id` changes without a remount - switching between two
	 * open request tabs reuses this same provider instance rather than
	 * remounting it.
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
	 * The context bar's GraphQL outline scrolls the query editor, and the editor
	 * only exists while the Body tab is on screen - Radix unmounts the rest. So a
	 * click from a hidden Body tab brings the tab forward and `GraphQLBody`
	 * serves the command on mount; revealing into an editor nobody can see is the
	 * silent-failure alternative.
	 *
	 * This end only opens the tab. `GraphQLBody` owns consuming and clearing,
	 * because it is the one that knows whether the operation is still there - and
	 * clearing here would race it to the slot. What this end does clear is a
	 * command nothing under it can ever serve: another request's, or one for a
	 * request that no longer sends a GraphQL body. Left in the slot, it would be
	 * replayed at the next GraphQL body that mounts.
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
		// Read as well as subscribed to, so a command that outlived the request it
		// was written for is dropped when this provider is handed the next one.
		serve(useRevealStore.getState().pending);
		return useRevealStore.subscribe((s) => serve(s.pending));
	}, [requestId, bodyMode, clearReveal, setActiveTab]);
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

	/*
	 * How many edits this request has seen - the generation `handleSave` checks
	 * before it reports the request clean.
	 *
	 * `onSave(request)` serialises the state as it was when the save started, so
	 * a keystroke that lands during the round trip is not in the payload that
	 * went out. Clearing `hasUnsavedChanges` unconditionally on the way back
	 * therefore marked that keystroke saved and dropped it: nothing was left
	 * dirty, so `useSaveManager` never re-armed and the Dock said "Saved".
	 * Comparing generations across the await keeps a save from claiming an edit
	 * it never carried - the same shape `save-store.ts` uses to keep an early
	 * timer off a later save's indicator.
	 *
	 * Kept as a ref *and* as state on purpose: the ref is what survives the
	 * await, and the state is what `useSaveManager` can watch to restart its
	 * debounce on each edit.
	 */
	const changeTokenRef = useRef(0);
	const [changeToken, setChangeToken] = useState(0);
	/**
	 * Bump the generation without claiming an unsaved change of our own.
	 *
	 * `markDirty` below is for the user's edits, which need `hasUnsavedChanges`
	 * too. A foreign write landing mid-save (issue #1436) is not an edit - most
	 * of the time it is adopted with nothing left to save - but it still has to
	 * move the generation, or `handleSave`'s in-flight check cannot tell "the
	 * save's response is exactly what went out" from "something happened while
	 * it was in the air" and would clear `hasUnsavedChanges` over a field the
	 * merge just changed underneath the response.
	 *
	 * Called only from effects and event handlers, never from the render body:
	 * `changeTokenRef` has to update synchronously, ahead of the next render,
	 * for `handleSave`'s in-flight check to read the true latest value across
	 * an `await` - and a ref write during render is exactly what React's rules
	 * (and this repo's `react-hooks/refs` lint) forbid, since a render can be
	 * discarded or replayed. The per-field merge below flags a foreign write by
	 * changing `baseline`; the effect right after it is what turns that into a
	 * generation bump, entirely outside the render phase.
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
	 * The per-field merge state for issue #1436 - all of it `useState`, not a
	 * ref, so the merge below can read and adjust it during render the same
	 * way `lastReset` above does: this is state derived from props, and an
	 * effect would paint the previous request's fields for a frame before
	 * correcting them.
	 *
	 * `baseline` is the value the draft last agreed with the server on - not
	 * necessarily `request`, which is whatever the user has typed.
	 *
	 * `touchedFields` is which top-level fields the user has edited since that
	 * baseline - what `setRequest` adds to and a successful save clears. It is
	 * what tells the merge "adopt silently" from "this is a conflict", and what
	 * `handleSave` reads to send only what changed.
	 */
	const [baseline, setBaseline] = useState<RequestState>(request);
	const [touchedFields, setTouchedFields] = useState<ReadonlySet<MergeableRequestField>>(
		() => new Set()
	);
	const [fieldConflicts, setFieldConflicts] = useState<RequestFieldConflicts>({});
	/**
	 * What the last `SENDS_REMEMBERED` saves sent, field by field, newest last
	 * (#3664). The merge reads it to tell a save's echo from someone else's
	 * write. An entry is added before `onSave` is awaited and kept after it
	 * resolves, because the cache write that echoes it can render on either
	 * side of the resolve; a save that rejects removes its own entry, since it
	 * has no echo and a later outside write of the same value must conflict.
	 * A settled save's values stay until later saves or a reset push them out,
	 * so an outside write equal to one of them reads as an echo - accepted:
	 * the draft is not touched by it, only the baseline moves. State, not a
	 * ref: the merge reads it during render.
	 */
	const [recentSends, setRecentSends] = useState<readonly Partial<RequestState>[]>([]);
	/**
	 * The request this builder was showing has been deleted elsewhere, while
	 * this tab still has it open (issue #1436). Sets `useSaveManager`'s
	 * `enabled` to false, so a dirty draft's autosave timer - already armed, or
	 * about to be - never fires a PUT against an id that now 404s.
	 */
	const [requestGone, setRequestGone] = useState(false);
	/**
	 * Which `initialRequest` object the merge below has already processed.
	 * `index.tsx` only produces a new one when `fetchedRequest` itself changes
	 * (its `useMemo` dep), so this reference check is what keeps the merge -
	 * a JSON-comparing diff over every mergeable field - from running on every
	 * keystroke instead of only on an actual refetch.
	 */
	const [lastProcessedInitialRequest, setLastProcessedInitialRequest] = useState<
		Partial<RequestState> | undefined
	>(undefined);

	/*
	 * The generation bump a foreign write earns (see `bumpGeneration` above),
	 * done from an effect rather than from the merge block itself. Skips its
	 * first run: `baseline`'s own mount is not a foreign write, and bumping the
	 * generation before anything has been edited would just be noise.
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
	 * What the body modes you are not looking at were holding. It lives here
	 * rather than in `BodyPanel` because Radix unmounts an inactive
	 * `TabsContent`: a panel-local ref is discarded the moment you glance at the
	 * Headers tab, and your stashed JSON with it.
	 *
	 * Not reset by the request-change effect below, deliberately. The drafts
	 * carry their own `requestId` and `switchBody` drops any that belong to
	 * another request, so a second reset here would be a copy of that rule that
	 * could fall out of step with it - and would fire on a *save*, when an
	 * unsaved request is first assigned an id, wiping drafts the user still has.
	 */
	const bodyDraftsRef = useRef<BodyDrafts>(emptyDrafts(initialRequest?.id ?? null));
	const getBodyDrafts = useCallback(() => bodyDraftsRef.current, []);
	const setBodyDrafts = useCallback((drafts: BodyDrafts) => {
		bodyDraftsRef.current = drafts;
	}, []);

	/*
	 * The GraphQL Variables pane's in-progress text, which the stored body cannot
	 * always hold. Here for the drafts' reason - the panel is unmounted whenever
	 * another tab is on screen - and, like them, not reset by the request-change
	 * effect below: the draft names its own request and `ownVariablesDraft` drops
	 * one belonging to another.
	 */
	const variablesDraftRef = useRef<VariablesDraft | null>(null);
	const getVariablesDraft = useCallback(() => variablesDraftRef.current, []);
	const setVariablesDraft = useCallback((draft: VariablesDraft) => {
		variablesDraftRef.current = draft;
	}, []);

	/*
	 * The one identity every per-builder map here is read and written under: the
	 * method record below and the picker's row index further down. One
	 * `RequestBuilderProvider` serves every tab, so a slot holding a single
	 * record held whichever request was in a mode last, and the request before
	 * it kept what the app had changed for it (issue #1269).
	 *
	 * A request tab is its request; a builder over something else says so with
	 * `memoryKey`, because two id-less builders are not one builder (issue
	 * #1272). Spelled once rather than per map - the maps share a sweep, and two
	 * spellings of one rule are how they drift apart.
	 *
	 * The Content-Type row a body mode adds, the `Accept: text/event-stream`
	 * row the Event stream toggle adds, and the method the GraphQL mode sets
	 * (issue #1228) used to all be tracked this way - an in-memory record that
	 * could not survive a reload, leaving a stale auto-written value
	 * indistinguishable from one the user chose (issue #1481). All three now
	 * carry their own ownership on the request's own state (`KeyValueEntry.source`
	 * for the two rows, `RequestState.methodSource` for the method, issue
	 * #1505) and need no slot here.
	 */
	const memoryKey = declaredMemoryKey ?? request.id ?? UNSAVED_AUTO_KEY;
	/*
	 * Which builder is on screen, for a save that runs after the provider has
	 * moved on: `useSaveManager` flushes the previous request's save from a
	 * passive effect's cleanup, with that request's `handleSave`. A layout
	 * effect, so the ref is current before any passive cleanup of the same
	 * commit, however soon the flush reaches `handleSave`.
	 */
	const shownMemoryKeyRef = useRef(memoryKey);
	useLayoutEffect(() => {
		shownMemoryKeyRef.current = memoryKey;
	}, [memoryKey]);

	/*
	 * The Params and Headers Bulk edit drafts (#3666), per builder like the maps
	 * below and bounded by the same open-tab sweep. Not reset by the request
	 * change block: filed under `memoryKey`, a draft is only ever read by the
	 * request it was typed in, and returns with it.
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

	// What bounds the row memory below is stated there, which the same sweep
	// bounds (issue #1271): one rule over every per-builder map the provider
	// holds, rather than one rule each.

	const { data: collections = [] } = useCollectionsQuery();

	/**
	 * The data contract in scope (issue #600) - the nearest declared ancestor of
	 * this request's collection, from the collections already loaded above.
	 *
	 * Resolved once here and carried on the context, so `VariableInput` and the
	 * key/value rows can paint a `{{data.*}}` token against it without reaching
	 * for the query cache themselves. Undefined is the ordinary state: most
	 * collections declare nothing.
	 */
	const dataColumns = useMemo(
		() => resolveDataContract(collectionId, collections) ?? undefined,
		[collectionId, collections]
	);

	/*
	 * Send-with-row (issue #601): the rows this request could bind, and the one
	 * it was last sent with.
	 *
	 * Here rather than in `UrlBar`, where it started, because the *preview* needs
	 * it as much as the picker does (issue #1062). A row reaching the engine
	 * beside composition and never through it is what left the URL bar, the tab
	 * title and the token painting previewing an environment value for a name the
	 * send answers from the row. The provider already owns both of this hook's
	 * inputs - the contract above and the row cap below - so lifting the state
	 * here also takes two props off the context rather than adding any.
	 *
	 * The index is still session-lived and still not persisted: it is a property
	 * of *this editing session* - "the row I am iterating on" - and not of the
	 * request. Persisting it would point a saved number at a file whose rows are
	 * deliberately not saved, so a later session would bind a different row under
	 * the same index.
	 *
	 * Keyed by request, though (issue #659 item 1). Switching request tabs does
	 * not remount the builder - `Shell` renders `<RequestBuilder />` at the same
	 * position for every request tab, so React keeps the instance and its state -
	 * and a single number therefore followed the user from one request to the
	 * next.
	 *
	 * The row cap the declared file is measured against (issue #751) is read here
	 * for the same reason the contract is resolved here: the config query is the
	 * provider's to hold, not the URL bar's.
	 */
	const { maxRows: dataFileMaxRows } = useDataFileLimits();
	const sendWithRow = useSendWithRow(dataColumns, dataFileMaxRows);
	const [rowIndexByRequest, setRowIndexByRequest] = useState<Record<string, number>>({});
	// Filed under the same identity as the records above, for the same reason.
	const lastRowIndex = rowIndexByRequest[memoryKey] ?? null;
	const rememberRowIndex = useCallback(
		(index: number) =>
			setRowIndexByRequest((previous) => ({ ...previous, [memoryKey]: index })),
		[memoryKey]
	);
	/*
	 * A Send that carries no row leaves the request bound to none (issue #1062).
	 *
	 * Picking a row is not a setting, it is the row this request is being sent
	 * with, and Send and the send chord both send *without* one - so a pick left
	 * standing across a plain Send would put the row's value in every preview
	 * beside a request that had just gone out with the environment's. That is the
	 * disagreement this issue exists to end, arrived at from the other side. The
	 * picker's own memory is what it always was in every other respect: it
	 * survives a tab switch and a return (issue #659), because neither of those
	 * is a send.
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
	 * What bounds every per-builder map above: the open tabs (issues #1269,
	 * #1271, #1272). An entry - a record, or a picked row index - is only ever
	 * read by the builder it is filed under, so once that builder has no tab it
	 * can never be read again, and a per-builder store that nothing prunes is
	 * how a map becomes a leak. `MAX_OPEN_TABS` caps the tab strip, so this caps
	 * the maps.
	 *
	 * Subscribed to rather than selected, like the reveal command above: a
	 * provider that re-rendered on every tab focus would pay for it on the
	 * request the user is actually working in. The three slots prune a ref, so
	 * they cannot re-render at all; the row memory is state - `lastRowIndex` is
	 * read during render - so `retainKeys` returns the map it was given when it
	 * drops nothing, and React bails out.
	 *
	 * A run tab is swept like a request tab, because the History copy it holds
	 * now files under its run id (issue #1272) and that id names a tab like any
	 * other. Run ids and request ids come from different tables and cannot
	 * collide; a run tab holding no builder - a load test, a scenario - only
	 * ever keeps a key nothing wrote.
	 *
	 * The id-less key survives the sweep: it names no tab, and a builder that
	 * declares no identity of its own is the one whose memory nothing else
	 * could keep.
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
	 * The row the preview resolves against - the picked one, once the file it
	 * came from has actually been read.
	 *
	 * Null until then, including for an index restored from a "Repro row N"
	 * navigation before the picker has opened: the index names a row the app has
	 * not loaded, and previewing against a row nobody has is worse than
	 * previewing the composition.
	 */
	const boundRow = useMemo(
		() =>
			lastRowIndex === null
				? undefined
				: (sendWithRow.parsed?.rows[lastRowIndex] ?? undefined),
		[lastRowIndex, sendWithRow.parsed]
	);

	/*
	 * Publish the bound row for the one preview surface that is not below this
	 * provider: the tab strip (issue #1074). `useTabDescriptors` labels every
	 * open tab from a single list-wide resolver, so it cannot take the row from
	 * this context the way the bar and the panels do - and a tab labelled from
	 * the environment while the bar beneath it shows the file's value is the same
	 * one-bind-two-answers split #1062 closed everywhere else.
	 *
	 * Cleared on unmount as well as whenever there is no row, so the slot cannot
	 * outlive the builder that justified it.
	 */
	const setBoundRow = useBoundRowStore((s) => s.setBoundRow);
	const boundRequestId = request.id ?? null;
	useEffect(() => {
		setBoundRow(
			boundRow && boundRequestId ? { requestId: boundRequestId, row: boundRow } : null
		);
		return () => setBoundRow(null);
	}, [boundRow, boundRequestId, setBoundRow]);

	// Variable resolution
	const {
		resolveString,
		resolveField: resolveStoredField,
		resolveObject,
		getVariable: resolverGetVariable,
		getAllVariables: resolverGetAllVariables,
		getVariableOrigins,
	} = useVariableResolver({ collectionId: collectionId || undefined, boundRow });

	/**
	 * The auth this request will actually send: `inherit` walked through the
	 * collection chain by the shared resolver, then `{{variables}}` resolved for
	 * preview. Null when the request sends no credentials.
	 *
	 * Preview only, like the resolved URL beside it - execution resolves
	 * engine-side (`POST /compose`) and this is never sent. Its reader is the
	 * GraphQL schema cache's identity: keyed on the auth block *as typed*, an
	 * `inherit` was one unchanging value, so editing the ancestor collection's
	 * credential or the environment variable its token interpolates served the
	 * schema fetched with the old one (#383).
	 */
	const collectionAncestors = useCollectionAncestors(collectionId);
	const resolvedAuth = useMemo<Record<string, unknown> | null>(() => {
		const forSend = resolveAuthForSend(request.auth, collectionAncestors);
		// A jwt_bearer `privateKey` names a secret variable; resolving it would
		// put the PEM in this memo and in the schema cache's identity digest.
		return forSend ? keepSigningKeyReferenceInAuth(resolveObject(forSend), forSend) : null;
	}, [request.auth, collectionAncestors, resolveObject]);

	/*
	 * The names a pre-request script sets at send (#2521), so the token painters
	 * stop showing their stored values as what will be sent (#2741). Asked here,
	 * once for the builder, because painting is per editor; and only while the
	 * request holds a `{{token}}`, so a literal request costs no compose. The
	 * answer is the Code section's cache entry, refreshed by the invalidations
	 * that refresh it, never per keystroke.
	 */
	const hasTokens = useMemo(() => requestHasTokens(request), [request]);
	const deferredVariables = useDeferredVariables(request.id ?? "", hasTokens);
	// The field previews (the rows' sigma peek, the Body tab's Resolved pane) leave
	// the same names written, so none of them prints a value the script replaces.
	const resolveField = leaveDeferredField(resolveStoredField, deferredVariables);

	// Variable writes - shared with the collection Elements tab, see useVariableWriter.
	const { updateVariable, writableScopes } = useVariableWriter({
		collectionId: collectionId || undefined,
	});

	/*
	 * Reset when the request the provider was handed changes.
	 *
	 * Adjusted during render rather than from an effect: this is state derived
	 * from props, so an effect would first paint the previous request's state
	 * and then correct it. The trigger is `id` / `initialResponse` - never the
	 * `initialRequest` object itself, which a parent re-render replaces by
	 * reference and which would discard unsaved edits (the reason this carried
	 * an `exhaustive-deps` suppression).
	 *
	 * `collectionId` alone is not a full reset (issue #1436): the same request
	 * moved to a different collection is not a different request, and the
	 * block below this one updates just that field in place.
	 *
	 * The mount pass is covered by the `useState` initialisers above, which set
	 * exactly what this block would.
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
		// A different request: the merge state below starts over from what it
		// was just handed, not from the request we left (issue #1436).
		setBaseline(seeded);
		setTouchedFields(new Set());
		setFieldConflicts({});
		setRecentSends([]);
		setRequestGone(false);
		setLastProcessedInitialRequest(initialRequest);

		// Restore response from store for this request
		const requestId = initialRequest.id;
		if (requestId) {
			const stored = getResponse(requestId);
			setLocalResponse(stored ? (stored as ResponseState) : null);
			// Let the backend restore run again for the request now on screen,
			// unless a stored response already answered for it (#3421).
			setRestoredFor(stored ? requestId : null);
		} else {
			setRestoredFor(null);
			/*
			 * No id, so there is no stored response to restore - fall back to
			 * the one handed in. Clearing it unconditionally (as it used to)
			 * threw away `initialResponse`, and a detached copy opened showing
			 * "No response yet".
			 */
			setLocalResponse(initialResponse ?? null);
		}

		// Restore or default the active tab for whatever request is now on
		// screen - the same per-request lookup the mount-time initializer
		// above uses, needed again here because switching between two open
		// request tabs reuses this provider instance rather than remounting it.
		setActiveTabState(requestId ? (getRequestTab(requestId) ?? "params") : "params");
	} else if (initialRequest && lastReset.collectionId !== collectionId) {
		/*
		 * The same request, moved to a different collection underneath us
		 * (issue #1436, the `move_item` case). The reset above used to treat
		 * this exactly like a different request and discard the whole draft;
		 * now only `collectionId` moves; a dirty body or headers survive.
		 */
		setLastReset((prev) => ({ ...prev, collectionId }));
		const nextCollectionId = collectionId || null;
		setRequestState((prev) => ({ ...prev, collectionId: nextCollectionId }));
		setBaseline((prev) => ({ ...prev, collectionId: nextCollectionId }));
	}

	/*
	 * The request this builder is showing has been deleted elsewhere (issue
	 * #1436): `index.tsx` keeps this provider mounted so the draft survives to
	 * be offered, but stops handing it an `initialRequest` once the fetch 404s.
	 * `request.id` is the guard against a brand-new, id-less builder (the
	 * History run view's detached copy), which never has an `initialRequest`
	 * either and is not "gone".
	 */
	if (!initialRequest && request.id && !requestGone) {
		setRequestGone(true);
	} else if (initialRequest && requestGone) {
		setRequestGone(false);
	}

	/*
	 * The per-field three-way merge (issue #1436), generalizing what used to be
	 * a name-only special case (`useEntityDraft` and #1437's `InfoTab` proved
	 * the shape first, for the collection tabs).
	 *
	 * A field the user has not touched since the last known-good value adopts
	 * an external change silently - `setRequestState`, never `setRequest`,
	 * because adopting someone else's write is not an edit of ours and marking
	 * it dirty would schedule a save that writes back what we just read. A
	 * field the user has touched, to a value the fetch now disagrees with, is
	 * left alone and surfaced in `fieldConflicts` for the caller to show and
	 * let the user resolve. `mergeExternalWrite` does the diffing; this block
	 * only applies its outcome.
	 *
	 * Our own save's echo is not an outside write even when the user kept typing
	 * through the round trip (#3664): the cache hands back what the save sent,
	 * which now disagrees with both `baseline` and the draft. `recentSends` lets
	 * the merge recognise it by value, move `baseline` to it and leave the field
	 * touched, so the next save sends the newer draft. A value no recent save
	 * here sent still conflicts, in flight or not.
	 *
	 * Gated on `initialRequest`'s own identity, not on every render: it is a
	 * content-comparing diff over every mergeable field, and `index.tsx` only
	 * produces a new object when the underlying fetch actually changes.
	 *
	 * Skipped in a render that is a reset (#3662): the reset above has already
	 * seeded `baseline` and cleared `touchedFields` through queued setters, so
	 * this render still reads the previous request's values and would report its
	 * touched fields as conflicts over the fresh state.
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
			// The generation bump this earns happens in the effect above, keyed
			// on `baseline` changing - not here, so nothing during render writes
			// the ref `handleSave`'s in-flight check reads.
			setBaseline(outcome.nextBaseline);
		}
		if (JSON.stringify(outcome.conflicts) !== JSON.stringify(fieldConflicts)) {
			setFieldConflicts(outcome.conflicts);
		}
	}

	/**
	 * Adopt the incoming value for one conflicted field (issue #1436's "Take
	 * theirs"), the per-field sibling of #1437's `InfoTab.takeTheirName`.
	 */
	const takeExternalField = useCallback(
		(field: MergeableRequestField) => {
			const value = fieldConflicts[field];
			if (value === undefined) return;
			// Same cast `updateField` uses below: `field` and `value` are a
			// matched pair by construction, which a plain computed property
			// cannot tell TypeScript on its own.
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
	 * Hand the stored name back when an edit is refused.
	 *
	 * `baseline` holds the last value the request query delivered for every
	 * mergeable field, `name` included - `request.name` is whatever the user
	 * has typed. There is always a baseline once a request is loaded, so
	 * nothing here is conditional the way the old `lastKnownName` state was.
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
	 * Write the drafts a save is carrying into the request on screen (#3666),
	 * leaving the textarea open on them: autosave fires on its own timer, often
	 * mid-typing, and must not close the editor under the caret. No generation
	 * bump and no dirty flag, because this edit is in the payload the save
	 * sends; `handleSave` marks it unsaved if that save fails. Skipped once the
	 * provider shows another request (the goodbye flush of the one left), whose
	 * state this is not; the draft itself is filed under its own key and is
	 * still rebased. Answers whether the request on screen took the drafts.
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

	// Centralized save manager - handles auto-save, keyboard shortcut, and status
	const handleSave = useCallback(async () => {
		if (!onSave) return;
		// Read from state, not the ref: this closure's `request` is the snapshot
		// `onSave` serialises, and `changeToken` is the generation that produced
		// it. The ref holds whatever the newest edit made it, which is the thing
		// we are comparing against.
		const savedGeneration = changeToken;
		// An open Bulk edit draft is saved as if committed (#3666), built into
		// the snapshot here because `request` will not hold it until a render.
		const draftPatch = bulkDraftsPatch(request, bulkDrafts);
		const saving = draftPatch ? { ...request, ...draftPatch } : request;
		const adoptedDrafts = !!draftPatch && adoptSavedDrafts(memoryKey, draftPatch);
		// Snapshotting the set (state is already immutable per update, but the
		// name says what matters): a `setRequest` that lands during the await
		// cannot silently add to what this save already claims to have sent.
		const changedFields = draftPatch
			? withPatchedFields(touchedFields, draftPatch)
			: touchedFields;
		// `buildUpdatePayload` sends the whole `elements` array whenever it is
		// touched (issue #1635), and the engine 400s the *entire* payload on one
		// element it refuses - a fresh `config: {}`, or a value the schema
		// rejects (#3048). So the list alone is held back and every other touched
		// field still goes out: "elements" stays touched, its baseline stays the
		// last saved list, and `SaveBlockedError` (thrown once the rest is
		// recorded) keeps `useSaveManager` at `"pending"` rather than backing off
		// a retry against a payload that will not have changed.
		const elementsHeldBack =
			changedFields.has("elements") &&
			hasIncompleteElement(saving.elements, elementKinds ?? []);
		const sentFields = elementsHeldBack
			? withoutFields(changedFields, ["elements"])
			: changedFields;
		if (elementsHeldBack && sentFields.size === 0) throw new SaveBlockedError();
		const sent = pickFields(saving, sentFields);
		setRecentSends((prev) => [...prev, sent].slice(-SENDS_REMEMBERED));
		try {
			await onSave(saving, sentFields);
		} catch (error) {
			// By identity, not position: a later save may already have appended.
			setRecentSends((prev) => prev.filter((entry) => entry !== sent));
			// The request holds the drafts now, and this save did not write them.
			if (adoptedDrafts) setHasUnsavedChanges(true);
			// The engine names the element it refused (#3043); the failure itself
			// still propagates to `useSaveManager` for its toast and Dock status.
			if (sentFields.has("elements")) refuseElement(error, saving.elements);
			throw error;
		}
		// An edit landed, or a foreign write arrived, while this save was in
		// flight: either way `changeTokenRef` moved and the payload that went
		// out is not the whole story any more, so the request is still dirty
		// and `useSaveManager` has to keep its debounce running for it. The
		// fields this save carried stay touched, since a fresh edit to one of
		// them since the snapshot above would otherwise be forgotten, and their
		// baseline is left to the merge: the cache's echo of this payload moves
		// it, recognised through `recentSends` (#3664).
		const settled = changeTokenRef.current === savedGeneration;
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
		// Not just `!!onSave`: a request deleted elsewhere (issue #1436) must
		// not have its dirty draft's autosave timer - already armed, or about
		// to be - fire a PUT against an id that now 404s.
		enabled: !!onSave && !requestGone,
	});

	// Set request with change tracking
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
	 * Send's commit (#3666): what is on screen is what is sent, so every open
	 * draft is written into the request and closed. Returns the request the
	 * Send carries, built here because `request` will not hold the drafts
	 * until the next render.
	 */
	const commitBulkDraftsForSend = useCallback((): RequestState => {
		const patch = bulkDraftsPatch(request, bulkDrafts);
		setBulkDrafts(memoryKey, () => NO_BULK_DRAFTS);
		if (!patch) return request;
		setRequest(patch);
		return { ...request, ...patch };
	}, [request, bulkDrafts, memoryKey, setBulkDrafts, setRequest]);

	const commitBulkDraft = useCallback(
		(table: BulkTable) => {
			const draft = bulkDrafts[table];
			if (!draft) return;
			const patch = bulkTextPatch(request, table, draft.text);
			if (patch) setRequest(patch);
			setBulkDraft(table, null);
		},
		[request, bulkDrafts, setBulkDraft, setRequest]
	);

	// saveRequest now uses the centralized forceSave
	const saveRequest = useCallback(async () => {
		await forceSave();
	}, [forceSave]);

	// The one field that is state without being data (issue #1229): which engine
	// defaults this send refuses. It is never written to the request, so it must
	// not mark the tab dirty - `setRequest` would, and autosave would then PUT a
	// request whose saved fields nobody touched.
	const setDisabledDefaultHeaders = useCallback((names: string[]) => {
		setRequestState((prev) => ({ ...prev, disabledDefaultHeaders: names }));
	}, []);

	// Update single field
	const updateField = useCallback(
		<K extends keyof RequestState>(field: K, value: RequestState[K]) => {
			setRequest({ [field]: value } as Partial<RequestState>);
		},
		[setRequest]
	);

	// Get variable info
	const getVariable = useCallback(
		(name: string): VariableInfo | null => {
			const info = resolverGetVariable(name);
			if (!info) return null;
			return { value: info.value, scope: info.scope, secret: info.secret };
		},
		[resolverGetVariable]
	);

	// Get all variables.
	//
	// Passed through rather than re-picked field by field. The old version
	// rebuilt each entry as `{ value, scope, secret }`, which silently dropped
	// `sourceName` / `sourceId` (so the popover could name a scope but not the
	// environment) along with `type` / `typedValue`. A hand-copied projection of
	// a type is a place fields go to die; the resolver already produces exactly
	// this shape.
	const getAllVariables = useCallback(
		(): Record<string, VariableInfo> => resolverGetAllVariables(),
		[resolverGetAllVariables]
	);

	/*
	 * The live stream this builder started, if it is still the one the store is
	 * holding. Selected against `request.id` for the same reason the execute
	 * result is: one provider serves every request tab, so rows belonging to a
	 * stream started from another request must not appear under this one.
	 */
	const streamRunId = useExecutionEventsStore((s) =>
		s.requestId && s.requestId === requestId ? s.runId : null
	);
	const isStreaming = useExecutionEventsStore(
		(s) => s.isStreaming && !!s.requestId && s.requestId === requestId
	);
	// One subscription, owned here: the store names which stream, and the
	// provider is the component that outlives every panel that reads it.
	useExecutionEvents();

	/*
	 * Every finished stream run lands in its own request's stored response,
	 * whichever request is on screen (#3382). The live pane is touched only when
	 * that request is the one showing. Only a builder that can start a stream
	 * finalizes one: the History run view's detached copy has no stream handler,
	 * and its provider must not race this one for the global store.
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
			// Nothing is set here on success: the engine drives the run to a
			// terminal status and the relay's `complete` frame - carrying
			// `reason: "stopped"` - is what ends the stream on this side. Ending
			// it locally would report a reason the run never recorded.
		} catch (error) {
			console.error("Failed to stop the event stream:", error);
		}
	}, [streamRunId]);

	/*
	 * Which requests have a send in flight (#3352), filed under `memoryKey` like
	 * every other per-builder map here. `isExecuting` is derived for the request
	 * on screen, so leaving a request mid-send and coming back finds it still
	 * sending, and its Send stays refused until its own answer lands.
	 */
	const [inFlightSends, setInFlightSends] = useState<InFlightSends>(NO_SENDS);
	const [sendTracker] = useState(() => createSendTracker(setInFlightSends));
	const isExecuting = inFlightSends.has(memoryKey);
	const canCancelSend = inFlightSends.get(memoryKey)?.cancellable ?? false;
	const cancelSend = useCallback(() => sendTracker.cancel(memoryKey), [sendTracker, memoryKey]);

	/**
	 * Execute the request.
	 *
	 * `dataRow` is Send-with-row's chosen row (issue #601). It travels to both
	 * handlers rather than only the buffered one: a stream-flagged request in a
	 * data-driven collection binds a row exactly as a buffered one does
	 * engine-side, and a row silently dropped on that path would be the
	 * written-but-never-read defect in its plainest form.
	 */
	const executeRequest = useCallback(
		async (dataRow?: Record<string, unknown>) => {
			// A Send with no row un-binds this request: the previews must describe
			// the request that is going out, not the one the last pick described.
			if (!dataRow) forgetRowIndex();
			// Snapshot the request as it is at Send. If the user switches to another
			// request before this resolves, the result must land on the request that
			// actually ran - not on whatever is on screen when it finishes.
			const executingRequest = commitBulkDraftsForSend();
			const executingId = executingRequest.id;
			// What save-as-example records as the request that produced this
			// response (issue #1763). Taken here, not at Save, so edits made
			// while reading the response stay out of it; only a saved request
			// can hold an example, so an unsaved one takes none.
			const sent = executingId ? sentRequestOf(executingRequest) : undefined;
			// This Send supersedes the note that another request took this one's
			// live feed over, and any finalisation of its earlier stream.
			if (executingId) useExecutionEventsStore.getState().beginSend(executingId);
			/*
			 * Persist under the request that ran, so returning to it shows its own
			 * response; `storeSetResponse` is keyed by id and safe even if this
			 * provider has moved on. The live view is touched only while that request
			 * is on screen - the ref is current, unlike this closure's `executingId`.
			 * An answer from a send that a newer send of the same request overtook
			 * is dropped, so it can never land over the newer one's; so is a
			 * cancelled send's.
			 */
			const land = (send: SendTicket, result: ResponseState) => {
				if (!send.isCurrent()) return;
				if (executingId) storeSetResponse(executingId, result);
				if (currentRequestIdRef.current === executingId) setLocalResponse(result);
			};

			/*
			 * A stream-flagged request takes the other endpoint answer (issue #574):
			 * `202 {runId, eventsUrl}` and no exchange. The buffered path is still
			 * the fallback when this builder was given no stream handler, because a
			 * Send that silently did nothing is worse than one that buffers.
			 */
			if (executingRequest.stream && onExecuteStream) {
				const send = sendTracker.begin(memoryKey);
				setLocalResponse(null);
				if (executingId) useResponseStore.getState().clearResponse(executingId);
				// The pane is now this Send's to fill. Marked answered here, not when
				// the stream opens: a last-design query still loading would otherwise
				// resolve inside the wait for the `202` and fill the earlier run (#3421).
				if (executingId) setRestoredFor(executingId);
				// The previous stream's rows belong to the send that is being
				// replaced. Cleared here rather than on arrival of the first event,
				// so a stream that never opens does not leave the last one on screen.
				// Another request's live stream keeps running at the engine, and the
				// store notes it for that request's pane.
				useExecutionEventsStore.getState().handOver(executingId);
				try {
					const started = await onExecuteStream(executingRequest, dataRow);
					if (!started) return;
					if (!started.ok) {
						land(send, started.response);
						return;
					}
					// An overtaken send's stream is not followed: the feed is the
					// newer send's to open.
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
					 * Finished even though the stream has only just begun. The request
					 * is no longer in flight - the engine has the transfer and has
					 * answered - and leaving the spinner up would hide the Events tab
					 * behind "Sending…" for the whole life of the stream. `isStreaming`
					 * is what reports the rest.
					 */
					send.finish();
				}
				return;
			}

			if (!onExecute) return;

			/*
			 * The previous response stays on screen for the whole send.
			 *
			 * Clearing it here (`setLocalResponse(null)`, which this used to do)
			 * is what made a re-send throw away the exchange the user was
			 * reading: the pane had nothing left but its loading branch, and
			 * fixing that branch alone would only have moved it on to "No
			 * response yet". Either way the status, the headers and the body of
			 * the send before this one were gone from the press of Send -
			 * for a fast request, a blank flash; for a slow one, nothing to
			 * compare the new answer against. `isExecuting` is what the pane
			 * reads to mark it stale, and every path out of `onExecute`
			 * resolves to a response that replaces it (a failure comes back as
			 * a `status: 0` one - see `handleExecute` in `request-builder/`),
			 * so there is no case where the old one is left standing as if it
			 * were the answer to this send. Cancel leaves it standing as what it
			 * was, the last answer, because the request is idle again at once.
			 *
			 * The streaming path above still clears, and must: its pane is fed
			 * by a placeholder built from the relay's `open` frame, and that
			 * placeholder is only built when there is no stored response. It
			 * clears the stored entry as well as the local copy, because the
			 * mount initialiser and the request-switch reset read the store
			 * back, so a stale entry would resurface on the next switch.
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

	// Start load test
	const startLoadTest = useCallback(() => {
		if (onStartLoadTest) {
			onStartLoadTest(request);
		}
	}, [request, onStartLoadTest]);

	// Context value
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
			 * Inside the context, not around it: the `{{token}}` popover the code
			 * editors open is the same one the single-line fields open, and it
			 * needs this provider's `updateVariable` and `writableScopes` to edit
			 * or create anything (issue #1220). Every Monaco editor that
			 * interpolates variables is somewhere under here.
			 *
			 * `contextValue` already carries every field `VariableSupport` needs
			 * (`resolveField`, `getAllVariables`, `getVariableOrigins`,
			 * `updateVariable`, `writableScopes`, `dataColumns`), so it is handed
			 * straight through as `support` rather than read back via
			 * `useVariableSupport()` - that hook reaches for
			 * `useRequestBuilderContext()`, which throws with no provider above it,
			 * and this component has not yet rendered its own
			 * `<RequestBuilderContext.Provider>` at the point a hook call in its own
			 * body would run.
			 */}
			<EditorVariableTokensProvider support={contextValue}>
				{children}
			</EditorVariableTokensProvider>
		</RequestBuilderContext.Provider>
	);
}
