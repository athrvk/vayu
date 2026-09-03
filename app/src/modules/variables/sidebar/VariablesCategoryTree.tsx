/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variables Category Tree
 *
 * Displays hierarchical tree of variable scopes:
 * - Globals
 * - Collections (with variables)
 * - Environments
 *
 * **A real WAI-ARIA tree, on the same hook the collection tree uses** (#1217).
 * Rename and Duplicate live only in the row's ⋯ menu, whose trigger is
 * `tabIndex={-1}`, so before this both actions were mouse-only: nothing here
 * listened for F2, Shift+F10, ContextMenu or Shift+Enter, and no other surface
 * offers them (`VariableTableEditor` has a delete fallback and nothing else).
 * The sidebar was also one Tab stop per control rather than one for the tree.
 *
 * `useRovingTreeFocus` is reused rather than re-implemented: a hand-rolled copy
 * would not receive the primitive's fixes, and the two lists of key guards would
 * drift the way this repo has watched them drift before. Rows declare what they
 * can do through the hook's `data-tree-*` protocol; see `docs/design-system.md`
 * "Tree Navigation".
 *
 * Two shapes here differ from the collection tree, deliberately:
 *
 *   - **The section headers are rows.** Globals, Environments and Collections
 *     are the three level-1 treeitems; the environments and collections lists
 *     are their level-2 children. That is what lets one arrow key walk the whole
 *     sidebar, and it gives the headers expand/collapse on Right/Left for free.
 *   - **"Add environment" stays a Tab stop**, outside the header row's treeitem.
 *     The tree owns no "create" key, so moving that button inside the roving
 *     tabindex would make creating an environment mouse-only - trading the
 *     defect this file just fixed for a new one. The tree is one stop; that
 *     button is the second.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useRovingTreeFocus } from "@/modules/collections/useRovingTreeFocus";
import { useDeleteRefocus } from "@/modules/collections/useDeleteRefocus";
import { useTabsStore, useSaveStore } from "@/stores";
import { useVariablesStore, type VariableCategory } from "@/modules/variables/variables-store";
import {
	useCollectionsQuery,
	useEnvironmentsQuery,
	useCreateEnvironmentMutation,
	useDeleteEnvironmentMutation,
	useUpdateEnvironmentMutation,
} from "@/queries";
import {
	RowActionsMenu,
	DrawerPanel,
	ErrorState,
	TruncatedText,
	ListSkeleton,
} from "@/components/shared";
import type { Environment } from "@/types";
import {
	Globe,
	Layers,
	ChevronDown,
	ChevronRight,
	Cloud,
	Plus,
	Trash2,
	Loader2,
	Edit2,
	Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isCommitEnter } from "@/lib/keyboard";
import { Badge, Input, DeleteConfirmDialog, TooltipIconButton } from "@/components/ui";
import { DEFAULT_ENVIRONMENT_NAME } from "@/constants/environment";

/**
 * Globals, Environments, Collections - the level-1 rows a screen reader counts
 * ("2 of 3"). A literal, because the three are written out in the JSX below
 * rather than mapped: two of them differ in shape.
 */
const SCOPE_SECTIONS = 3;

