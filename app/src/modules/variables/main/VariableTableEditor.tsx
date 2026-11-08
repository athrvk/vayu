/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Unified Variable Editor
 *
 * A single configurable editor component that handles all variable types:
 * - Globals
 * - Environments
 * - Collections
 *
 * The editor is configured via the `config` prop which determines:
 * - Data source and mutations
 * - UI colors and icons
 * - Header content
 * - Additional actions (e.g., delete for environments)
 *
 * **This table does not mount `components/shared/KeyValueEditor`, and that is a
 * settled decision rather than an omission** (#564, reconsidered and confirmed
 * in #587). The repo's standing rule is that a hand-rolled copy of a primitive
 * never receives the primitive's fixes, so the exclusion needs a reason that
 * survives re-reading: this is not a copy of that table, it is a different
 * table. The shared primitive is a fixed grid of key, value and a row action,
 * committing on every change; this one adds a per-row type select and a secret
 * toggle, masks the value cell, commits text on blur and toggles immediately,
 * and orders rows by a `createdAt` stamp instead of by a trailing-blank rule.
 * Folding it in means giving the shared table a dynamic column model, a commit
 * model, and variables-domain fields on `KeyValueItem` - a redesign of the
 * primitive to serve one consumer, paid for by its three existing ones.
 *
 * What the rule does bind here is the *reveal* control, which was extracted out
 * of this file into `ui/secret-input` and then went on receiving fixes this
 * table never got (the `tabIndex={-1}` removal, `aria-pressed`). The value cell
 * mounts `SecretInput` for exactly that reason. `key-value-parity.test.tsx`
 * pins what the two tables must keep in common - control height, checkbox
 * clearance and sizing, the shared destructive row-action variant, and this
 * reveal control - so the next fix to either side fails loudly instead of
 * drifting.
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
	 * Editor-local row identity, never persisted (`toVariableValue` builds the
	 * payload field by field, so this cannot leak into a scope's variables).
	 *
	 * A variable has no stable identity of its own: `key` is editable, so
	 * keying by it moves state on rename, and `createdAt` is absent on rows
	 * written before the field existed. Rows were therefore reconciled by array
	 * position, which is the one thing that *changes* on a delete - reveal a
	 * secret, delete that row, and the row shifting up into its position
	 * inherited the mounted `SecretInput`, values and all, so a secret the user
	 * never revealed was displayed (#621). The id gives the row an identity for
	 * as long as the editor is mounted; React's `key` and therefore every piece
	 * of per-row UI state follow the row rather than its index.
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
	 * Whatever the stored value carries that this table has no column for (a
	 * Postman import's `description`), written back untouched so editing a
	 * variable does not drop it.
	 */
	extra?: Record<string, unknown>;
}

/**
 * Monotonic within the session, which is all "stable" has to mean here: ids
 * live and die with the mounted editor and are never compared against anything
 * outside it.
 */
let lastRowId = 0;
function nextRowId(): string {
	lastRowId += 1;
	return `vrow-${lastRowId}`;
}

/**
 * The trailing "type here to add one" row. Takes an id so a reseed can hand it
 * the one the current blank row already has.
 */
function blankRow(id: string = nextRowId()): VariableRowData {
	return { id, key: "", value: "", enabled: true, secret: false, type: "string", isNew: true };
}

type VariableEditorType = "globals" | "environment" | "collection";

/**
 * Row-wise equality over every field a row carries.
 *
 * Used to tell "the cache echo of the save I just made" from "someone typed
 * while it was in flight", which is the difference between clearing the dirty
 * flag and silently losing an edit. Compared by value rather than by array
 * identity on purpose: a reseed that happens to produce identical rows must
 * count as unchanged, and identity would call it a change and leave the editor
 * dirty forever.
 *
 * `id` is deliberately not part of the comparison: it is UI identity, not user
 * data, so a row that only changed id has nothing for a save to write, and
 * counting it as a change would be the same "dirty forever" bug in a new
 * disguise.
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
 * The rows the user has actually edited since `baseline`, as a diff rather
 * than a snapshot: a key the diff does not name is a key the save should
 * never touch, which is what lets `mergeVariableChanges` carry a concurrent
 * write for it through untouched. A key present in `baseline` but no longer
 * among the rows is a deletion.
 *
 * A row with a name problem (`nameProblems`) writes nothing, and the variable it
 * stands for is still present: only the explicit Delete removes a key, so a
 * name the user is mid-way through fixing never costs them the variable (#3251).
 * The exception is a stored name the engine would refuse (a legacy blank or
 * padded key): keeping it would make every save a 400, and `{{ name }}` could
 * never reach it, so it is dropped from the blob while the row stays on screen
 * to be named.
 * Names are trimmed here, so the payload key is the one the engine accepts
 * whatever the row currently holds.
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
 * The user's own changes merged onto the freshest map, never the editor's whole
 * copy, which would carry a key an MCP agent wrote after this editor last
 * reseeded back to its pre-agent value (#1439). A key both sides moved is left
 * out until the user chooses (#3353): saving it would be choosing for them.
 * Payload order is by `createdAt` so the round trip preserves display order.
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
 * The baseline once `plan` has landed: the map it wrote, so the save's own
 * history is never mistaken for a later external change. A conflicted key it
 * held back keeps the baseline it had, or the conflict would vanish as if the
 * user had chosen.
 */
function baselineAfter(plan: SavePlan, current: VariableMap): VariableMap {
	return plan.conflicts.reduce((next, { key }) => withKeyFrom(next, key, current), plan.payload);
}

interface SaveHandlers {
	onSuccess: () => void;
	onError: (error: unknown) => void;
}

/**
 * Runs a mutation and reports through both of TanStack's channels. The per-call
 * callbacks fire as the mutation settles, but only while its observer has
 * listeners, so never once the editor has unmounted; the promise always
 * settles. The caller acts on whichever arrives first.
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
	 * Embedded mode strips the standalone-screen chrome (title header, info
	 * banner, count footer) so the editor can be slotted inside another
	 * container - e.g. the Variables tab of CollectionDetail - without
	 * duplicating headings or fighting the host layout.
	 */
	embedded?: boolean;
}

export default function VariableEditor({ config, embedded = false }: VariableEditorProps) {
	const { type, globalsData, isLoading, error, environment, collection } = config;
	const editorConfig = EDITOR_CONFIGS[type];

	// Queries and mutations based on type
	const globalsQuery = useGlobalsQuery();
	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();
	const deleteEnvironmentMutation = useDeleteEnvironmentMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();

	const setSelectedCategory = useVariablesStore((s) => s.setSelectedCategory);
	const setActiveEnvironment = useSetActiveEnvironmentMutation();
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	// Per-field selectors, not a bare `useSaveStore()`: the whole-store call
	// subscribed this editor to every field the store holds - `status`,
	// `lastErrorMessage`, `activeContextId`, `contexts` - so a save anywhere
	// else in the app re-rendered this editor even though only these stable
	// action references are ever read (issue #1714).
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
	 * The map the user's edits are diffed against - the state a save last
	 * agreed with the server on. Advanced on every full reseed, on a
	 * successful save (`baselineAfter`), and per key when the user picks a
	 * side of a conflict. Saves run one at a time, so the save that advances
	 * it last is the one that carried the latest rows.
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
	// The dirty flag, readable from an effect without being one of its
	// dependencies - the row-init effect has to know whether the user has
	// uncommitted edits *at the moment the cache changes under it*, and taking
	// the state as a dep would re-run the effect on every flip of the flag.
	const hasPendingChangesRef = useRef(false);

	// Determine context ID and name
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

	// Get data based on type (memoized so the fallback empty object is stable
	// across renders and doesn't re-fire the init effect at L390)
	const dataVariables = useMemo(
		() =>
			type === "globals"
				? globalsData?.variables || {}
				: type === "environment"
					? environment?.variables || {}
					: collection?.variables || {},
		[type, globalsData?.variables, environment?.variables, collection?.variables]
	);

	// Determine loading and error states
	const isDataLoading = type === "globals" ? (isLoading ?? globalsQuery.isLoading) : false;
	const dataError = type === "globals" ? (error ?? globalsQuery.error) : null;

	// Keep variablesRef in sync
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
	 * Compare-and-clear: only drop the dirty flag if the rows are still the ones
	 * this save wrote.
	 *
	 * A save snapshots `variablesRef` when it starts, so anything typed before it
	 * lands is not in the payload. Clearing unconditionally marked those edits
	 * saved - the debounce and the blur handler both skip a clean editor - and
	 * they never reached the engine. Staying dirty leaves the normal paths (blur,
	 * Cmd+S, the quit flush) to write them.
	 *
	 * A row the save held back (`heldBack`, a name problem or an open conflict)
	 * is the same case: its edit is on screen and in no payload, and a clean
	 * editor would reseed the row away on the next cache echo (#3251, #3353).
	 * The Dock then says "Unsaved changes" rather than "Saved", which the held
	 * row would make untrue, and so it does for an edit typed while the save was
	 * in flight.
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
	 * After a save lands, each row it wrote is stored under the name it carried,
	 * which is what `baseKey` records. Without it a renamed row keeps pointing at
	 * its old name and, if its name is later cleared, the save would delete the
	 * wrong variable. Matched by row id against the live rows, so an edit typed
	 * while the save was in flight is kept; a row nothing changed for keeps its
	 * object, so `VariableRow`'s memo holds.
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
			// No `isActive`: absent means "keep" on a PUT, and echoing the cached
			// value back would let a variable edit re-activate this environment
			// from a stale read - deactivating whichever one the engine actually
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
	 * Sends one save and hands its verdict to `settle`, exactly once, as soon as
	 * the mutation answers - so the next queued save starts there and then. A
	 * failure is reported here, once; `runSave` in the store takes that report
	 * as already published. A throw before the request goes out is a failure
	 * like any other, so the queue is never left waiting on a save that is not
	 * in flight.
	 */
	const startSave = useCallback(
		(target: SaveTarget, settle: (outcome: SaveOutcome) => void) => {
			const { contextId: id, send: sendTo } = target;
			let settled = false;
			const finish = (outcome: SaveOutcome) => {
				if (settled) return;
				settled = true;
				settle(outcome);
			};
			const fail = (error: unknown) => {
				if (settled) return;
				reportFailed(
					id,
					error instanceof Error ? `Couldn't save - ${error.message}` : "Couldn't save",
					error
				);
				finish(saveFailureOutcome(error));
			};
			if (!sendTo) {
				reportFailed(id, `Couldn't save - this ${target.scope} no longer exists`);
				finish("final");
				return;
			}
			try {
				const live = id === seededContextRef.current;
				const plan = planSave(live ? readLive() : target.snapshot);
				if (live) {
					if (plan.rows !== variablesRef.current) {
						variablesRef.current = plan.rows;
						setVariables(plan.rows);
					}
					setConflicts(plan.conflicts);
				}
				reportSaving(id);
				sendTo(plan.payload, {
					onSuccess: () => {
						if (!settled) finish(landSave(id, plan));
					},
					onError: fail,
				});
			} catch (error) {
				fail(error);
			}
		},
		[readLive, reportSaving, reportFailed, landSave]
	);

	const clearRetry = useCallback(() => {
		if (retryTimerRef.current) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
	}, []);

	/**
	 * `useSaveManager`'s backoff for a failed save: not for a `final` one, which
	 * the engine would refuse again, nor once the edit is gone or the editor has
	 * moved on. The delay is read when the failure lands, so a settings change
	 * applies to the next retry.
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
	 * Runs `first`, then each save that queued behind it, one at a time. The
	 * promise never rejects: the verdict is the result, so an un-awaited call
	 * (blur, a toggle) has no rejection to leave unhandled. Only the last save
	 * of a run arms a retry; one queued behind a failure is that retry already.
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
	 * Every save goes through here, serialised as `useSaveManager`'s are. Two
	 * saves in flight could land out of order and move the baseline back to the
	 * older map, and a second `mutate` on the same mutation also silences the
	 * first one's callbacks, so its promise would never settle. A save asked for
	 * mid-flight waits; one asked for while another for the same id is already
	 * waiting joins it, and that save reads the latest rows when it starts.
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

	// Register save context on mount
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

	// Update context when hasPendingChanges changes
	useEffect(() => {
		updateContext(contextId, { hasPendingChanges });
	}, [contextId, hasPendingChanges, updateContext]);

	// Handle blur - save when user leaves the field.
	//
	// There is no debounce here and never was: `saveTimeoutRef` was cleared in
	// three places and assigned in none, so the three `clearTimeout` calls it
	// guarded were always no-ops. Saves fire on blur and on the toggles.
	// Ref-backed rather than depending on the `hasPendingChanges` state value:
	// every row's text field takes this as `onBlur`, so a dep that changes
	// identity on every flip of that flag - or, with `VariableRow` now `memo`-
	// wrapped (issue #1716), any dependency at all beyond what a ref can hold -
	// would defeat every row's memo the same way a dep on `items` did in
	// `KeyValueEditor`. `hasPendingChangesRef` already tracks the same flag
	// synchronously for `markDirty`/`finishSave` above.
	const handleBlur = useCallback(() => {
		if (hasPendingChangesRef.current) {
			void performSaveRef.current();
		}
	}, []);

	// Initialize variables from data (sorted by createdAt: oldest first, newest at bottom).
	// `contextId` is the identity of the active data source, so the effect
	// reseeds when the user switches between globals / a specific environment /
	// collection.
	// The seed is gated on `hasPendingChangesRef`, a flag written synchronously by
	// the editor and by a save's completion. Deriving the rows while rendering
	// would mean reading that ref during render, which is the defect the guard
	// exists to prevent; moving the guard into state would make it one render late
	// and let a save echo overwrite keystrokes again - so the seed stays here.
	useEffect(() => {
		const isNewDataSource = seededContextRef.current !== contextId;
		seededContextRef.current = contextId;
		const freshMap = dataVariables;
		freshMapRef.current = freshMap;

		// A save's `onSuccess` writes the query cache, which arrives back here as
		// a new `dataVariables` - the same scope, still dirty if anything was
		// typed while that save was in flight, or genuinely a concurrent write
		// (an MCP agent's `update_environment`/`update_globals`) that has
		// nothing to do with this editor's own save. Rebuilding rows from it
		// would revert anything typed since the last seed, so the row array is
		// left alone either way - only a *different* entity overwrites
		// uncommitted edits. What must not wait for the editor to go clean is
		// knowing whether the fresh map moved a key the user is also editing:
		// #1439 was exactly that - an editor that waits still sends its whole
		// stale local map on the next save, silently overwriting the write it
		// was waiting out. So the diff against `baseline` is recomputed here
		// too, purely to report a conflict; `planSave` recomputes the same
		// diff at save time and is what actually keeps both sides' work,
		// merging onto the freshest map rather than this editor's own copy of
		// it (`mergeVariableChanges`, shared with the context bar's commit).
		if (!isNewDataSource && hasPendingChangesRef.current) {
			setConflicts(conflictsOf(readLive()));
			return;
		}

		baselineRef.current = freshMap;
		setConflicts([]);

		// A reseed of the *same* scope keeps the ids the rows already have,
		// matched by the name the variable is stored under. Most reseeds are the
		// cache echo of a save this editor just made, and minting fresh ids
		// there would remount every row - masking a secret the user had revealed
		// and dropping focus out of whatever field they were in - for a redraw
		// of the same data. A rename is safe: the row keeps its id through the
		// edit, so the current rows already carry the new name by the time the
		// echo arrives. A *different* scope gets fresh ids, because its rows are
		// different rows that happen to share names.
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
		// The ref with the state, not a render later: `seededContextRef` already
		// names this scope, and a save started before the next render must not
		// read the previous scope's rows under it.
		variablesRef.current = rows;
		setVariables(rows);
	}, [contextId, dataVariables, readLive]);

	/*
	 * Id-based and ref-backed, with an empty-ish dep list (`[markDirty]`,
	 * itself stable): `variables` in these deps would give both callbacks a new
	 * identity on every keystroke, which is exactly what `React.memo` on
	 * `VariableRow` cannot see through (issue #1716). Reading `variablesRef`
	 * rather than the `index` the row used to be told keeps them stable across
	 * a row's whole lifetime, not just across one render's array.
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
				// This runs from an input event, not from render: the stamp orders newly
				// added rows and has to be the real clock, not a render-stable value.
				// Now inside a useCallback body rather than a plain render-scoped
				// function, which is what let react-hooks/purity stop flagging it.
				newVariables[index].createdAt = Date.now(); // new ones sort to bottom
				newVariables[index].type = newVariables[index].type ?? "string";
				newVariables.push(blankRow());
			}

			setVariables(newVariables);
			// Keep the ref in sync immediately (not just via the post-render effect):
			// the secret toggle calls performSaveRef.current() synchronously right
			// after this, and the save reads variablesRef.current - a stale ref
			// would persist the pre-edit value and the backend re-sync would then
			// revert the change. Mirrors removeVariable.
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

	// Wraps the ref-held save so a row can trigger an immediate save
	// (the enabled checkbox, the type select, the secret toggle) with a
	// callback identity that never changes - `performSaveRef.current` is
	// always the latest save, so nothing needs to be in these deps at all.
	const commitNow = useCallback(() => {
		void performSaveRef.current();
	}, []);

	/**
	 * The user's side of a conflict. A save leaves a conflicted key out until
	 * this runs, and this saves at once - the same "toggle acts now" pattern the
	 * enabled checkbox and the secret button use. Either way the key's baseline
	 * becomes the other writer's value: "keep mine" then reads the row as the
	 * user's change over it, "take theirs" first replaces the row with it.
	 */
	const keepMine = useCallback((key: string) => {
		baselineRef.current = withKeyFrom(baselineRef.current, key, freshMapRef.current);
		setConflicts((prev) => prev.filter((c) => c.key !== key));
		void performSaveRef.current();
	}, []);

	const takeTheirs = useCallback(
		(key: string) => {
			const theirs = freshMapRef.current[key];
			// Computed synchronously and assigned to the ref directly, not inside
			// the `setVariables` updater: the save `keepMine` starts reads
			// `variablesRef.current` before this render commits, and a functional
			// updater's body does not run until then. Mirrors `updateVariable` /
			// `removeVariable`.
			const next = theirs
				? variablesRef.current.map((row) =>
						row.key === key && !row.isNew ? rowFromValue(key, theirs, row.id) : row
					)
				: variablesRef.current.filter((row) => row.isNew || row.key !== key);
			setVariables(next);
			variablesRef.current = next;
			keepMine(key);
		},
		[keepMine]
	);

	// Environment-specific handlers
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
	 * Subscribed (`activeEnvironmentId` above), not read through
	 * `getState()`: a one-shot read during render does not re-render when the
	 * switch lands, so this button kept offering "Set as active" for the
	 * environment that had just become active.
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
			{/* Header */}
			{!embedded && (
				<div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/50">
					<div className="flex items-center gap-2">
						<Icon className={cn("w-5 h-5", editorConfig.iconColor)} />
						<div>
							<div className="flex items-center gap-2">
								<h2 className="text-md font-semibold text-foreground">{title}</h2>
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

			{/* Info Banner */}
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
			 * This scrolls, and `overflow-y-auto` computes `overflow-x` to `auto`
			 * too, so the box clips on all four sides at its padding box. Embedded
			 * (Collection Detail) it carries `p-0`, so anything flush against the
			 * left edge loses the outer half of its focus ring; standalone it
			 * carries `p-4` and nothing notices. The clearance that fixes it lives
			 * on the checkbox cell below, not here - see the comment there.
			 */}
			<div className={cn("flex-1 overflow-y-auto", embedded ? "p-0" : "p-4")}>
				<table className="w-full">
					<thead>
						<tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
							<th className="pb-2 w-8"></th>
							<th className="pb-2 px-2">Variable</th>
							<th className="pb-2 px-2">Value</th>
							<th className="pb-2 px-2 w-[110px]">Type</th>
							{/*
							 * A word, like every other column. This was a bare key icon
							 * whose meaning lived in a native `title` - which needs a
							 * hover to appear, never shows on a touch device, and is
							 * the only unlabelled column in a table of labelled ones.
							 */}
							<th className="pb-2 w-14 px-2">Secret</th>
							<th className="pb-2 w-18"></th>
						</tr>
					</thead>
					<tbody>
						{/*
						 * Keyed by row id, not by index (#621) - see the note on the
						 * `id` field of `VariableRowData`. `VariableRow` is `memo`-wrapped
						 * (issue #1716): `updateVariable`/`removeVariable`/`commitNow` are
						 * ref-backed and stable across a keystroke, and every row but the
						 * one whose `item` actually changed keeps the identical `variable`
						 * reference this map handed it last render, so only that row
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

			{/* Footer */}
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
