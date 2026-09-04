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

import { useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from "react";
import { RequestBuilderContext } from "./RequestBuilderContext";
import { emptyDrafts, type BodyDrafts, type VariablesDraft } from "../utils/body-drafts";
import { useAutoRecordSlot, UNSAVED_AUTO_KEY } from "./auto-record-slot";
import { retainKeys } from "./retain-keys";
import { useVariableResolver, useSaveManager } from "@/hooks";
import { resolveDataContract } from "@/lib/data-contract";
import { useDataFileLimits } from "@/hooks/useDataFileLimits";
import {
	useCollectionAncestors,
	useGlobalsQuery,
	useUpdateGlobalsMutation,
	useCollectionsQuery,
	useUpdateCollectionMutation,
	useEnvironmentsQuery,
	useUpdateEnvironmentMutation,
	useLastDesignRunQuery,
} from "@/queries";
import {
	useSessionStore,
	useResponseStore,
	useExecutionEventsStore,
	useBoundRowStore,
	useTabsStore,
	type Tab,
} from "@/stores";
import { useRevealStore, type OperationRevealCommand } from "@/lib/graphql/reveal-store";
import { apiService } from "@/services";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries";
import type { ScriptPart, VariableValue } from "@/types";
import type {
	AutoHeader,
	AutoMethod,
	RequestState,
	ResponseState,
	RequestTab,
	StreamStartResult,
	VariableInfo,
	VariableScope,
	RequestBuilderContextValue,
} from "../types";
import { resolveAuthForSend } from "../utils/auth-resolution";
import { createDefaultRequestState } from "../utils/request-state";
import { responseFromRunResult } from "../utils/restore-response";
import { useExecutionEvents } from "../hooks/useExecutionEvents";
import { useSendWithRow } from "../hooks/useSendWithRow";
import { EditorVariableTokensProvider } from "@/components/shared/EditorVariableTokens";

interface RequestBuilderProviderProps {
	children: ReactNode;
	initialRequest?: Partial<RequestState>;
	/**
	 * The identity this builder files its per-builder memory under - the three
	 * auto side-effect records and the picker's row index (issue #1272).
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
	 * Script parts to show as "runs before your own" instead of the live
	 * collection chain. The History run view passes what the run recorded, so a
	 * copy of a past run lists the scripts that actually ran, not the ones the
	 * collection carries today.
	 */
	inheritedPreScripts?: ScriptPart[];
	inheritedPostScripts?: ScriptPart[];
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
	 */
	onExecute?: (
		request: RequestState,
		dataRow?: Record<string, unknown>
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
	onSave?: (request: RequestState) => Promise<void>;
	onStartLoadTest?: (request: RequestState) => void;
}

export default function RequestBuilderProvider({
	children,
	initialRequest,
	memoryKey: declaredMemoryKey,
	initialResponse,
	inheritedPreScripts,
	inheritedPostScripts,
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
	const { getResponse, setResponse: storeSetResponse } = useResponseStore();
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
	 * reads it while rendering.
	 */
	const [restoredFor, setRestoredFor] = useState<string | null>(null);
	const [restoredResponse, setRestoredResponse] = useState<ResponseState | null>(null);

	/*
	 * Load the response from the backend when nothing is cached locally and the
	 * last design run has one (the app-reload case).
	 *
	 * Derived while rendering rather than in an effect: it reads query state and
	 * writes component state, so an effect would paint the empty viewer first and
	 * replace it a frame later. Persisting to the response store is a write to
	 * something outside React, so that half stays in the effect below.
	 */
	if (request.id && !response && !isLoadingLastRun && restoredFor !== request.id) {
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
	const [activeTab, setActiveTab] = useState<RequestTab>("params");

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
	}, [requestId, bodyMode, clearReveal]);
	const [isExecuting, setIsExecuting] = useState(false);
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
	const markDirty = useCallback(() => {
		changeTokenRef.current += 1;
		setChangeToken(changeTokenRef.current);
		setHasUnsavedChanges(true);
	}, []);

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
	 * three records below and the picker's row index further down. One
	 * `RequestBuilderProvider` serves every tab, so a slot holding a single
	 * record held whichever request was in a mode last, and the request before
	 * it kept what the app had changed for it (issue #1269).
	 *
	 * A request tab is its request; a builder over something else says so with
	 * `memoryKey`, because two id-less builders are not one builder (issue
	 * #1272). Spelled once rather than per map - the maps share a sweep, and two
	 * spellings of one rule are how they drift apart.
	 */
	const memoryKey = declaredMemoryKey ?? request.id ?? UNSAVED_AUTO_KEY;

	/*
	 * The Content-Type row a body mode added on its way in, so leaving the mode
	 * can remove it again. Here rather than in `BodyPanel` for the drafts' reason
	 * and one of its own: the panel is unmounted whenever another tab is on
	 * screen, so a panel-local record is gone by the next mode change - and then
	 * the header outlives the mode that needed it, which is the bug the record
	 * exists to fix.
	 *
	 * Not reset by the request-change effect below, for the same reason as the
	 * drafts: the record names its own request and `switchContentType` drops one
	 * belonging to another.
	 */
	const {
		get: getAutoContentType,
		set: setAutoContentType,
		retain: retainAutoContentTypes,
	} = useAutoRecordSlot<AutoHeader>(memoryKey);

	/*
	 * The `Accept: text/event-stream` row the Event stream toggle added, so
	 * turning the toggle off can take it back (issue #574). Here rather than in
	 * `SettingsPanel` for the reason above it: Radix unmounts an inactive
	 * `TabsContent`, so a panel-local record is gone the moment you look at
	 * another tab - and then the header outlives the setting that needed it,
	 * which is exactly the bug the record exists to prevent.
	 */
	const {
		get: getAutoAccept,
		set: setAutoAccept,
		retain: retainAutoAccepts,
	} = useAutoRecordSlot<AutoHeader>(memoryKey);

	/*
	 * The method the GraphQL body mode set, so leaving the mode can put back
	 * the one it replaced (issue #1228). Here for the same reason as the two
	 * above - the panel that writes it is unmounted whenever another tab is on
	 * screen, and a record that does not outlive the panel leaves the method
	 * changed with nothing left to change it back.
	 */
	const {
		get: getAutoMethod,
		set: setAutoMethod,
		retain: retainAutoMethods,
	} = useAutoRecordSlot<AutoMethod>(memoryKey);

	// What bounds these three is stated with the row memory below, which the
	// same sweep bounds (issue #1271): one rule over every per-builder map the
	// provider holds, rather than one rule each.

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
			retainAutoContentTypes(live);
			retainAutoAccepts(live);
			retainAutoMethods(live);
			retainRowIndexes(live);
		};
		return useTabsStore.subscribe((s) => retainOpen(s.openTabs));
	}, [retainAutoContentTypes, retainAutoAccepts, retainAutoMethods, retainRowIndexes]);

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
		return forSend ? resolveObject(forSend) : null;
	}, [request.auth, collectionAncestors, resolveObject]);

	// Variable update mutations
	const { activeEnvironmentId } = useSessionStore();
	const { data: globalsData } = useGlobalsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();
	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();

	/*
	 * Reset when the request the provider was handed changes.
	 *
	 * Adjusted during render rather than from an effect: this is state derived
	 * from props, so an effect would first paint the previous request's state
	 * and then correct it. The trigger is `id` / `collectionId` /
	 * `initialResponse` - never the `initialRequest` object itself, which a
	 * parent re-render replaces by reference and which would discard unsaved
	 * edits (the reason this carried an `exhaustive-deps` suppression).
	 *
	 * The mount pass is covered by the `useState` initialisers above, which set
	 * exactly what this block would.
	 */
	const [lastReset, setLastReset] = useState({
		id: initialRequest?.id,
		collectionId,
		initialResponse,
	});
	if (
		initialRequest &&
		(lastReset.id !== initialRequest.id ||
			lastReset.collectionId !== collectionId ||
			lastReset.initialResponse !== initialResponse)
	) {
		setLastReset({ id: initialRequest.id, collectionId, initialResponse });
		// Let the backend restore run again for whatever request is now on screen.
		setRestoredFor(null);
		setRestoredResponse(null);
		setRequestState({
			...createDefaultRequestState(),
			...initialRequest,
			collectionId: collectionId || null,
		});
		setHasUnsavedChanges(false);
		// Clear any executing state carried over from the request we just left.
		// It belongs to that request's in-flight run, not this one; without this
		// the switched-to request shows a "Sending" spinner it never triggered.
		setIsExecuting(false);

		// Restore response from store for this request
		const requestId = initialRequest.id;
		if (requestId) {
			const stored = getResponse(requestId);
			setLocalResponse(stored ? (stored as ResponseState) : null);
		} else {
			/*
			 * No id, so there is no stored response to restore - fall back to
			 * the one handed in. Clearing it unconditionally (as it used to)
			 * threw away `initialResponse`, and a detached copy opened showing
			 * "No response yet".
			 */
			setLocalResponse(initialResponse ?? null);
		}
	}

	/*
	 * Adopt a name that changed underneath us.
	 *
	 * The reset above only fires on a change of `id`, and a rename does not
	 * change the id - so the name the builder holds was, until this block, a
	 * snapshot taken when the tab opened. That staleness is why the save payload
	 * used to omit `name` entirely: an edit made minutes after a sidebar rename
	 * fired a debounced auto-save carrying the pre-rename name and clobbered it.
	 *
	 * Keyed on the incoming *value*, not on the render: while the user types in
	 * the Info tab the prop is unchanged, so nothing overwrites the local edit.
	 * When their save lands the mutation writes the detail cache, the prop
	 * changes, and this adopts the stored (trimmed) name - which also settles
	 * the post-trim divergence rather than leaving the field permanently dirty
	 * against its own saved value.
	 *
	 * `setRequestState`, not `setRequest`: adopting someone else's write is not
	 * an unsaved change of ours, and marking it dirty would schedule a save that
	 * writes back what we just read.
	 */
	const [lastKnownName, setLastKnownName] = useState(initialRequest?.name);
	if (initialRequest?.name !== undefined && initialRequest.name !== lastKnownName) {
		const adopted = initialRequest.name;
		setLastKnownName(adopted);
		setRequestState((prev) => ({ ...prev, name: adopted }));
	}

	/*
	 * The other half of that: hand the stored name back when an edit is refused.
	 *
	 * `lastKnownName` is the last value the request query delivered, which is
	 * the only copy of it here - `request.name` is whatever the user has typed.
	 * Undefined only for a request the provider was handed without one, where
	 * there is nothing to restore and leaving the field alone is the honest
	 * answer.
	 */
	const restoreStoredName = useCallback(() => {
		if (lastKnownName === undefined) return;
		setRequestState((prev) =>
			prev.name === lastKnownName ? prev : { ...prev, name: lastKnownName }
		);
	}, [lastKnownName]);

	// Centralized save manager - handles auto-save, keyboard shortcut, and status
	const handleSave = useCallback(async () => {
		if (!onSave) return;
		// Read from state, not the ref: this closure's `request` is the snapshot
		// `onSave` serialises, and `changeToken` is the generation that produced
		// it. The ref holds whatever the newest edit made it, which is the thing
		// we are comparing against.
		const savedGeneration = changeToken;
		await onSave(request);
		// An edit landed while this save was in flight: it is not in the payload
		// that went out, so the request is still dirty and `useSaveManager` has
		// to keep its debounce running for it.
		if (changeTokenRef.current !== savedGeneration) return;
		setHasUnsavedChanges(false);
	}, [request, changeToken, onSave]);

	const {
		forceSave,
		status: saveStatus,
		isSaving,
	} = useSaveManager({
		entityId: request.id || null,
		onSave: handleSave,
		hasChanges: hasUnsavedChanges,
		changeToken,
		enabled: !!onSave,
	});

	// Set request with change tracking
	const setRequest = useCallback(
		(updates: Partial<RequestState>) => {
			setRequestState((prev) => ({ ...prev, ...updates }));
			markDirty();
		},
		[markDirty]
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
	 * Merge one variable into a scope's map.
	 *
	 * Written once rather than three times. The three branches below were
	 * identical apart from where they wrote, and identical code in three places
	 * is three places for a rule to diverge - which is what happened: each
	 * spread the existing entry to keep its flags, so writing a value to a
	 * variable that was **disabled** preserved `enabled: false`.
	 *
	 * That produced exactly the dead end the popover's Create button exists to
	 * remove. A name disabled at every scope does not resolve, so the token is
	 * red and the popover offers to create it; the write then landed on the
	 * disabled entry, kept it disabled, and the token stayed red. The button
	 * appeared to work and changed nothing visible.
	 *
	 * So a write through this path always enables. Setting a value here means
	 * "make this value apply" - there is no caller for whom writing a value and
	 * leaving it switched off is the intent, and the variables editor is where
	 * enabling and disabling actually belongs.
	 *
	 * An existing entry is spread, so its `createdAt` - the variables editor's
	 * row-ordering key - survives untouched, including when it is *absent*, which
	 * that editor reads as "older than everything". Only a variable created here
	 * is stamped, so it lands at the bottom of its scope's list rather than above
	 * every row that already existed (issue #135).
	 */
	const mergeVariable = (
		existing: Record<string, VariableValue> | undefined,
		name: string,
		newValue: string
	): Record<string, VariableValue> => {
		const current = existing?.[name];
		return {
			...existing,
			[name]: current
				? { ...current, value: newValue, enabled: true }
				: { value: newValue, enabled: true, createdAt: Date.now() },
		};
	};

	// Update variable value.
	const updateVariable = useCallback(
		(name: string, newValue: string, scope: VariableScope) => {
			switch (scope) {
				case "global": {
					if (!globalsData?.variables) return;
					updateGlobalsMutation.mutate({
						variables: mergeVariable(globalsData.variables, name, newValue),
					});
					break;
				}
				case "collection": {
					if (!collectionId) return;
					const collection = collections.find((c) => c.id === collectionId);
					if (!collection) return;
					updateCollectionMutation.mutate({
						id: collectionId,
						variables: mergeVariable(collection.variables, name, newValue),
					});
					break;
				}
				case "environment": {
					if (!activeEnvironmentId) return;
					const environment = environments.find((e) => e.id === activeEnvironmentId);
					if (!environment) return;
					updateEnvironmentMutation.mutate({
						id: activeEnvironmentId,
						variables: mergeVariable(environment.variables, name, newValue),
					});
					break;
				}
			}
		},
		[
			globalsData,
			collections,
			environments,
			collectionId,
			activeEnvironmentId,
			updateGlobalsMutation,
			updateCollectionMutation,
			updateEnvironmentMutation,
		]
	);

	/*
	 * Which scopes `updateVariable` would actually write to, derived from the
	 * same three guards it opens each branch with.
	 *
	 * Kept beside it deliberately: this is the config-defined-in-one-branch,
	 * re-derived-in-another shape that has bitten this codebase before, so if a
	 * guard changes above, this list is the next thing in the file to change.
	 * A caller that offers a scope not in here gets a silent no-op.
	 */
	const writableScopes = useMemo((): VariableScope[] => {
		const scopes: VariableScope[] = [];
		if (globalsData?.variables) scopes.push("global");
		if (collectionId && collections.some((c) => c.id === collectionId))
			scopes.push("collection");
		if (activeEnvironmentId && environments.some((e) => e.id === activeEnvironmentId)) {
			scopes.push("environment");
		}
		return scopes;
	}, [globalsData, collections, collectionId, environments, activeEnvironmentId]);

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
	const streamEndReason = useExecutionEventsStore((s) =>
		s.requestId && s.requestId === requestId ? s.endReason : null
	);

	// One subscription, owned here: the store names which stream, and the
	// provider is the component that outlives every panel that reads it.
	useExecutionEvents();

	/*
	 * When the stream ends, replace the live rows with what the run stored.
	 *
	 * The two-sources-one-list handoff `ScenarioRunView` makes, at the moment
	 * the source changes: while the stream is open the Events tab reads the
	 * store, and the completed run's trace is the record - bounded by
	 * `sseMaxStoredEvents` and carrying the truthful `totalEvents` /
	 * `eventsTruncated` markers, which the live list has no way to know. Without
	 * this the tab would keep showing whatever happened to arrive on the socket,
	 * and a switch to another request and back would show nothing at all, since
	 * the durable copy of a response is the response store.
	 *
	 * The report is fetched directly rather than through the last-design-run
	 * query the cold-start restore uses: that query is keyed by request and its
	 * restore is gated on having answered once, so waiting for it to refetch
	 * would race the cache. Here the run id is already known.
	 */
	useEffect(() => {
		if (!streamRunId || !streamEndReason) return;
		let cancelled = false;
		void (async () => {
			try {
				const report = await apiService.getRunReport(streamRunId);
				const restored = responseFromRunResult(report?.results?.[0], streamRunId);
				if (cancelled || !restored) return;
				// Keyed by the request that streamed, exactly like the execute
				// path: `storeSetResponse` is safe even if the builder has since
				// moved on, and the live pane is only touched when it has not.
				if (requestId) storeSetResponse(requestId, restored);
				if (currentRequestIdRef.current === requestId) setLocalResponse(restored);
			} catch {
				// The rows already on screen came from the stream itself and are
				// still true; failing to fetch the stored copy does not make them
				// false, so nothing is torn down. The stream's own end reason is
				// what the tab reports either way.
			}
			if (cancelled) return;
			// A stream that ended is a finished design run: History and the
			// context bar's Recent sends both list it, and neither is told by
			// anything else.
			void queryClient.invalidateQueries({ queryKey: queryKeys.runs.lists() });
			if (requestId) {
				void queryClient.invalidateQueries({
					queryKey: queryKeys.runs.recentDesign(requestId),
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [streamRunId, streamEndReason, requestId, storeSetResponse]);

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
			const executingRequest = request;
			const executingId = executingRequest.id;

			/*
			 * A stream-flagged request takes the other endpoint answer (issue #574):
			 * `202 {runId, eventsUrl}` and no exchange. The buffered path is still
			 * the fallback when this builder was given no stream handler, because a
			 * Send that silently did nothing is worse than one that buffers.
			 */
			if (executingRequest.stream && onExecuteStream) {
				setIsExecuting(true);
				setLocalResponse(null);
				// The previous stream's rows belong to the send that is being
				// replaced. Cleared here rather than on arrival of the first event,
				// so a stream that never opens does not leave the last one on screen.
				useExecutionEventsStore.getState().clear();
				try {
					const started = await onExecuteStream(executingRequest, dataRow);
					if (!started) return;
					if (!started.ok) {
						if (executingId) storeSetResponse(executingId, started.response);
						if (currentRequestIdRef.current === executingId) {
							setLocalResponse(started.response);
						}
						return;
					}
					useExecutionEventsStore.getState().startStream({
						requestId: executingId,
						runId: started.runId,
						eventsUrl: started.eventsUrl,
					});
				} catch (error) {
					console.error("Request execution failed:", error);
				} finally {
					/*
					 * Cleared even though the stream has only just begun. The request
					 * is no longer in flight - the engine has the transfer and has
					 * answered - and leaving the spinner up would hide the Events tab
					 * behind "Sending…" for the whole life of the stream. `isStreaming`
					 * is what reports the rest.
					 */
					if (currentRequestIdRef.current === executingId) {
						setIsExecuting(false);
					}
				}
				return;
			}

			if (!onExecute) return;

			setIsExecuting(true);
			setLocalResponse(null);

			try {
				const result = await onExecute(executingRequest, dataRow);
				if (result) {
					// Persist under the request that ran, so returning to it shows its
					// own response. `storeSetResponse` is keyed by id and is safe even
					// if this provider has since moved on to another request.
					if (executingId) storeSetResponse(executingId, result);
					// Only touch the shared live view if that request is still on
					// screen. The ref reflects the current request, unlike this
					// closure's frozen `executingId`.
					if (currentRequestIdRef.current === executingId) {
						setLocalResponse(result);
					}
				}
			} catch (error) {
				console.error("Request execution failed:", error);
			} finally {
				// Same guard: a stale finish must not clear the spinner of a different
				// request the user has since started.
				if (currentRequestIdRef.current === executingId) {
					setIsExecuting(false);
				}
			}
		},
		[request, onExecute, onExecuteStream, storeSetResponse, forgetRowIndex]
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
			getBodyDrafts,
			setBodyDrafts,
			getVariablesDraft,
			setVariablesDraft,
			getAutoContentType,
			setAutoContentType,
			getAutoAccept,
			setAutoAccept,
			getAutoMethod,
			setAutoMethod,
			response,
			setResponse,
			inheritedPreScripts,
			inheritedPostScripts,
			legacyPreScript,
			legacyPostScript,
			activeTab,
			setActiveTab,
			isExecuting,
			isStreaming,
			stopStream,
			isSaving,
			hasUnsavedChanges,
			saveStatus,
			resolveString,
			resolveVariables: resolveString,
			resolvedAuth,
			getVariable,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			dataColumns,
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
			getBodyDrafts,
			setBodyDrafts,
			getVariablesDraft,
			setVariablesDraft,
			getAutoContentType,
			setAutoContentType,
			getAutoAccept,
			setAutoAccept,
			getAutoMethod,
			setAutoMethod,
			response,
			setResponse,
			inheritedPreScripts,
			inheritedPostScripts,
			legacyPreScript,
			legacyPostScript,
			activeTab,
			isExecuting,
			isStreaming,
			stopStream,
			isSaving,
			hasUnsavedChanges,
			saveStatus,
			resolveString,
			resolvedAuth,
			getVariable,
			getAllVariables,
			getVariableOrigins,
			updateVariable,
			writableScopes,
			dataColumns,
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
			 */}
			<EditorVariableTokensProvider>{children}</EditorVariableTokensProvider>
		</RequestBuilderContext.Provider>
	);
}
