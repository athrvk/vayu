/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The variables table for every scope (globals, an environment, a collection), configured by
 * `config`: data source and mutations, colours and icons, header content, and extra actions (an
 * environment's delete).
 *
 * **It does not mount `components/shared/KeyValueEditor`, a settled decision** (#564, confirmed in
 * #587). A hand-rolled copy of a primitive misses the primitive's fixes, but this is a different
 * table, not a copy: the shared one is a fixed grid of key, value and a row action that commits on
 * every change; this one adds a per-row type select and a secret toggle, masks the value cell,
 * commits text on blur and toggles at once, and orders rows by a `createdAt` stamp rather than a
 * trailing-blank rule. Folding it in would take a dynamic column model, a commit model and
 * variables-domain fields on `KeyValueItem`: a redesign of the primitive for one consumer, paid for
 * by its three existing ones.
 *
 * The rule does bind the reveal control, extracted from this file into `ui/secret-input`, which
 * then got fixes this table never had (the `tabIndex={-1}` removal, `aria-pressed`); the value cell
 * mounts `SecretInput` for that reason. `key-value-parity.test.tsx` pins what the two tables keep
 * in common (control height, checkbox clearance and sizing, the shared destructive row-action
 * variant, this reveal control), so the next fix to either side fails loudly instead of drifting.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Globe, Cloud, Folder, Trash2, LucideIcon } from "lucide-react";
import {
	useGlobalsQuery,
	useUpdateGlobalsMutation,
	useUpdateEnvironmentMutation,
	useSetActiveEnvironmentMutation,
	useDeleteEnvironmentMutation,
	useUpdateCollectionMutation,
} from "@/queries";
import { useClientSettingsStore, useSaveStore, useSessionStore, useToastStore } from "@/stores";
import type { SaveOutcome } from "@/stores/save-store";
import { useTrashUndo } from "@/hooks/useTrashUndo";
import { useVariablesStore } from "@/modules/variables/variables-store";
import type { VariableValue, Collection, Environment } from "@/types";
import {
	Button,
	Badge,
	DeleteConfirmDialog,
	TooltipIconButton,
	environmentDeleteDescription,
} from "@/components/ui";
import { Callout, DetailSkeleton, ErrorState } from "@/components/shared";
import { pluralize } from "@/modules/dashboard/utils/format";
import { cn } from "@/lib/utils";
import { saveFailureOutcome, saveRetryDelayMs } from "@/lib/save-failure";
import { sortVariableEntriesByCreatedAt } from "@/lib/variable-order";
import type { VariableType } from "@/lib/variable-cast";
import {
	mergeVariableChanges,
	findVariableConflicts,
	variableValuesEqual,
	type VariableMap,
	type VariableChanges,
	type VariableConflict,
} from "@/lib/variable-merge";
import type { VariableScope } from "@/lib/agent-reference";
import VariableRow from "./VariableRow";
import {
	NAME_PROBLEM_MESSAGE,
	isAddressableName,
	nameProblems,
	type NameProblem,
	trimVariableName,
	withTrimmedNames,
} from "./variableRowNames";

export interface VariableRowData {
	/**
	 * Editor-local row identity, never persisted (`toVariableValue` builds the payload field by
	 * field, so it cannot leak). A variable has no stable identity of its own: `key` is editable,
	 * so keying by it moves state on rename, and `createdAt` is absent on rows written before the
	 * field existed. Keyed by array position, which changes on a delete, the row shifting up
	 * inherited the deleted row's mounted `SecretInput`, value and all, so a secret the user never
	 * revealed was displayed (#621). The id follows the row for as long as the editor is mounted,
	 * and React's `key` and every piece of per-row UI state with it.
	 */
	id: string;
	key: string;
	/**
	 * The name the server stores this row under, as of the last seed or save;
	 * absent for a row never saved. `key` is what the user is typing, so a rename
	 * or a cleared name loses track of which stored variable the row stands for,
	 * and a save that did not know would delete it (#3251). Never persisted.
	 */
	baseKey?: string;
	value: string;
	enabled: boolean;
	secret?: boolean;
	type?: VariableType;
	createdAt?: number;
	isNew?: boolean;
	/**
	 * What the stored value carries that this table has no column for (a Postman import's
	 * `description`), written back untouched so an edit does not drop it.
	 */
	extra?: Record<string, unknown>;
}

/**
 * Monotonic within the session, all "stable" has to mean here: ids live and die with the mounted
 * editor and are never compared against anything outside it.
 */
let lastRowId = 0;
function nextRowId(): string {
	lastRowId += 1;
	return `vrow-${lastRowId}`;
}

/** The trailing "type here to add one" row; a reseed passes the current blank row's id. */
function blankRow(id: string = nextRowId()): VariableRowData {
	return { id, key: "", value: "", enabled: true, secret: false, type: "string", isNew: true };
}

type VariableEditorType = "globals" | "environment" | "collection";

/**
 * Row-wise equality over every field a row carries, telling "the cache echo of the save I just
 * made" from "someone typed while it was in flight": clearing the dirty flag versus silently losing
 * an edit. By value, not array identity: a reseed producing identical rows must count as unchanged,
 * or the editor stays dirty forever. `id` is excluded: it is UI identity, not user data, so
 * counting it would be the same dirty-forever bug.
 */
function sameRows(a: VariableRowData[], b: VariableRowData[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((row, i) => {
		const other = b[i];
		return (
			row.key === other.key &&
			row.value === other.value &&
			row.enabled === other.enabled &&
			(row.secret ?? false) === (other.secret ?? false) &&
			(row.type ?? "string") === (other.type ?? "string") &&
			row.createdAt === other.createdAt &&
			(row.isNew ?? false) === (other.isNew ?? false)
		);
	});
}

function nameErrorFor(problem: NameProblem | undefined): string | undefined {
	return problem && NAME_PROBLEM_MESSAGE[problem];
}

function toVariableValue(row: VariableRowData): VariableValue {
	return {
		...row.extra,
		value: row.value,
		enabled: row.enabled,
		secret: row.secret ?? false,
		type: row.type ?? "string",
		// An unknown creation time is never invented, only carried forward.
		...(row.createdAt !== undefined && { createdAt: row.createdAt }),
	};
}

function rowFromValue(key: string, value: VariableValue, id?: string): VariableRowData {
	const { value: text, enabled, secret, type, createdAt, ...extra } = value;
	return {
		id: id ?? nextRowId(),
		key,
		baseKey: key,
		value: text,
		enabled,
		secret: secret ?? false,
		type: type ?? "string",
		createdAt,
		...(Object.keys(extra).length > 0 && { extra }),
	};
}

/**
 * The rows the user has edited since `baseline`, as a diff, not a snapshot: a key the diff does not
 * name is one the save never touches, which is what lets `mergeVariableChanges` carry a concurrent
 * write for it through. A key in `baseline` but no longer among the rows is a deletion.
 *
 * A row with a name problem (`nameProblems`) writes nothing, and its variable stays: only the
 * explicit Delete removes a key, so a name the user is fixing never costs them the variable
 * (#3251). The exception is a stored name the engine would refuse (a legacy blank or padded key):
 * keeping it would make every save a 400, and `{{ name }}` could never reach it, so it is dropped
 * from the blob while the row stays on screen to be named. Names are trimmed here, so the payload
 * key is the one the engine accepts.
 */
function computeUserChanges(rows: VariableRowData[], baseline: VariableMap): VariableChanges {
	const changes: VariableChanges = {};
	const seenKeys = new Set<string>();
	const problems = nameProblems(rows);
	rows.forEach((row) => {
		if (row.isNew) return;
		if (problems.has(row.id)) {
			if (row.baseKey !== undefined && isAddressableName(row.baseKey)) {
				seenKeys.add(row.baseKey);
			}
			return;
		}
		const key = trimVariableName(row.key);
		seenKeys.add(key);
		const value = toVariableValue(row);
		if (!variableValuesEqual(baseline[key], value)) changes[key] = value;
	});
	Object.keys(baseline).forEach((key) => {
		if (!seenKeys.has(key)) changes[key] = null;
	});
	return changes;
}

/**
 * What a save is computed from: the rows on screen, the map they are diffed
 * against, and the freshest map known for the scope, which the save merges onto.
 */
interface EditorSnapshot {
	rows: VariableRowData[];
	baseline: VariableMap;
	fresh: VariableMap;
}

/** Every key both the user and another writer moved, and to different values. */
function conflictsOf({ rows, baseline, fresh }: EditorSnapshot): VariableConflict[] {
	return findVariableConflicts(baseline, computeUserChanges(rows, baseline), fresh);
}

/** `map` with `key` taken from `source`: copied, or dropped where `source` has none. */
function withKeyFrom(map: VariableMap, key: string, source: VariableMap): VariableMap {
	const next = { ...map };
	if (Object.prototype.hasOwnProperty.call(source, key)) next[key] = source[key];
	else delete next[key];
	return next;
}

/**
 * The row that stands for stored variable `key`, or -1: the one still stored
 * under it, else the one named it (a name is compared trimmed, as it is saved),
 * else the one renamed away from it.
 */
function rowIndexFor(rows: VariableRowData[], key: string): number {
	const standsFor = [
		(row: VariableRowData) => row.baseKey === key && trimVariableName(row.key) === key,
		(row: VariableRowData) => trimVariableName(row.key) === key,
		(row: VariableRowData) => row.baseKey === key,
	];
	for (const matches of standsFor) {
		const index = rows.findIndex((row) => !row.isNew && matches(row));
		if (index !== -1) return index;
	}
	return -1;
}

/**
 * `rows` with stored variable `key` set to the other writer's value: the row
 * standing for it replaced (a rename of it undone), or a row added before the
 * blank one; with no value there, that row removed.
 */
function withTheirs(
	rows: VariableRowData[],
	key: string,
	theirs: VariableValue | undefined
): VariableRowData[] {
	const index = rowIndexFor(rows, key);
	if (!theirs) return index === -1 ? rows : rows.filter((_, i) => i !== index);
	const row = rowFromValue(key, theirs, index === -1 ? undefined : rows[index].id);
	if (index !== -1) return rows.map((current, i) => (i === index ? row : current));
	const blank = rows.findIndex((current) => current.isNew);
	return blank === -1 ? [...rows, row] : [...rows.slice(0, blank), row, ...rows.slice(blank)];
}

interface SavePlan {
	/** The rows the save is for, names trimmed. */
	rows: VariableRowData[];
	problems: ReturnType<typeof nameProblems>;
	/** The keys the save sends, conflicted keys left out. */
	changes: VariableChanges;
	/** Held out of `changes` until the user picks a side. */
	conflicts: VariableConflict[];
	/** The whole map the PUT carries, in `createdAt` order. */
	payload: VariableMap;
}

/**
 * The user's own changes merged onto the freshest map, never the editor's whole copy, which would
 * revert a key an MCP agent wrote after this editor last reseeded (#1439). A key both sides moved
 * is left out until the user chooses (#3353): saving it would be choosing for them. Payload order
 * is by `createdAt`, so the round trip keeps display order.
 */
function planSave(snapshot: EditorSnapshot): SavePlan {
	// Names are trimmed on commit, not per keystroke: a trailing space typed
	// mid-name has to survive until the user leaves the field (#3251).
	const rows = withTrimmedNames(snapshot.rows);
	const changes = computeUserChanges(rows, snapshot.baseline);
	const conflicts = findVariableConflicts(snapshot.baseline, changes, snapshot.fresh);
	for (const { key } of conflicts) delete changes[key];
	const merged = mergeVariableChanges(snapshot.fresh, changes);
	return {
		rows,
		problems: nameProblems(rows),
		changes,
		conflicts,
		payload: Object.fromEntries(sortVariableEntriesByCreatedAt(Object.entries(merged))),
	};
}

/**
 * The baseline once `plan` has landed: the map it wrote, so the save's own write is never mistaken
 * for a later external change. A conflicted key it held back keeps its old baseline, or the
 * conflict would vanish as if the user had chosen.
 */
function baselineAfter(plan: SavePlan, current: VariableMap): VariableMap {
	return plan.conflicts.reduce((next, { key }) => withKeyFrom(next, key, current), plan.payload);
}

interface SaveHandlers {
	onSuccess: () => void;
	onError: (error: unknown) => void;
}

/**
 * Runs a mutation and reports through both of TanStack's channels: the per-call callbacks fire as
 * it settles, but only while its observer has listeners, so never once the editor has unmounted;
 * the promise always settles. The caller acts on whichever arrives first.
 */
function sendThrough<V>(
	mutateAsync: (variables: V, options: SaveHandlers) => Promise<unknown>,
	variables: V,
	handlers: SaveHandlers
): void {
	mutateAsync(variables, handlers).then(() => handlers.onSuccess(), handlers.onError);
}

/**
 * A save, bound to its entity when it is asked for. `send` is null when the
 * entity is gone; `snapshot` is what the save is computed from if the editor
 * has moved to another entity before the save's turn comes.
 */
interface SaveTarget {
	contextId: string;
	scope: VariableEditorType;
	send: ((variables: VariableMap, handlers: SaveHandlers) => void) | null;
	snapshot: EditorSnapshot;
}

/** A save waiting for the one in flight; it reads the rows when it starts. */
interface WaitingSave {
	target: SaveTarget;
	promise: Promise<SaveOutcome>;
	resolve: (outcome: SaveOutcome | Promise<SaveOutcome>) => void;
}

interface VariableEditorConfig {
	type: VariableEditorType;
	// For globals
	globalsData?: { variables?: Record<string, VariableValue> } | null;
	isLoading?: boolean;
	error?: Error | null;
	// For environment
	environment?: Environment;
	// For collection
	collection?: Collection;
}

// The three infoText banners state the ladder in docs/app/variable-resolution.md
// (globals < collection chain < active environment < bound data row); edit them
// together with it.
const EDITOR_CONFIGS = {
	globals: {
		icon: Globe as LucideIcon,
		iconColor: "text-scope-global",
		title: "Global variables",
		subtitle: "Global scope",
		infoText:
			"Variables in this scope are available in all requests (lowest priority). Overridden by environment and collection scopes.",
		infoBg: "bg-scope-global/10",
		infoTextColor: "text-scope-global",
		infoBorder: "border-scope-global/20",
		checkboxColor: "checked:bg-scope-global checked:border-scope-global",
	},
	environment: {
		icon: Cloud as LucideIcon,
		iconColor: "text-scope-environment",
		title: (name: string) => name,
		subtitle: "Environment scope",
		infoText:
			"Variables in this scope override collection and global variables. While a data row is bound, its bare column names override these.",
		infoBg: "bg-scope-environment/10",
		infoTextColor: "text-scope-environment",
		infoBorder: "border-scope-environment/20",
		checkboxColor: "checked:bg-scope-environment checked:border-scope-environment",
	},
	collection: {
		icon: Folder as LucideIcon,
		iconColor: "text-scope-collection",
		title: (name: string) => name,
		subtitle: "Collection scope",
		infoText:
			"Variables in this scope override globals and are overridden by the active environment. A nested collection's variables override its parent's.",
		infoBg: "bg-scope-collection/10",
		infoTextColor: "text-scope-collection",
		infoBorder: "border-scope-collection/20",
		checkboxColor: "checked:bg-scope-collection checked:border-scope-collection",
	},
} as const;

interface VariableEditorProps {
	config: VariableEditorConfig;
	/**
	 * Embedded mode drops the standalone chrome (title header, info banner, count footer) so the
	 * editor can sit inside another container, such as CollectionDetail's Variables tab, without
	 * doubled headings or a fight with the host layout.
	 */
	embedded?: boolean;
}

export default function VariableEditor({ config, embedded = false }: VariableEditorProps) {
	const { type, globalsData, isLoading, error, environment, collection } = config;
	const editorConfig = EDITOR_CONFIGS[type];

	const globalsQuery = useGlobalsQuery();
	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();
	const deleteEnvironmentMutation = useDeleteEnvironmentMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();

	const setSelectedCategory = useVariablesStore((s) => s.setSelectedCategory);
	const setActiveEnvironment = useSetActiveEnvironmentMutation();
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	// Per-field selectors, not a bare `useSaveStore()`: the whole store would subscribe this editor
	// to `status`, `lastErrorMessage`, `activeContextId` and `contexts`, re-rendering it on every
	// save in the app though only these stable actions are read (#1714).
	const registerContext = useSaveStore((s) => s.registerContext);
	const unregisterContext = useSaveStore((s) => s.unregisterContext);
	const updateContext = useSaveStore((s) => s.updateContext);
	const setActiveContext = useSaveStore((s) => s.setActiveContext);
	const reportPending = useSaveStore((s) => s.reportPending);
	const reportSaving = useSaveStore((s) => s.reportSaving);
	const reportSaved = useSaveStore((s) => s.reportSaved);
	const reportFailed = useSaveStore((s) => s.reportFailed);
	const discard = useSaveStore((s) => s.discard);
	const showToast = useToastStore((s) => s.showToast);
	const offerUndo = useTrashUndo();

	const [variables, setVariables] = useState<VariableRowData[]>([]);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [hasPendingChanges, setHasPendingChanges] = useState(false);
	const [conflicts, setConflicts] = useState<VariableConflict[]>([]);
	const variablesRef = useRef<VariableRowData[]>([]);
	// Shown beside each row. The save recomputes the same judgement from the ref,
	// so a row is judged on what it holds when the save runs.
	const rowProblems = useMemo(() => nameProblems(variables), [variables]);
	const performSaveRef = useRef<() => Promise<SaveOutcome>>(() => Promise.resolve("saved"));
	/**
	 * The map the user's edits are diffed against: the state a save last agreed on with the server.
	 * Advanced on every full reseed, on a successful save (`baselineAfter`), and per key when the
	 * user picks a side of a conflict. Saves run one at a time, so the save that advances it last
	 * carried the latest rows.
	 */
	const baselineRef = useRef<VariableMap>({});
	/**
	 * The freshest map known for the scope, which a save merges onto: the query
	 * cache's, or a landed save's changes applied over it until the cache echo
	 * arrives. A save queued behind another merges onto this, so it carries the
	 * earlier save's keys even though its own diff no longer names them.
	 */
	const freshMapRef = useRef<VariableMap>({});
	/**
	 * The id whose rows, baseline and fresh map the refs hold; null once the
	 * editor lets go of them (a switch's cleanup, an unmount). A save for any
	 * other id computes from the snapshot it was asked with and touches no
	 * editor state when it lands.
	 */
	const seededContextRef = useRef<string | null>(null);
	// One save in flight, and the saves waiting for it in order (one per id).
	const saveInFlightRef = useRef(false);
	const waitingSavesRef = useRef<WaitingSave[]>([]);
	// A failed save's retry, and the consecutive failures behind its backoff,
	// as `useSaveManager.attemptAutoSave` keeps them.
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const retryAttemptRef = useRef(0);
	// The dirty flag, readable from an effect without being one of its dependencies: the row-init
	// effect must know whether there are uncommitted edits when the cache changes under it, and the
	// state as a dep would re-run the effect on every flip of the flag.
	const hasPendingChangesRef = useRef(false);

	const contextId =
		type === "globals"
			? "globals-editor"
			: type === "environment"
				? `environment-${environment?.id}`
				: `collection-${collection?.id}`;

	const contextName =
		type === "globals"
			? "Global Variables"
			: type === "environment"
				? `Environment: ${environment?.name}`
				: `Collection: ${collection?.name}`;

	// What "Copy for agent" on a row names. Built from the owner's id and name
	// as primitives so the object keeps its identity across a keystroke and
	// every memoised row is handed the same reference.
	const ownerId = type === "environment" ? environment?.id : collection?.id;
	const ownerName = type === "environment" ? environment?.name : collection?.name;
	const referenceScope = useMemo<VariableScope | null>(() => {
		if (type === "globals") return { type };
		if (ownerId === undefined || ownerName === undefined) return null;
		const owner = { id: ownerId, name: ownerName };
		return type === "environment" ? { type, environment: owner } : { type, collection: owner };
	}, [type, ownerId, ownerName]);

	// Memoised so the fallback empty object is stable across renders and does not re-fire the init
	// effect below.
	const dataVariables = useMemo(
		() =>
			type === "globals"
				? globalsData?.variables || {}
				: type === "environment"
					? environment?.variables || {}
					: collection?.variables || {},
		[type, globalsData?.variables, environment?.variables, collection?.variables]
	);

	const isDataLoading = type === "globals" ? (isLoading ?? globalsQuery.isLoading) : false;
	const dataError = type === "globals" ? (error ?? globalsQuery.error) : null;

	useEffect(() => {
		variablesRef.current = variables;
	}, [variables]);

	// Every edit goes through here so the ref and the state can never disagree.
	const markDirty = useCallback(() => {
		hasPendingChangesRef.current = true;
		setHasPendingChanges(true);
		reportPending(contextId);
	}, [reportPending, contextId]);

	/**
	 * Compare-and-clear: drop the dirty flag only if the rows are still the ones this save wrote.
	 *
	 * A save snapshots `variablesRef` when it starts, so anything typed before it lands is not in
	 * the payload. Clearing unconditionally would mark those edits saved (the blur handler skips a
	 * clean editor) and they would never reach the engine; staying dirty leaves the normal paths
	 * (blur, Cmd+S, the quit flush) to write them.
	 *
	 * A row the save held back (`heldBack`: a name problem or an open conflict) is the same case:
	 * its edit is on screen and in no payload, and a clean editor would reseed the row away on the
	 * next cache echo (#3251, #3353). The Dock then says "Unsaved changes" rather than "Saved",
	 * which the held row would make untrue, as it does for an edit typed while the save was in
	 * flight.
	 */
	const finishSave = useCallback(
		(id: string, snapshot: VariableRowData[], heldBack: boolean): SaveOutcome => {
			if (heldBack || !sameRows(variablesRef.current, snapshot)) {
				reportPending(id);
				return "pending";
			}
			hasPendingChangesRef.current = false;
			setHasPendingChanges(false);
			reportSaved(id);
			return "saved";
		},
		[reportPending, reportSaved]
	);

	/**
	 * After a save lands, each row it wrote is stored under the name it carried, which `baseKey`
	 * records; otherwise a renamed row keeps pointing at its old name and, if that name is later
	 * cleared, the save deletes the wrong variable. Matched by row id against the live rows, so an
	 * edit typed mid-flight is kept; a row nothing changed for keeps its object, so `VariableRow`'s
	 * memo holds.
	 */
	const recordStoredNames = useCallback(
		(saved: VariableRowData[], problems: Map<string, unknown>) => {
			const storedAs = new Map<string, string>();
			saved.forEach((row) => {
				if (!row.isNew && !problems.has(row.id)) storedAs.set(row.id, row.key);
			});
			const current = variablesRef.current;
			const next = current.map((row) => {
				const key = storedAs.get(row.id);
				return key === undefined || row.baseKey === key ? row : { ...row, baseKey: key };
			});
			if (next.every((row, i) => row === current[i])) return;
			variablesRef.current = next;
			setVariables(next);
		},
		[]
	);

	const readLive = useCallback(
		(): EditorSnapshot => ({
			rows: variablesRef.current,
			baseline: baselineRef.current,
			fresh: freshMapRef.current,
		}),
		[]
	);

	// Bound when a save is asked for, not when its turn comes, so a save waiting
	// behind another still writes the entity it was asked for.
	const mutateGlobals = updateGlobalsMutation.mutateAsync;
	const mutateEnvironment = updateEnvironmentMutation.mutateAsync;
	const mutateCollection = updateCollectionMutation.mutateAsync;
	const send = useMemo((): SaveTarget["send"] => {
		if (type === "globals") {
			return (variables, handlers) => sendThrough(mutateGlobals, { variables }, handlers);
		}
		if (type === "environment") {
			if (!environment) return null;
			const { id, name } = environment;
			// No `isActive`: absent means "keep" on a PUT, and echoing a stale cached value would
			// let a variable edit re-activate this environment, deactivating the one the engine
			// holds. Only the switch writes it.
			return (variables, handlers) =>
				sendThrough(mutateEnvironment, { id, name, variables }, handlers);
		}
		if (!collection) return null;
		const { id, name } = collection;
		return (variables, handlers) =>
			sendThrough(mutateCollection, { id, name, variables }, handlers);
	}, [type, environment, collection, mutateGlobals, mutateEnvironment, mutateCollection]);

	/** A landed save: advance the editor to it, if the editor still holds its rows. */
	const landSave = useCallback(
		(id: string, plan: SavePlan): SaveOutcome => {
			if (id !== seededContextRef.current) {
				reportSaved(id);
				return "saved";
			}
			freshMapRef.current = mergeVariableChanges(freshMapRef.current, plan.changes);
			baselineRef.current = baselineAfter(plan, baselineRef.current);
			recordStoredNames(plan.rows, plan.problems);
			// Recomputed against the new baseline rather than cleared: a conflict
			// this save held back is still open, and only the user closes it.
			setConflicts(conflictsOf(readLive()));
			return finishSave(id, plan.rows, plan.problems.size > 0 || plan.conflicts.length > 0);
		},
		[reportSaved, recordStoredNames, readLive, finishSave]
	);

	/**
	 * Sends one save and hands its verdict to `settle` exactly once, as soon as the mutation
	 * answers, so the next queued save starts then. A failure is reported here, once; the store's
	 * `runSave` takes that report as already published. A throw before the request goes out is a
	 * failure like any other, so the queue never waits on a save that is not in flight.
	 */
	const startSave = useCallback(
		(target: SaveTarget, settle: (outcome: SaveOutcome) => void) => {
			const { contextId: id, send: sendTo } = target;
			// A save whose turn comes after the editor let go of its id (a switch, an unmount)
			// reports nothing under it: the id went with the rows, and a report would revive it as
			// an entry no editor owns, a "Not saved" nothing could ever clear. Its failure is still
			// told, as the plain toast any write landing after its editor left gets.
			const live = id === seededContextRef.current;
			let settled = false;
			const finish = (outcome: SaveOutcome) => {
				if (settled) return;
				settled = true;
				settle(outcome);
			};
			const fail = (error: unknown, outcome: SaveOutcome, message: string) => {
				if (settled) return;
				if (live) reportFailed(id, message, error);
				else showToast(message, "error");
				finish(outcome);
			};
			if (!sendTo) {
				fail(undefined, "final", `Couldn't save - this ${target.scope} no longer exists`);
				return;
			}
			const failWith = (error: unknown) =>
				fail(
					error,
					saveFailureOutcome(error),
					error instanceof Error ? `Couldn't save - ${error.message}` : "Couldn't save"
				);
			try {
				const plan = planSave(live ? readLive() : target.snapshot);
				if (live) {
					if (plan.rows !== variablesRef.current) {
						variablesRef.current = plan.rows;
						setVariables(plan.rows);
					}
					setConflicts(plan.conflicts);
					reportSaving(id);
				}
				sendTo(plan.payload, {
					onSuccess: () => {
						if (!settled) finish(landSave(id, plan));
					},
					onError: failWith,
				});
			} catch (error) {
				failWith(error);
			}
		},
		[readLive, reportSaving, reportFailed, showToast, landSave]
	);

	const clearRetry = useCallback(() => {
		if (retryTimerRef.current) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
	}, []);

	/**
	 * `useSaveManager`'s backoff for a failed save: not for a `final` one, which the engine would
	 * refuse again, nor once the edit is gone or the editor has moved on. The delay is read when
	 * the failure lands, so a settings change applies to the next retry.
	 */
	const scheduleRetry = useCallback(
		(id: string, outcome: SaveOutcome) => {
			if (outcome !== "failed" && outcome !== "disk-full") {
				retryAttemptRef.current = 0;
				return;
			}
			if (id !== seededContextRef.current || !hasPendingChangesRef.current) return;
			const attempt = retryAttemptRef.current;
			retryAttemptRef.current = attempt + 1;
			const { delayMs } = useClientSettingsStore.getState().autoSave;
			clearRetry();
			retryTimerRef.current = setTimeout(
				() => {
					retryTimerRef.current = null;
					void performSaveRef.current();
				},
				saveRetryDelayMs(delayMs, attempt)
			);
		},
		[clearRetry]
	);

	/**
	 * Runs `first`, then each save queued behind it, one at a time. Never rejects: the verdict is
	 * the result, so an un-awaited call (blur, a toggle) leaves no unhandled rejection. Only a
	 * run's last save arms a retry; one queued behind a failure already is that retry.
	 */
	const runSaves = useCallback(
		(first: SaveTarget): Promise<SaveOutcome> => {
			const run = (target: SaveTarget) =>
				new Promise<SaveOutcome>((resolve) => {
					saveInFlightRef.current = true;
					startSave(target, (outcome) => {
						resolve(outcome);
						saveInFlightRef.current = false;
						const next = waitingSavesRef.current.shift();
						if (next) next.resolve(run(next.target));
						else scheduleRetry(target.contextId, outcome);
					});
				});
			return run(first);
		},
		[startSave, scheduleRetry]
	);

	/**
	 * Every save goes through here, serialised as `useSaveManager`'s are: two in flight could land
	 * out of order and move the baseline back to the older map, and a second `mutate` on the same
	 * mutation silences the first one's callbacks, so its promise would never settle. A save asked
	 * for mid-flight waits; one asked for while another for the same id is waiting joins it, and
	 * that save reads the latest rows when it starts.
	 */
	const requestSave = useCallback((): Promise<SaveOutcome> => {
		// A save starting now supersedes a retry; its own verdict re-arms one.
		clearRetry();
		const target: SaveTarget = { contextId, scope: type, send, snapshot: readLive() };
		if (!saveInFlightRef.current) return runSaves(target);
		const waiting = waitingSavesRef.current;
		const last = waiting[waiting.length - 1];
		if (last?.target.contextId === contextId) {
			last.target = target;
			return last.promise;
		}
		let resolve!: WaitingSave["resolve"];
		const promise = new Promise<SaveOutcome>((r) => {
			resolve = r;
		});
		waiting.push({ target, promise, resolve });
		return promise;
	}, [contextId, type, send, readLive, runSaves, clearRetry]);

	useEffect(() => {
		performSaveRef.current = requestSave;
	}, [requestSave]);

	// A switch or an unmount lets go of the rows: nothing is left for a retry
	// to save, and a save still out for them must not land in the next scope's.
	useEffect(
		() => () => {
			clearRetry();
			retryAttemptRef.current = 0;
			seededContextRef.current = null;
		},
		[contextId, clearRetry]
	);

	useEffect(() => {
		registerContext({
			id: contextId,
			name: contextName,
			save: () => performSaveRef.current(),
			hasPendingChanges: false,
		});
		setActiveContext(contextId);

		return () => {
			unregisterContext(contextId);
		};
	}, [contextId, contextName, registerContext, unregisterContext, setActiveContext]);

	// The rows go with the id: a switch reseeds them and an unmount drops them,
	// so nothing is left for this id's report to describe.
	useEffect(() => () => discard(contextId), [contextId, discard]);

	useEffect(() => {
		updateContext(contextId, { hasPendingChanges });
	}, [contextId, hasPendingChanges, updateContext]);

	// Saves fire on blur and on the toggles; there is no debounce. Ref-backed rather than depending
	// on the `hasPendingChanges` state: every row's text field takes this as `onBlur`, and with
	// `VariableRow` `memo`-wrapped (#1716) any dependency beyond what a ref can hold would defeat
	// every row's memo, as a dep on `items` did in `KeyValueEditor`. `hasPendingChangesRef` tracks
	// the same flag synchronously for `markDirty`/`finishSave`.
	const handleBlur = useCallback(() => {
		if (hasPendingChangesRef.current) {
			void performSaveRef.current();
		}
	}, []);

	// Seeds the rows from data, sorted by `createdAt` (oldest first, newest at the bottom).
	// `contextId` identifies the active data source, so switching between globals, an environment
	// and a collection reseeds. The seed is gated on `hasPendingChangesRef`, written synchronously
	// by the editor and by a save's completion: deriving the rows while rendering would read that
	// ref during render, the defect the guard exists to prevent, and a guard in state would be one
	// render late and let a save echo overwrite keystrokes, so the seed stays here.
	useEffect(() => {
		const isNewDataSource = seededContextRef.current !== contextId;
		seededContextRef.current = contextId;
		const freshMap = dataVariables;
		freshMapRef.current = freshMap;

		// A save's `onSuccess` writes the query cache, which arrives here as a new `dataVariables`
		// for the same scope: still dirty if something was typed while that save was in flight, or
		// a genuine concurrent write (an MCP agent's `update_environment`/`update_globals`).
		// Rebuilding rows from it would revert anything typed since the last seed, so the rows stay
		// either way; only a *different* entity overwrites uncommitted edits. What must not wait
		// for the editor to go clean is knowing whether the fresh map moved a key the user is also
		// editing (#1439: an editor that waits still sends its whole stale map on the next save,
		// overwriting the write it waited out). So the diff against `baseline` is recomputed here,
		// only to report a conflict; `planSave` recomputes it at save time and keeps both sides'
		// work by merging onto the freshest map (`mergeVariableChanges`, shared with the context
		// bar's commit).
		if (!isNewDataSource && hasPendingChangesRef.current) {
			setConflicts(conflictsOf(readLive()));
			return;
		}

		baselineRef.current = freshMap;
		setConflicts([]);

		// A reseed of the *same* scope keeps the rows' ids, matched by the name the variable is
		// stored under: most reseeds are the cache echo of this editor's own save, and fresh ids
		// would remount every row (masking a revealed secret, dropping focus) for a redraw of the
		// same data. A rename is safe: the row keeps its id through the edit, so the rows already
		// carry the new name when the echo arrives. A *different* scope gets fresh ids: its rows
		// are different rows that happen to share names.
		const carriedIds = new Map<string, string>();
		let carriedBlankId: string | undefined;
		if (!isNewDataSource) {
			variablesRef.current.forEach((row) => {
				if (row.isNew) carriedBlankId = row.id;
				else if (row.key) carriedIds.set(row.key, row.id);
			});
		}
		const rows = sortVariableEntriesByCreatedAt(Object.entries(freshMap)).map(([key, val]) =>
			rowFromValue(key, val, carriedIds.get(key))
		);
		rows.push(blankRow(carriedBlankId));
		// The ref with the state, not a render later: `seededContextRef` already names this scope,
		// and a save started before the next render must not read the previous scope's rows.
		variablesRef.current = rows;
		setVariables(rows);
	}, [contextId, dataVariables, readLive]);

	/*
	 * Id-based and ref-backed, with a dep list of only `[markDirty]` (itself stable): `variables`
	 * there would give both callbacks a new identity per keystroke, which `React.memo` on
	 * `VariableRow` cannot see through (#1716). Reading `variablesRef` rather than an `index` prop
	 * keeps them stable for a row's whole lifetime, not just one render's array.
	 */
	const updateVariable = useCallback(
		(id: string, field: keyof VariableRowData, value: string | boolean) => {
			const currentVariables = variablesRef.current;
			const index = currentVariables.findIndex((v) => v.id === id);
			if (index === -1) return;
			const newVariables = [...currentVariables];
			newVariables[index] = { ...newVariables[index], [field]: value };

			if (
				newVariables[index].isNew &&
				(trimVariableName(newVariables[index].key) || newVariables[index].value)
			) {
				newVariables[index].isNew = false;
				// From an input event, not render: the stamp orders newly added rows and must be
				// the real clock, not a render-stable value. Inside a `useCallback` body, which is
				// why react-hooks/purity does not flag it.
				newVariables[index].createdAt = Date.now(); // new ones sort to bottom
				newVariables[index].type = newVariables[index].type ?? "string";
				newVariables.push(blankRow());
			}

			setVariables(newVariables);
			// Sync the ref now, not via the post-render effect: the secret toggle calls
			// `performSaveRef.current()` right after this and the save reads
			// `variablesRef.current`; a stale ref would persist the pre-edit value and the backend
			// re-sync would revert the change. Mirrors `removeVariable`.
			variablesRef.current = newVariables;
			markDirty();
		},
		[markDirty]
	);

	const removeVariable = useCallback(
		(id: string) => {
			const currentVariables = variablesRef.current;
			const removed = currentVariables.find((v) => v.id === id);
			const newVariables = currentVariables.filter((v) => v.id !== id);
			if (newVariables.length === 0 || !newVariables.some((v) => v.isNew)) {
				newVariables.push(blankRow());
			}
			setVariables(newVariables);
			variablesRef.current = newVariables;
			markDirty();
			// Deleting a conflicted row is the user's choice for that key: with the
			// row gone, "Take theirs" would find nothing to update and the save
			// would re-delete the key anyway, so the delete is taken as "keep mine".
			const names = new Set(removed ? [removed.baseKey, trimVariableName(removed.key)] : []);
			for (const { key } of conflictsOf(readLive())) {
				if (names.has(key)) {
					baselineRef.current = withKeyFrom(
						baselineRef.current,
						key,
						freshMapRef.current
					);
				}
			}
			setConflicts((prev) => prev.filter((c) => !names.has(c.key)));
			void performSaveRef.current();
		},
		[markDirty, readLive]
	);

	// Wraps the ref-held save so a row (the enabled checkbox, the type select, the secret toggle)
	// can save at once through a callback that never changes: `performSaveRef.current` is always
	// the latest save, so the deps are empty.
	const commitNow = useCallback(() => {
		void performSaveRef.current();
	}, []);

	/**
	 * The user's side of a conflict. A save leaves a conflicted key out until this runs, and this
	 * saves at once, the "toggle acts now" pattern of the enabled checkbox and the secret button.
	 * Either way the key's baseline becomes the other writer's value: "keep mine" then reads the
	 * row as the user's change over it, "take theirs" first replaces the row with it.
	 */
	const keepMine = useCallback((key: string) => {
		baselineRef.current = withKeyFrom(baselineRef.current, key, freshMapRef.current);
		setConflicts((prev) => prev.filter((c) => c.key !== key));
		void performSaveRef.current();
	}, []);

	const takeTheirs = useCallback(
		(key: string) => {
			// Computed and assigned to the ref directly, not in a `setVariables` updater: the save
			// `keepMine` starts reads `variablesRef.current` before this render commits, and an
			// updater's body runs only then. Mirrors `updateVariable` / `removeVariable`.
			const next = withTheirs(variablesRef.current, key, freshMapRef.current[key]);
			setVariables(next);
			variablesRef.current = next;
			keepMine(key);
		},
		[keepMine]
	);

	const handleDeleteEnvironment = async () => {
		if (type !== "environment" || !environment) return;
		const { id, name } = environment;
		try {
			await deleteEnvironmentMutation.mutateAsync(id);
		} catch (error) {
			// A toast, not `reportFailed`: a delete is not an unsaved edit (`save-store.ts`).
			// The dialog stays open, so the delete can be retried or cancelled.
			const fallback = "Couldn't delete the environment";
			showToast(
				error instanceof Error ? `${fallback} - ${error.message}` : fallback,
				"error"
			);
			return;
		}
		setShowDeleteConfirm(false);
		setSelectedCategory(null);
		offerUndo(id, name, "environment");
	};

	const handleSetActiveEnvironment = () => {
		if (type === "environment" && environment) {
			setActiveEnvironment.mutate({ id: environment.id });
		}
	};

	/*
	 * Subscribed (`activeEnvironmentId` above), not read through `getState()`: a one-shot read
	 * during render does not re-render when the switch lands, so the button would keep offering
	 * "Set as active" for the environment that had just become active.
	 */
	const isActiveEnvironment =
		type === "environment" && environment && activeEnvironmentId === environment.id;

	const Icon = editorConfig.icon;
	const title =
		type === "globals"
			? (editorConfig.title as string)
			: (editorConfig.title as (name: string) => string)(
					type === "environment" ? environment?.name || "" : collection?.name || ""
				);

	if (isDataLoading) {
		return <DetailSkeleton label="Loading variables" />;
	}

	if (dataError) {
		return (
			<ErrorState
				variant="inline"
				title={`Couldn't load the ${type === "globals" ? "variables" : type === "environment" ? "environment" : "collection"}`}
			/>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{!embedded && (
				<div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/50">
					<div className="flex items-center gap-2">
						<Icon className={cn("w-5 h-5", editorConfig.iconColor)} />
						<div>
							<div className="flex items-center gap-2">
								{/* The variables tab's title; embedded in a collection's
								    tab, the collection's header is (#3498). */}
								<h1 className="text-md font-semibold text-foreground">{title}</h1>
							</div>
							<p className="text-xs text-muted-foreground">{editorConfig.subtitle}</p>
						</div>
					</div>
					{type === "environment" && environment && (
						<div className="flex items-center gap-2">
							{!isActiveEnvironment ? (
								<Button
									variant="outline"
									size="sm"
									onClick={handleSetActiveEnvironment}
									className="min-w-30 border-scope-environment/40 text-scope-environment hover:bg-scope-environment/10"
								>
									Set active
								</Button>
							) : (
								<Badge
									variant="outline"
									className="min-w-30 h-control-sm justify-center border-scope-environment/40 text-scope-environment hover:bg-scope-environment/10"
								>
									Active
								</Badge>
							)}
							<TooltipIconButton
								label="Delete environment"
								icon={<Trash2 className="size-icon" />}
								onClick={() => setShowDeleteConfirm(true)}
								className="size-control-sm text-muted-foreground hover:text-destructive-text hover:bg-destructive/10"
							/>
						</div>
					)}
				</div>
			)}

			{!embedded && (
				<div
					className={cn(
						"px-4 py-2 text-xs border-b",
						editorConfig.infoBg,
						editorConfig.infoTextColor,
						editorConfig.infoBorder
					)}
				>
					{editorConfig.infoText}
				</div>
			)}

			{type === "environment" && environment && (
				<DeleteConfirmDialog
					open={showDeleteConfirm}
					onOpenChange={(open) => !open && setShowDeleteConfirm(false)}
					title={`Delete "${environment.name}"?`}
					description={environmentDeleteDescription(environment)}
					confirmLabel="Delete environment"
					onConfirm={handleDeleteEnvironment}
					isDeleting={deleteEnvironmentMutation.isPending}
				/>
			)}

			{conflicts.length > 0 && (
				<div className={cn("space-y-2", embedded ? "px-0 pt-2" : "px-4 pt-3")}>
					{conflicts.map((conflict) => (
						<Callout
							key={conflict.key}
							severity="warning"
							title={`Changed elsewhere: ${conflict.key}`}
							action={
								<div className="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										onClick={() => keepMine(conflict.key)}
									>
										Keep mine
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={() => takeTheirs(conflict.key)}
									>
										Take theirs
									</Button>
								</div>
							}
						>
							Your edit stays here, unsaved, until you choose.
						</Callout>
					))}
				</div>
			)}

			{/*
			 * This scrolls, and `overflow-y-auto` computes `overflow-x` to `auto` too, so the box
			 * clips at its padding box on all four sides. Embedded (Collection Detail) it carries
			 * `p-0`, so anything flush left loses the outer half of its focus ring; standalone it
			 * carries `p-4` and nothing notices. The clearance lives on the checkbox cell in
			 * `VariableRow`, not here (see the comment there).
			 *
			 * A narrow pane or a 200% scale lands on the same scroll (#3494): the Variable and
			 * Value headers carry a width floor, so below the columns' sum the table scrolls
			 * sideways rather than squeezing the two inputs, which the other columns' fixed widths
			 * leave all the slack to.
			 */}
			<div className={cn("flex-1 overflow-y-auto", embedded ? "p-0" : "p-4")}>
				<table className="w-full">
					<thead>
						<tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
							<th className="pb-2 w-8">
								<span className="sr-only">Enabled</span>
							</th>
							<th className="pb-2 px-2 min-w-[8rem]">Variable</th>
							<th className="pb-2 px-2 min-w-[10rem]">Value</th>
							<th className="pb-2 px-2 w-[110px]">Type</th>
							{/*
							 * A word, like every other column, not a bare key icon whose meaning
							 * lived in a native `title`: that needs a hover, never shows on a touch
							 * device, and left the one unlabelled column in a table of labelled
							 * ones.
							 */}
							<th className="pb-2 w-14 px-2">Secret</th>
							<th className="pb-2 w-18">
								<span className="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{/*
						 * Keyed by row id, not index (#621; see the `id` field of
						 * `VariableRowData`). `VariableRow` is `memo`-wrapped (#1716):
						 * `updateVariable`/`removeVariable`/`commitNow` are ref-backed and stable
						 * across a keystroke, and every row but the changed one keeps the identical
						 * `variable` reference this map handed it last render, so only that row
						 * re-renders.
						 */}
						{variables.map((variable) => (
							<VariableRow
								key={variable.id}
								variable={variable}
								checkboxColor={editorConfig.checkboxColor}
								onUpdate={updateVariable}
								onCommitNow={commitNow}
								onRemove={removeVariable}
								onBlur={handleBlur}
								scope={referenceScope}
								nameError={nameErrorFor(rowProblems.get(variable.id))}
							/>
						))}
					</tbody>
				</table>
			</div>

			{!embedded && (
				<div className="px-4 py-2 border-t border-border bg-muted/50 text-xs text-muted-foreground">
					{(() => {
						const savedCount = variables.filter(
							(v) => !v.isNew && !rowProblems.has(v.id)
						).length;
						return `${savedCount} ${pluralize(savedCount, "variable")}`;
					})()}
				</div>
			)}
		</div>
	);
}