export default function VariablesCategoryTree() {
	// Fetches its own data, like the other three drawer views. It used to
	// receive both lists as props from the Drawer, which read them with `= []`
	// defaults and dropped `isLoading` - so an in-flight query rendered as an
	// empty tree and told the user "No environments" when the truthful answer
	// was "not loaded yet".
	const {
		data: collections = [],
		isLoading: isLoadingCollections,
		isError: isCollectionsError,
		refetch: refetchCollections,
	} = useCollectionsQuery();
	const {
		data: environments = [],
		isLoading: isLoadingEnvironments,
		isError: isEnvironmentsError,
		refetch: refetchEnvironments,
	} = useEnvironmentsQuery();

	/*
	 * A failed load is not an empty scope list. The drawer has three sibling
	 * views, and the collections tree already says so when its query fails -
	 * this view claiming "No collections" for the very same failure would make
	 * one event look like two. Neither section here offers a create CTA, so the
	 * reason to fix it is that symmetry, not a risk of a duplicate.
	 *
	 * Gated on `length === 0` per section: TanStack keeps the last good data
	 * through a failed background refetch, and replacing a populated list with
	 * an error would take away more than it tells. Each section reads its own
	 * query - one scope failing says nothing about the other.
	 */
	const showCollectionsError = isCollectionsError && collections.length === 0;
	const showEnvironmentsError = isEnvironmentsError && environments.length === 0;

	/*
	 * The pane variant centres inside `p-8`, which would break the rhythm of a
	 * tree of 32px rows. `px-3 py-2` is the padding the italic empty rows above
	 * already use, so the failure line sits on the tree's left edge like every
	 * other row; `justify-start` undoes the variant's centring.
	 */
	const inlineErrorClass = "justify-start px-3 py-2 text-xs";

	const { selectedCategory, setSelectedCategory } = useVariablesStore();
	const { openTab } = useTabsStore();
	const { failSave } = useSaveStore();

	const treeRef = useRef<HTMLDivElement>(null);
	const treeFocus = useRovingTreeFocus(treeRef);
	// A row's children are rendered as a sibling of the row, not inside it (the
	// shape the roving-focus walk and the hit-area rules depend on), so the
	// header row claims its list with `aria-owns` instead.
	const environmentsGroupId = useId();
	const collectionsGroupId = useId();

	const [collectionsExpanded, setCollectionsExpanded] = useState(true);

	// Selecting a scope must also surface the variables editor in the main view
	const selectCategory = (category: VariableCategory) => {
		setSelectedCategory(category);
		openTab({ type: "variables", entityId: null });
	};
	const [environmentsExpanded, setEnvironmentsExpanded] = useState(true);

	// Environment management state
	const [creatingEnvironment, setCreatingEnvironment] = useState(false);
	const [newEnvName, setNewEnvName] = useState(DEFAULT_ENVIRONMENT_NAME);
	const [deletingEnvId, setDeletingEnvId] = useState<string | null>(null);
	const [deleteConfirmEnvId, setDeleteConfirmEnvId] = useState<string | null>(null);
	const [renamingEnvId, setRenamingEnvId] = useState<string | null>(null);
	const [renameEnvValue, setRenameEnvValue] = useState("");

	// Mutations
	const createEnvironmentMutation = useCreateEnvironmentMutation();
	const deleteEnvironmentMutation = useDeleteEnvironmentMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();

	/**
	 * The row to hand focus back to once React has unmounted the rename field,
	 * set only when that field is closed *from the keyboard*. The tree is one tab
	 * stop and the field replaces the row's only focusable control, so an Enter
	 * or Escape that left focus on `<body>` would drop the user out of the tree
	 * entirely - the cost F2 would otherwise carry. A blur deliberately does not
	 * set it: focus has already gone where the user put it.
	 *
	 * The refocus waits for the effect below rather than running inline, which is
	 * the whole point of the pattern (`CollectionItem` does the same). Focusing
	 * the row while the field is still mounted *blurs* it, and its `onBlur`
	 * commits - so an inline version saved the very rename Escape had just
	 * cancelled, reading the value out of a closure the cancel had not yet
	 * cleared. An id rather than a ref because this file renders every row
	 * itself; there is no per-row component to hold one.
	 */
	const returnFocusToEnvId = useRef<string | null>(null);

	useEffect(() => {
		if (renamingEnvId || !returnFocusToEnvId.current) return;
		const envId = returnFocusToEnvId.current;
		returnFocusToEnvId.current = null;
		const rows = treeRef.current?.querySelectorAll<HTMLElement>("[data-environment-id]");
		Array.from(rows ?? [])
			.find((row) => row.dataset.environmentId === envId)
			?.focus();
	}, [renamingEnvId]);

	const startRenameEnvironment = (env: Environment) => {
		setRenamingEnvId(env.id);
		setRenameEnvValue(env.name);
	};

	const cancelRenameEnvironment = () => {
		setRenamingEnvId(null);
		setRenameEnvValue("");
	};

	const submitRenameEnvironment = async (envId: string) => {
		const name = renameEnvValue.trim();
		const current = environments.find((e) => e.id === envId);
		if (!name || name === current?.name) return cancelRenameEnvironment();
		await updateEnvironmentMutation.mutateAsync({ id: envId, name });
		cancelRenameEnvironment();
	};

	/**
	 * A complete copy - name plus every variable - in a single call. Unlike a
	 * collection, an environment has no nested children, so nothing is silently
	 * left behind.
	 */
	const duplicateEnvironment = async (env: Environment) => {
		if (createEnvironmentMutation.isPending) return;
		await createEnvironmentMutation.mutateAsync({
			name: `${env.name} (Copy)`,
			description: env.description,
			variables: env.variables ?? {},
		});
	};

	const isSelected = (category: VariableCategory) => {
		if (!selectedCategory) return false;
		if (category.type !== selectedCategory.type) return false;
		if (category.type === "globals") return true;
		if (category.type === "collection") {
			return (
				category.collectionId ===
				(selectedCategory as { type: "collection"; collectionId: string }).collectionId
			);
		}
		if (category.type === "environment") {
			return (
				category.environmentId ===
				(selectedCategory as { type: "environment"; environmentId: string }).environmentId
			);
		}
		return false;
	};

	const handleCreateEnvironment = async () => {
		if (!newEnvName.trim() || createEnvironmentMutation.isPending) return;

		const newEnv = await createEnvironmentMutation.mutateAsync({
			name: newEnvName.trim(),
			variables: {},
		});

		setCreatingEnvironment(false);
		setNewEnvName(DEFAULT_ENVIRONMENT_NAME);
		selectCategory({ type: "environment", environmentId: newEnv.id });
	};

	const envToDelete = deleteConfirmEnvId
		? environments.find((e) => e.id === deleteConfirmEnvId)
		: null;

	/*
	 * A delete dialog is controlled with no trigger, so Radix aims its close-focus
	 * at nothing and the row it was opened from is the one thing about to go: both
	 * outcomes dropped the user on `<body>`, from a Delete key this tree only
	 * gained in #1217. The tree's shared rule (#1218, #1234) answers it - the row
	 * while it is still there, the successor once the removal actually lands.
	 *
	 * No last resort to name: every environment row is a level-2 child of the
	 * Environments header, which survives the last of them, so `rowAfterRemoving`
	 * always has that header to answer with.
	 */
	const deleteRefocus = useDeleteRefocus(
		treeRef,
		deleteConfirmEnvId ? `[data-environment-id="${CSS.escape(deleteConfirmEnvId)}"]` : null,
		null
	);

	const handleConfirmDelete = async () => {
		if (!deleteConfirmEnvId) return;
		const envIdToDelete = deleteConfirmEnvId;
		setDeletingEnvId(envIdToDelete);
		try {
			await deleteEnvironmentMutation.mutateAsync(envIdToDelete);
			if (
				selectedCategory?.type === "environment" &&
				(selectedCategory as { type: "environment"; environmentId: string })
					.environmentId === envIdToDelete
			) {
				setSelectedCategory(null);
			}
		} catch (error) {
			// A bare `mutateAsync` left the rejection unhandled and the dialog up,
			// which reads as "the click didn't register" rather than "the delete
			// failed". Reported through the Dock, the channel the collection tree's
			// own failures already use.
			failSave(error instanceof Error ? error.message : "Failed to delete environment");
		} finally {
			// Both outcomes close it, because focus is handed back from the close
			// and the decision of *where* is read from whether the row actually
			// left - never from the confirm click.
			setDeleteConfirmEnvId(null);
			setDeletingEnvId(null);
		}
	};

	return (
		<>
			<DrawerPanel title="Variables">
				{/* eslint-disable-next-line jsx-a11y/interactive-supports-focus -- roving tabindex - the tree is never a tab stop, useRovingTreeFocus.ts:118-123 seeds one row's `tabIndex={0}` and moves it */}
				<div
					ref={treeRef}
					role="tree"
					aria-label="Variable scopes"
					onKeyDown={treeFocus.onKeyDown}
					onFocus={treeFocus.onFocus}
					className="flex flex-col w-full py-2"
				>
					{/* Globals Section (Lowest Priority) */}
					<div className="mb-4">
						{/* The row is the treeitem; the button inside it owns the
						    action and is not a tab stop of its own. A leaf: no
						    aria-expanded, so Right and Left move nowhere from here. */}
						<div
							role="treeitem"
							tabIndex={-1}
							aria-selected={isSelected({ type: "globals" })}
							aria-level={1}
							aria-posinset={1}
							aria-setsize={SCOPE_SECTIONS}
							data-tree-label="Globals"
							className={cn(
								// h-8: shared drawer row height (see CollectionItem).
								// focus-row: the row paints the focus ring, since it -
								// not the narrower button - is the perceived target.
								"focus-row flex h-8 items-center hover:bg-accent transition-colors",
								isSelected({ type: "globals" }) &&
									"bg-scope-global/10 text-scope-global hover:bg-scope-global/20"
							)}
						>
							<button
								type="button"
								tabIndex={-1}
								data-tree-activate
								onClick={() => selectCategory({ type: "globals" })}
								// self-stretch + flex-1: the button covers the row it
								// sits in, so nothing of the 32px is dead to a click.
								className="flex flex-1 self-stretch items-center gap-2 px-8 text-left text-sm"
							>
								<Globe className="w-3 h-3" />
								<span>Globals</span>
							</button>
						</div>
					</div>

					{/* Environments Section (Medium Priority) */}
					<div className="mb-4">
						<div className="flex items-center">
							{/* The header is a level-1 row: Right expands it, Left
							    collapses it, Enter does either. `data-tree-toggle` and
							    `data-tree-activate` are the same button because for a
							    section header those two verbs are one. */}
							<div
								role="treeitem"
								aria-selected={false}
								tabIndex={-1}
								aria-expanded={environmentsExpanded}
								aria-level={1}
								aria-posinset={2}
								aria-setsize={SCOPE_SECTIONS}
								aria-owns={environmentsExpanded ? environmentsGroupId : undefined}
								data-tree-label="Environments"
								className="focus-row flex min-w-0 flex-1 items-center"
							>
								<button
									type="button"
									tabIndex={-1}
									data-tree-toggle
									data-tree-activate
									onClick={() => setEnvironmentsExpanded(!environmentsExpanded)}
									className="flex-1 flex items-center gap-2 px-3 py-1.5 text-left text-xs tracking-wider text-muted-foreground hover:bg-accent"
								>
									{environmentsExpanded ? (
										<ChevronDown className="w-3 h-3" />
									) : (
										<ChevronRight className="w-3 h-3" />
									)}
									<Cloud className="w-3 h-3" />
									<span>Environments</span>
									<Badge
										variant="secondary"
										className="ml-auto text-xs px-1.5 py-0"
									>
										{isLoadingEnvironments || showEnvironmentsError
											? "-"
											: environments.length}
									</Badge>
								</button>
							</div>
							{/* Outside the row above, deliberately: the tree has no
							    "create" key, so this is the sidebar's second tab stop
							    rather than a control the keyboard cannot reach. */}
							<TooltipIconButton
								label="Add environment"
								icon={<Plus className="w-3 h-3" />}
								onClick={() => {
									setEnvironmentsExpanded(true);
									setCreatingEnvironment(true);
								}}
								className="h-6 w-6 mr-2"
							/>
						</div>

						{environmentsExpanded && (
							<div id={environmentsGroupId} role="group" className="mt-1">
								{/* New Environment Input */}
								{creatingEnvironment && (
									<div className="px-3 py-1 pl-6">
										<Input
											value={newEnvName}
											onChange={(e) => setNewEnvName(e.target.value)}
											onKeyDown={(e) => {
												if (isCommitEnter(e)) handleCreateEnvironment();
												if (e.key === "Escape") {
													setCreatingEnvironment(false);
													setNewEnvName(DEFAULT_ENVIRONMENT_NAME);
												}
											}}
											onBlur={() => {
												if (newEnvName.trim()) {
													handleCreateEnvironment();
												} else {
													setCreatingEnvironment(false);
													setNewEnvName(DEFAULT_ENVIRONMENT_NAME);
												}
											}}
											autoFocus
											className="h-8 text-sm"
											placeholder="Environment name"
										/>
									</div>
								)}

								{isLoadingEnvironments ? (
									<ListSkeleton rows={2} className="px-1" />
								) : showEnvironmentsError ? (
									<ErrorState
										variant="inline"
										className={inlineErrorClass}
										title="Couldn't load environments"
										onRetry={() => void refetchEnvironments()}
									/>
								) : environments.length === 0 && !creatingEnvironment ? (
									<div className="px-3 py-2 text-xs text-muted-foreground italic">
										No environments
									</div>
								) : (
									environments.map((environment, index) => {
										const variableCount = environment.variables
											? Object.keys(environment.variables).length
											: 0;
										const isDeleting = deletingEnvId === environment.id;
										return (
											/*
											 * Container + inner activator, never a
											 * bare <div onClick>. The row carries a
											 * RowActionsMenu, so it cannot be one
											 * button (the collection rows below can,
											 * and are). As a plain div it was not
											 * focusable and not operable by keyboard
											 * at all - the ⋯ menu was reachable but
											 * selecting the environment was not.
											 *
											 * The button therefore stays and owns the
											 * action. The row *additionally* delegates
											 * clicks landing on its own box - the 50px
											 * `pl-12.5` indent, the gap, `px-3` - which
											 * belong to no child and so had nowhere to
											 * go. RequestItem carries the rule and why
											 * the target check is what it is.
											 */
											// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- Enter and Space reach this row through useRovingTreeFocus.ts:200-208, which clicks its `[data-tree-activate]` button; the tree's onKeyDown is on the `role="tree"` ancestor
											<div
												key={environment.id}
												role="treeitem"
												tabIndex={-1}
												// The row a rename hands focus back to,
												// found by id rather than by a ref map.
												data-environment-id={environment.id}
												data-tree-label={environment.name}
												aria-selected={isSelected({
													type: "environment",
													environmentId: environment.id,
												})}
												aria-level={2}
												aria-posinset={index + 1}
												aria-setsize={environments.length}
												onClick={(e) => {
													if (e.target !== e.currentTarget) return;
													if (isDeleting) return;
													if (renamingEnvId === environment.id) return;
													selectCategory({
														type: "environment",
														environmentId: environment.id,
													});
												}}
												className={cn(
													"focus-row group flex h-8 cursor-pointer items-center gap-2 px-3 pl-12.5 text-sm hover:bg-accent transition-colors",
													isSelected({
														type: "environment",
														environmentId: environment.id,
													}) &&
														"bg-scope-environment/10 text-scope-environment hover:bg-scope-environment/20"
												)}
											>
												{/* <Cloud className="w-4 h-4 text-blue-400 shrink-0" /> */}
												{renamingEnvId === environment.id ? (
													<Input
														autoFocus
														value={renameEnvValue}
														onChange={(e) =>
															setRenameEnvValue(e.target.value)
														}
														onClick={(e) => e.stopPropagation()}
														onBlur={() =>
															submitRenameEnvironment(environment.id)
														}
														onKeyDown={(e) => {
															e.stopPropagation();
															if (isCommitEnter(e)) {
																returnFocusToEnvId.current =
																	environment.id;
																submitRenameEnvironment(
																	environment.id
																);
															}
															if (e.key === "Escape") {
																returnFocusToEnvId.current =
																	environment.id;
																cancelRenameEnvironment();
															}
														}}
														className="h-6 flex-1 text-sm"
													/>
												) : (
													<button
														type="button"
														tabIndex={-1}
														data-tree-activate
														onClick={() =>
															selectCategory({
																type: "environment",
																environmentId: environment.id,
															})
														}
														// self-stretch: the row above is
														// `items-center`, which leaves this
														// button - the only thing wired to
														// selectCategory - as tall as its 18px
														// label inside a 32px row. The band above
														// and below it took the hover fill but
														// not the click. Same fix as the
														// collection and request rows.
														className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left"
													>
														<TruncatedText className="flex-1">
															{environment.name}
														</TruncatedText>
														{/* `chip`: `secondary` brings
														    `hover:bg-secondary/80`, which outlives
														    the scope tint below and greyed the
														    badge on hover. */}
														{variableCount > 0 && (
															<Badge
																variant="chip"
																className="text-xs bg-scope-environment/10 text-scope-environment px-1.5 py-0 shrink-0"
															>
																{variableCount}
															</Badge>
														)}
													</button>
												)}
												{isDeleting && (
													<Loader2 className="w-3 h-3 shrink-0 animate-spin text-destructive-text" />
												)}
												{!isDeleting &&
													renamingEnvId !== environment.id && (
														<RowActionsMenu
															label={`More actions for environment ${environment.name}`}
															// The tree is one tab stop: the row
															// holds it, and Shift+F10 / Menu /
															// Shift+Enter are the way in from here.
															tabIndex={-1}
															className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
															actions={[
																{
																	label: "Rename",
																	icon: Edit2,
																	onSelect: () =>
																		startRenameEnvironment(
																			environment
																		),
																},
																{
																	label: "Duplicate",
																	icon: Copy,
																	onSelect: () =>
																		void duplicateEnvironment(
																			environment
																		),
																},
																{
																	label: "Delete",
																	icon: Trash2,
																	destructive: true,
																	onSelect: () =>
																		setDeleteConfirmEnvId(
																			environment.id
																		),
																},
															]}
														/>
													)}
												{/* Keyboard-only rename and delete targets: F2 and
												    Delete/Backspace click them (see
												    useRovingTreeFocus). Never shown; the same two
												    actions live in the row's menu, so this row
												    answers every key the tree advertises rather
												    than swallowing two of them silently - the hook
												    preventDefaults them either way. Delete opens
												    the same confirm dialog the menu does. */}
												<button
													type="button"
													className="hidden"
													aria-hidden="true"
													tabIndex={-1}
													data-tree-rename
													onClick={() => {
														// Parity with the delete target below,
														// not a live path: the confirm dialog is
														// modal, so while a deletion runs the tree
														// is inert and no key reaches this row.
														// It costs a line and holds if that ever
														// stops being true.
														if (isDeleting) return;
														startRenameEnvironment(environment);
													}}
												/>
												<button
													type="button"
													className="hidden"
													aria-hidden="true"
													tabIndex={-1}
													data-tree-delete
													onClick={() => {
														if (isDeleting) return;
														setDeleteConfirmEnvId(environment.id);
													}}
												/>
											</div>
										);
									})
								)}
							</div>
						)}
					</div>

					{/* Collections Section (Highest Priority) */}
					<div>
						<div
							role="treeitem"
							aria-selected={false}
							tabIndex={-1}
							aria-expanded={collectionsExpanded}
							aria-level={1}
							aria-posinset={3}
							aria-setsize={SCOPE_SECTIONS}
							aria-owns={collectionsExpanded ? collectionsGroupId : undefined}
							data-tree-label="Collections"
							className="focus-row flex items-center"
						>
							<button
								type="button"
								tabIndex={-1}
								data-tree-toggle
								data-tree-activate
								onClick={() => setCollectionsExpanded(!collectionsExpanded)}
								className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs tracking-wider text-muted-foreground hover:bg-accent"
							>
								{collectionsExpanded ? (
									<ChevronDown className="w-3 h-3" />
								) : (
									<ChevronRight className="w-3 h-3" />
								)}
								<Layers className="w-3 h-3" />
								<span>Collections</span>
								<Badge variant="secondary" className="ml-auto text-xs px-1.5 py-0">
									{/* A dash while loading *and* while failed: a literal 0 beside
									    "Couldn't load collections" asserts a count the app does
									    not have. Same reason loading already shows one. */}
									{isLoadingCollections || showCollectionsError
										? "-"
										: collections.length}
								</Badge>
							</button>
						</div>

						{collectionsExpanded && (
							<div id={collectionsGroupId} role="group" className="mt-1">
								{isLoadingCollections ? (
									<ListSkeleton rows={2} className="px-1" />
								) : showCollectionsError ? (
									<ErrorState
										variant="inline"
										className={inlineErrorClass}
										title="Couldn't load collections"
										onRetry={() => void refetchCollections()}
									/>
								) : collections.length === 0 ? (
									<div className="px-3 py-2 text-xs text-muted-foreground italic">
										No collections
									</div>
								) : (
									collections.map((collection, index) => {
										const variableCount = collection.variables
											? Object.keys(collection.variables).length
											: 0;
										return (
											<div
												key={collection.id}
												role="treeitem"
												tabIndex={-1}
												data-tree-label={collection.name}
												aria-selected={isSelected({
													type: "collection",
													collectionId: collection.id,
												})}
												aria-level={2}
												aria-posinset={index + 1}
												aria-setsize={collections.length}
												className={cn(
													"focus-row flex h-8 items-center hover:bg-accent transition-colors",
													isSelected({
														type: "collection",
														collectionId: collection.id,
													}) &&
														"bg-scope-collection/10 text-scope-collection hover:bg-scope-collection/20"
												)}
											>
												<button
													type="button"
													tabIndex={-1}
													data-tree-activate
													onClick={() =>
														selectCategory({
															type: "collection",
															collectionId: collection.id,
														})
													}
													// The row carries no ⋯ menu, so the button
													// covers all of it: the indent stays here
													// rather than on the row, and no part of the
													// 32px is dead to a click.
													className="flex min-w-0 flex-1 self-stretch items-center gap-2 px-3 pl-12.5 text-left text-sm"
												>
													{/* <Folder className="w-4 h-4 text-orange-400" /> */}
													<TruncatedText className="flex-1">
														{collection.name}
													</TruncatedText>
													{/* `chip` - same reason as the environment
													    badge above. */}
													{variableCount > 0 && (
														<Badge
															variant="chip"
															className="text-xs bg-scope-collection/10 text-scope-collection px-1.5 py-0"
														>
															{variableCount}
														</Badge>
													)}
												</button>
											</div>
										);
									})
								)}
							</div>
						)}
					</div>
				</div>
			</DrawerPanel>

			<DeleteConfirmDialog
				open={!!deleteConfirmEnvId}
				onOpenChange={(open) => !open && setDeleteConfirmEnvId(null)}
				title="Delete environment?"
				description={
					envToDelete
						? `"${envToDelete.name}" will be permanently removed. This cannot be undone.`
						: "This environment will be permanently removed. This cannot be undone."
				}
				onConfirm={handleConfirmDelete}
				onCloseAutoFocus={deleteRefocus.onCloseAutoFocus}
				isDeleting={!!deletingEnvId && deletingEnvId === deleteConfirmEnvId}
			/>
		</>
	);
}
