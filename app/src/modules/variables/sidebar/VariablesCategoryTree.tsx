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
 */

import { useState } from "react";
import { useTabsStore } from "@/stores";
import { useVariablesStore, type VariableCategory } from "@/modules/variables/variables-store";
import {
	useCollectionsQuery,
	useEnvironmentsQuery,
	useCreateEnvironmentMutation,
	useDeleteEnvironmentMutation,
	useUpdateEnvironmentMutation,
} from "@/queries";
import { RowActionsMenu, DrawerPanel, TruncatedText, ListSkeleton } from "@/components/shared";
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
import { Badge, Input, DeleteConfirmDialog, TooltipIconButton } from "@/components/ui";
import { DEFAULT_ENVIRONMENT_NAME } from "@/constants/environment";

export default function VariablesCategoryTree() {
	// Fetches its own data, like the other three drawer views. It used to
	// receive both lists as props from the Drawer, which read them with `= []`
	// defaults and dropped `isLoading` — so an in-flight query rendered as an
	// empty tree and told the user "No environments" when the truthful answer
	// was "not loaded yet".
	const { data: collections = [], isLoading: isLoadingCollections } = useCollectionsQuery();
	const { data: environments = [], isLoading: isLoadingEnvironments } = useEnvironmentsQuery();

	const { selectedCategory, setSelectedCategory } = useVariablesStore();
	const { openTab } = useTabsStore();
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
	 * A complete copy — name plus every variable — in a single call. Unlike a
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

	const handleConfirmDelete = async () => {
		if (!deleteConfirmEnvId) return;
		const envIdToDelete = deleteConfirmEnvId;
		setDeletingEnvId(envIdToDelete);
		try {
			await deleteEnvironmentMutation.mutateAsync(envIdToDelete);
			setDeleteConfirmEnvId(null);
			if (
				selectedCategory?.type === "environment" &&
				(selectedCategory as { type: "environment"; environmentId: string })
					.environmentId === envIdToDelete
			) {
				setSelectedCategory(null);
			}
		} finally {
			setDeletingEnvId(null);
		}
	};

	return (
		<>
			<DrawerPanel title="Variables">
				<div className="flex flex-col w-full py-2">
					{/* Globals Section (Lowest Priority) */}
					<div className="mb-4">
						<button
							onClick={() => selectCategory({ type: "globals" })}
							className={cn(
								// h-8: shared drawer row height (see CollectionItem).
								"w-full flex h-8 items-center gap-2 px-8 text-left text-sm hover:bg-accent transition-colors",
								isSelected({ type: "globals" }) &&
									"bg-scope-global/10 text-scope-global hover:bg-scope-global/20"
							)}
						>
							<Globe className="w-3 h-3" />
							<span>Globals</span>
						</button>
					</div>

					{/* Environments Section (Medium Priority) */}
					<div className="mb-4">
						<div className="flex items-center">
							<button
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
								<Badge variant="secondary" className="ml-auto text-xs px-1.5 py-0">
									{isLoadingEnvironments ? "—" : environments.length}
								</Badge>
							</button>
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
							<div className="mt-1">
								{/* New Environment Input */}
								{creatingEnvironment && (
									<div className="px-3 py-1 pl-6">
										<Input
											value={newEnvName}
											onChange={(e) => setNewEnvName(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") handleCreateEnvironment();
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
								) : environments.length === 0 && !creatingEnvironment ? (
									<div className="px-3 py-2 text-xs text-muted-foreground italic">
										No environments
									</div>
								) : (
									environments.map((environment) => {
										const variableCount = environment.variables
											? Object.keys(environment.variables).length
											: 0;
										const isDeleting = deletingEnvId === environment.id;
										return (
											/*
											 * Container + inner activator, not a
											 * <div onClick>. The row carries a
											 * RowActionsMenu, so it cannot be one
											 * button (the collection rows below can,
											 * and are). As a plain div it was not
											 * focusable and not operable by keyboard
											 * at all — the ⋯ menu was reachable but
											 * selecting the environment was not.
											 */
											<div
												key={environment.id}
												className={cn(
													"focus-row group flex h-8 items-center gap-2 px-3 pl-12.5 text-sm hover:bg-accent transition-colors",
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
															if (e.key === "Enter")
																submitRenameEnvironment(
																	environment.id
																);
															if (e.key === "Escape")
																cancelRenameEnvironment();
														}}
														className="h-6 flex-1 text-sm"
													/>
												) : (
													<button
														type="button"
														onClick={() =>
															selectCategory({
																type: "environment",
																environmentId: environment.id,
															})
														}
														className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
													>
														<TruncatedText className="flex-1">
															{environment.name}
														</TruncatedText>
														{variableCount > 0 && (
															<Badge
																variant="secondary"
																className="text-xs bg-scope-environment/10 text-scope-environment px-1.5 py-0 shrink-0"
															>
																{variableCount}
															</Badge>
														)}
													</button>
												)}
												{isDeleting && (
													<Loader2 className="w-3 h-3 shrink-0 animate-spin text-destructive" />
												)}
												{!isDeleting &&
													renamingEnvId !== environment.id && (
														<RowActionsMenu
															label={`More actions for environment ${environment.name}`}
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
											</div>
										);
									})
								)}
							</div>
						)}
					</div>

					{/* Collections Section (Highest Priority) */}
					<div>
						<button
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
								{isLoadingCollections ? "—" : collections.length}
							</Badge>
						</button>

						{collectionsExpanded && (
							<div className="mt-1">
								{isLoadingCollections ? (
									<ListSkeleton rows={2} className="px-1" />
								) : collections.length === 0 ? (
									<div className="px-3 py-2 text-xs text-muted-foreground italic">
										No collections
									</div>
								) : (
									collections.map((collection) => {
										const variableCount = collection.variables
											? Object.keys(collection.variables).length
											: 0;
										return (
											<button
												key={collection.id}
												onClick={() =>
													selectCategory({
														type: "collection",
														collectionId: collection.id,
													})
												}
												className={cn(
													"w-full flex h-8 items-center gap-2 px-3 pl-12.5 text-left text-sm hover:bg-accent transition-colors",
													isSelected({
														type: "collection",
														collectionId: collection.id,
													}) &&
														"bg-scope-collection/10 text-scope-collection hover:bg-scope-collection/20"
												)}
											>
												{/* <Folder className="w-4 h-4 text-orange-400" /> */}
												<TruncatedText className="flex-1">
													{collection.name}
												</TruncatedText>
												{variableCount > 0 && (
													<Badge
														variant="secondary"
														className="text-xs bg-scope-collection/10 text-scope-collection px-1.5 py-0"
													>
														{variableCount}
													</Badge>
												)}
											</button>
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
				isDeleting={!!deletingEnvId && deletingEnvId === deleteConfirmEnvId}
			/>
		</>
	);
}
