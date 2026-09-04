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
import { Globe, Cloud, Folder, Trash2, AlertCircle, LucideIcon, KeyRound } from "lucide-react";
import {
	useGlobalsQuery,
	useUpdateGlobalsMutation,
	useUpdateEnvironmentMutation,
	useSetActiveEnvironmentMutation,
	useDeleteEnvironmentMutation,
	useUpdateCollectionMutation,
} from "@/queries";
import { useSaveStore, useSessionStore } from "@/stores";
import { useVariablesStore } from "@/modules/variables/variables-store";
import type { VariableValue, Collection, Environment } from "@/types";
import {
	Button,
	Input,
	Badge,
	DeleteConfirmDialog,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	SecretInput,
	TooltipIconButton,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { VariableType } from "@/lib/variable-cast";

const VARIABLE_TYPES: { value: VariableType; label: string }[] = [
	{ value: "string", label: "String" },
	{ value: "number", label: "Number" },
	{ value: "boolean", label: "Boolean" },
	{ value: "json", label: "JSON" },
];

interface VariableRow {
	/**
	 * Editor-local row identity, never persisted (`performSave` builds its
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
	value: string;
	enabled: boolean;
	secret?: boolean;
	type?: VariableType;
	createdAt?: number;
	isNew?: boolean;
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
function blankRow(id: string = nextRowId()): VariableRow {
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
function sameRows(a: VariableRow[], b: VariableRow[]): boolean {
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

const EDITOR_CONFIGS = {
	globals: {
		icon: Globe as LucideIcon,
		iconColor: "text-scope-global",
		title: "Global Variables",
		subtitle: "Global Variables",
		infoText:
			"Global variables are available in all requests (lowest priority). They can be overridden by environment and collection variables.",
		infoBg: "bg-scope-global/10",
		infoTextColor: "text-scope-global",
		infoBorder: "border-scope-global/20",
		checkboxColor: "text-scope-global focus:ring-scope-global accent-scope-global",
		loadingColor: "border-scope-global",
	},
	environment: {
		icon: Cloud as LucideIcon,
		iconColor: "text-scope-environment",
		title: (name: string) => name,
		subtitle: "Environment Variables",
		infoText:
			"Environment variables override global variables but can be overridden by collection variables.",
		infoBg: "bg-scope-environment/10",
		infoTextColor: "text-scope-environment",
		infoBorder: "border-scope-environment/20",
		checkboxColor:
			"text-scope-environment focus:ring-scope-environment accent-scope-environment",
		loadingColor: "border-scope-environment",
	},
	collection: {
		icon: Folder as LucideIcon,
		iconColor: "text-scope-collection",
		title: (name: string) => name,
		subtitle: "Collection Variables",
		infoText:
			"Collection variables have the highest priority and override both global and environment variables.",
		infoBg: "bg-scope-collection/10",
		infoTextColor: "text-scope-collection",
		infoBorder: "border-scope-collection/20",
		checkboxColor: "text-scope-collection focus:ring-scope-collection accent-scope-collection",
		loadingColor: "border-scope-collection",
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

	const { setSelectedCategory } = useVariablesStore();
	const setActiveEnvironment = useSetActiveEnvironmentMutation();
	const activeEnvironmentId = useSessionStore((s) => s.activeEnvironmentId);
	const {
		registerContext,
		unregisterContext,
		updateContext,
		setActiveContext,
		markPendingSave,
		startSaving,
		completeSaveThenIdle,
		failSave,
	} = useSaveStore();

	const [variables, setVariables] = useState<VariableRow[]>([]);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [hasPendingChanges, setHasPendingChanges] = useState(false);
	const variablesRef = useRef<VariableRow[]>([]);
	const performSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());
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

	// Sort by createdAt ascending (oldest first, newest at bottom); tie-break by
	// key. A missing createdAt sorts as 0 - "older than everything" - so rows
	// with no known creation time stay together at the top instead of drifting
	// one at a time as they happen to be saved.
	const sortByCreatedAt = useCallback(
		(entries: [string, VariableValue][]) =>
			[...entries].sort(([ka, a], [kb, b]) => {
				const ta = a.createdAt ?? 0;
				const tb = b.createdAt ?? 0;
				if (ta !== tb) return ta - tb;
				return ka.localeCompare(kb, undefined, { sensitivity: "base" });
			}),
		[]
	);

	// Every edit goes through here so the ref and the state can never disagree.
	const markDirty = useCallback(() => {
		hasPendingChangesRef.current = true;
		setHasPendingChanges(true);
		markPendingSave();
	}, [markPendingSave]);

	/**
	 * Compare-and-clear: only drop the dirty flag if the rows are still the ones
	 * this save wrote.
	 *
	 * A save snapshots `variablesRef` when it starts, so anything typed before it
	 * lands is not in the payload. Clearing unconditionally marked those edits
	 * saved - the debounce and the blur handler both skip a clean editor - and
	 * they never reached the engine. Staying dirty leaves the normal paths (blur,
	 * Cmd+S, the quit flush) to write them.
	 */
	const finishSave = useCallback(
		(snapshot: VariableRow[]) => {
			if (sameRows(variablesRef.current, snapshot)) {
				hasPendingChangesRef.current = false;
				setHasPendingChanges(false);
			}
			completeSaveThenIdle(contextId);
		},
		[completeSaveThenIdle, contextId]
	);

	// Auto-save function (payload order by createdAt so round-trip preserves order)
	const performSave = useCallback(async () => {
		const varsToSave = variablesRef.current;
		const entries: [string, VariableValue][] = [];
		varsToSave.forEach((v) => {
			if (v.key && !v.isNew) {
				entries.push([
					v.key,
					{
						value: v.value,
						enabled: v.enabled,
						secret: v.secret ?? false,
						type: v.type ?? "string",
						// Never backfill to `Date.now()`. A row whose creation
						// time is unknown - one written before the field
						// existed, or stripped by an older engine - would get
						// stamped at whatever moment its scope happened to be
						// saved, which is *after* the row the user just typed,
						// so the pre-existing row leapfrogged the new one
						// (issue #135). Unknown stays unknown; the sort reads it
						// as older than everything, which is stable.
						...(v.createdAt !== undefined && { createdAt: v.createdAt }),
					},
				]);
			}
		});
		const sorted = sortByCreatedAt(entries);
		const variablesObj: Record<string, VariableValue> = {};
		sorted.forEach(([key, val]) => {
			variablesObj[key] = val;
		});

		startSaving();

		return new Promise<void>((resolve, reject) => {
			if (type === "globals") {
				updateGlobalsMutation.mutate(
					{ variables: variablesObj },
					{
						onSuccess: () => {
							finishSave(varsToSave);
							resolve();
						},
						onError: (error) => {
							failSave(error instanceof Error ? error.message : "Save failed");
							reject(error);
						},
					}
				);
			} else if (type === "environment" && environment) {
				updateEnvironmentMutation.mutate(
					{
						id: environment.id,
						name: environment.name,
						variables: variablesObj,
						// No `isActive`: absent means "keep" on a PUT, and echoing
						// the cached value back would let a variable edit re-activate
						// this environment from a stale read - deactivating whichever
						// one the engine actually holds. Only the switch writes it.
					},
					{
						onSuccess: () => {
							finishSave(varsToSave);
							resolve();
						},
						onError: (error) => {
							failSave(error instanceof Error ? error.message : "Save failed");
							reject(error);
						},
					}
				);
			} else if (type === "collection" && collection) {
				updateCollectionMutation.mutate(
					{
						id: collection.id,
						name: collection.name,
						variables: variablesObj,
					},
					{
						onSuccess: () => {
							finishSave(varsToSave);
							resolve();
						},
						onError: (error) => {
							failSave(error instanceof Error ? error.message : "Save failed");
							reject(error);
						},
					}
				);
			}
		});
	}, [
		type,
		environment,
		collection,
		sortByCreatedAt,
		updateGlobalsMutation,
		updateEnvironmentMutation,
		updateCollectionMutation,
		startSaving,
		finishSave,
		failSave,
	]);

	// Keep performSaveRef updated
	useEffect(() => {
		performSaveRef.current = performSave;
	}, [performSave]);

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

	// Update context when hasPendingChanges changes
	useEffect(() => {
		updateContext(contextId, { hasPendingChanges });
	}, [contextId, hasPendingChanges, updateContext]);

	// Handle blur - save when user leaves the field.
	//
	// There is no debounce here and never was: `saveTimeoutRef` was cleared in
	// three places and assigned in none, so the three `clearTimeout` calls it
	// guarded were always no-ops. Saves fire on blur and on the toggles.
	const handleBlur = useCallback(() => {
		if (hasPendingChanges) {
			performSaveRef.current();
		}
	}, [hasPendingChanges]);

	// Initialize variables from data (sorted by createdAt: oldest first, newest at bottom).
	// `contextId` is the identity of the active data source, so the effect
	// reseeds when the user switches between globals / a specific environment /
	// collection.
	const lastSeededSourceRef = useRef<string | null>(null);
	// The seed is gated on `hasPendingChangesRef`, a flag written synchronously by
	// the editor and by a save's completion. Deriving the rows while rendering
	// would mean reading that ref during render, which is the defect the guard
	// exists to prevent; moving the guard into state would make it one render late
	// and let a save echo overwrite keystrokes again - so the seed stays here, and
	// `set-state-in-effect` is suppressed on the two writes below with that reason.
	useEffect(() => {
		const isNewDataSource = lastSeededSourceRef.current !== contextId;
		lastSeededSourceRef.current = contextId;

		// A save's `onSuccess` writes the query cache, which arrives back here as
		// a new `dataVariables`. Rebuilding rows from it would revert anything
		// typed while that save was in flight - the payload was snapshotted
		// before those keystrokes, so the cache is genuinely one edit behind.
		// Only a *different* entity is allowed to overwrite uncommitted edits;
		// a refetch or an echo of our own write waits for the editor to be clean.
		if (!isNewDataSource && hasPendingChangesRef.current) return;

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
		if (dataVariables && Object.keys(dataVariables).length > 0) {
			const entries = sortByCreatedAt(Object.entries(dataVariables));
			const rows: VariableRow[] = entries.map(([key, val]) => ({
				id: carriedIds.get(key) ?? nextRowId(),
				key,
				value: val.value,
				enabled: val.enabled,
				secret: val.secret ?? false,
				type: val.type ?? "string",
				createdAt: val.createdAt,
			}));
			rows.push(blankRow(carriedBlankId));
			// eslint-disable-next-line react-hooks/set-state-in-effect -- see the guard note above
			setVariables(rows);
		} else {
			setVariables([blankRow(carriedBlankId)]);
		}
	}, [contextId, dataVariables, sortByCreatedAt]);

	const updateVariable = (index: number, field: keyof VariableRow, value: string | boolean) => {
		const newVariables = [...variables];
		newVariables[index] = { ...newVariables[index], [field]: value };

		if (newVariables[index].isNew && (newVariables[index].key || newVariables[index].value)) {
			newVariables[index].isNew = false;
			// This runs from an input event, not from render: the stamp orders newly
			// added rows and has to be the real clock, not a render-stable value.
			// eslint-disable-next-line react-hooks/purity
			newVariables[index].createdAt = Date.now(); // new ones sort to bottom
			newVariables[index].type = newVariables[index].type ?? "string";
			newVariables.push(blankRow());
		}

		setVariables(newVariables);
		// Keep the ref in sync immediately (not just via the post-render effect):
		// the secret toggle calls performSaveRef.current() synchronously right
		// after this, and performSave reads variablesRef.current - a stale ref
		// would persist the pre-edit value and the backend re-sync would then
		// revert the change. Mirrors removeVariable.
		variablesRef.current = newVariables;
		markDirty();
	};

	const removeVariable = (index: number) => {
		const newVariables = variables.filter((_, i) => i !== index);
		if (newVariables.length === 0 || !newVariables.some((v) => v.isNew)) {
			newVariables.push(blankRow());
		}
		setVariables(newVariables);
		variablesRef.current = newVariables;
		markDirty();
		performSaveRef.current();
	};

	// Environment-specific handlers
	const handleDeleteEnvironment = () => {
		if (type === "environment" && environment) {
			deleteEnvironmentMutation.mutate(environment.id, {
				onSuccess: () => {
					setShowDeleteConfirm(false);
					setSelectedCategory(null);
				},
			});
		}
	};

	const handleSetActiveEnvironment = () => {
		if (type === "environment" && environment) {
			setActiveEnvironment.mutate({ id: environment.id, previousId: activeEnvironmentId });
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
		return (
			<div className="flex items-center justify-center h-full">
				<div
					className={cn(
						"animate-spin w-6 h-6 border-2 border-t-transparent rounded-full",
						editorConfig.loadingColor
					)}
				/>
			</div>
		);
	}

	if (dataError) {
		return (
			<div className="flex items-center justify-center h-full text-destructive-text">
				<AlertCircle className="w-5 h-5 mr-2" />
				<span>
					Failed to load{" "}
					{type === "globals"
						? "globals"
						: type === "environment"
							? "environment"
							: "collection"}
				</span>
			</div>
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
								<h2 className="text-lg font-semibold text-foreground">{title}</h2>
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
									Set Active
								</Button>
							) : (
								<Badge
									variant="outline"
									className="min-w-30 h-8 justify-center border-scope-environment/40 text-scope-environment hover:bg-scope-environment/10"
								>
									Active
								</Badge>
							)}
							<TooltipIconButton
								label="Delete environment"
								icon={<Trash2 className="w-4 h-4" />}
								onClick={() => setShowDeleteConfirm(true)}
								className="h-8 w-8 text-muted-foreground hover:text-destructive-text hover:bg-destructive/10"
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
					title="Delete environment?"
					description={`"${environment.name}" will be permanently removed. This cannot be undone.`}
					onConfirm={handleDeleteEnvironment}
					isDeleting={deleteEnvironmentMutation.isPending}
				/>
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
							<th className="pb-2 w-10"></th>
						</tr>
					</thead>
					<tbody>
						{variables.map((variable, index) => {
							/*
							 * A row is a secret field once it is persisted: an
							 * unsaved blank row masks nothing, because there is
							 * no stored secret to protect and typing into a
							 * password field you just created only hides your
							 * own keystrokes.
							 */
							const isSecretField = variable.secret && !variable.isNew;

							return (
								/*
								 * Keyed by row id, not by index. With an index key a
								 * delete reuses the mounted row one position down -
								 * `SecretInput` included, reveal state and all - so
								 * deleting a revealed secret displayed its successor
								 * unmasked (#621). The id follows the row, so a
								 * deleted row's state is unmounted with it.
								 */
								<tr key={variable.id} className="group">
									{/*
									 * `px-1` is clearance for the focus ring, not decoration.
									 * The baseline draws it 1px wide at `outline-offset: 2px`,
									 * i.e. 3px outside the box, and this cell sits against the
									 * scroll container's clip edge when embedded - so with no
									 * horizontal padding the ring lost its left side.
									 *
									 * Clearance rather than `.panel-clip` on the container: the
									 * same native checkbox appears in the request builder's
									 * key-value rows, where `KeyValueRow`'s `p-1` gives it the
									 * same 4px and the ring reads as an outset hairline with a
									 * gap. Tucking this one inward would have made one control
									 * look like two, depending on the screen.
									 */}
									<td className="py-1 px-1">
										<input
											type="checkbox"
											checked={variable.enabled}
											onChange={(e) => {
												updateVariable(index, "enabled", e.target.checked);
												performSaveRef.current();
											}}
											className={cn(
												"w-4 h-4 rounded-md border-input",
												editorConfig.checkboxColor
											)}
											disabled={variable.isNew && !variable.key}
										/>
									</td>
									<td className="py-1 px-2">
										<Input
											type="text"
											value={variable.key}
											onChange={(e) =>
												updateVariable(index, "key", e.target.value)
											}
											onBlur={handleBlur}
											placeholder="variable_name"
											className={cn(
												"h-8 text-primary",
												!variable.enabled &&
													!variable.isNew &&
													"text-muted-foreground bg-muted"
											)}
										/>
									</td>
									<td className="py-1 px-2">
										{/*
										 * `SecretInput` rather than a masked `Input`
										 * and an eye of our own: that primitive was
										 * extracted from this very cell so every
										 * secret field in the app would share one
										 * implementation, and the copy left behind
										 * here missed the fixes it since received.
										 * Reveal state belongs to the primitive -
										 * unmounting on un-secret is what clears it,
										 * which is what the editor's own revealed-set
										 * used to do by hand.
										 */}
										{isSecretField ? (
											<SecretInput
												value={variable.value}
												onChange={(v) => updateVariable(index, "value", v)}
												onBlur={handleBlur}
												placeholder="value"
												className={cn(
													"h-8",
													!variable.enabled &&
														"text-muted-foreground bg-muted"
												)}
											/>
										) : (
											<Input
												type="text"
												value={variable.value}
												onChange={(e) =>
													updateVariable(index, "value", e.target.value)
												}
												onBlur={handleBlur}
												placeholder="value"
												className={cn(
													"h-8",
													!variable.enabled &&
														!variable.isNew &&
														"text-muted-foreground bg-muted",
													variable.secret && "font-mono"
												)}
											/>
										)}
									</td>
									<td className="py-1 px-2">
										<Select
											value={variable.type ?? "string"}
											onValueChange={(v) => {
												updateVariable(index, "type", v as VariableType);
												// Only fire an immediate save if the row is already persisted -
												// otherwise let the key/value entry commit it on first edit.
												if (!variable.isNew) {
													performSaveRef.current();
												}
											}}
										>
											<SelectTrigger
												className={cn(
													"h-8 text-xs px-2",
													!variable.enabled &&
														!variable.isNew &&
														"opacity-60"
												)}
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{VARIABLE_TYPES.map((t) => (
													<SelectItem
														key={t.value}
														value={t.value}
														className="text-xs"
													>
														{t.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</td>
									<td className="py-1 text-center">
										{!variable.isNew && (
											<TooltipIconButton
												label={
													variable.secret
														? "Unmark as secret"
														: "Mark as secret (masks value in UI)"
												}
												icon={<KeyRound className="w-4 h-4" />}
												onClick={() => {
													// Un-securing a row swaps `SecretInput`
													// out for a plain field, and its reveal
													// state goes with it - so re-securing
													// starts masked, without this handler
													// tracking anything.
													updateVariable(
														index,
														"secret",
														!variable.secret
													);
													performSaveRef.current();
												}}
												/*
												 * Always visible, unlike the delete button beside it.
												 *
												 * This is a state toggle, not a row action. Hidden at
												 * rest, "not secret" looked identical to "no control
												 * here", so masking a value was undiscoverable unless
												 * you happened to hover the row - and a keyboard user
												 * tabbed onto something invisible, since it carried no
												 * `group-focus-within` either.
												 *
												 * Quiet rather than absent: `muted-foreground` clears
												 * the 3.0 non-text bar on every surface here, and the
												 * on state stays clearly distinct on `warning-text`.
												 */
												className={cn(
													"h-8 w-8 transition-colors",
													variable.secret
														? "text-warning-text hover:text-warning-text hover:bg-warning/10"
														: "text-muted-foreground hover:text-foreground"
												)}
											/>
										)}
									</td>
									<td className="py-1">
										{!variable.isNew && (
											<Button
												variant="rowActionDestructive"
												size="icon"
												onClick={() => removeVariable(index)}
												aria-label="Delete variable"
												className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
											>
												<Trash2 className="w-4 h-4" />
											</Button>
										)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{/* Footer */}
			{!embedded && (
				<div className="px-4 py-2 border-t border-border bg-muted/50 text-xs text-muted-foreground">
					{variables.filter((v) => v.key && !v.isNew).length} variable(s)
				</div>
			)}
		</div>
	);
}
