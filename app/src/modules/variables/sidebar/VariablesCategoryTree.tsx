/**
 * Variables Category Tree
 *
 * Displays hierarchical tree of variable scopes:
 * - Globals
 * - Collections (with variables)
 * - Environments
 */

import { useState } from "react";
import { useVariablesStore, type VariableCategory } from "@/stores";
import { useCreateEnvironmentMutation, useDeleteEnvironmentMutation } from "@/queries";
import type { Collection, Environment } from "@/types";
import {
	Globe,
	Folder,
	Layers,
	ChevronDown,
	ChevronRight,
	Cloud,
	Plus,
	Trash2,
	Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge, Button, Input } from "@/components/ui";

interface VariablesCategoryTreeProps {
	collections: Collection[];
	environments: Environment[];
}

export default function VariablesCategoryTree({
	collections,
	environments,
}: VariablesCategoryTreeProps) {
	const { selectedCategory, setSelectedCategory } = useVariablesStore();
	const [collectionsExpanded, setCollectionsExpanded] = useState(true);
	const [environmentsExpanded, setEnvironmentsExpanded] = useState(true);

	// Environment management state
	const [creatingEnvironment, setCreatingEnvironment] = useState(false);
	const [newEnvName, setNewEnvName] = useState("New Environment");
	const [deletingEnvId, setDeletingEnvId] = useState<string | null>(null);

	// Mutations
	const createEnvironmentMutation = useCreateEnvironmentMutation();
	const deleteEnvironmentMutation = useDeleteEnvironmentMutation();

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
		setNewEnvName("New Environment");
		setSelectedCategory({ type: "environment", environmentId: newEnv.id });
	};

	const handleDeleteEnvironment = async (envId: string, e: React.MouseEvent) => {
		e.stopPropagation();
		if (deleteEnvironmentMutation.isPending) return;

		setDeletingEnvId(envId);
		await deleteEnvironmentMutation.mutateAsync(envId);
		setDeletingEnvId(null);

		// If we deleted the selected environment, clear selection
		if (
			selectedCategory?.type === "environment" &&
			(selectedCategory as { type: "environment"; environmentId: string }).environmentId ===
				envId
		) {
			setSelectedCategory(null);
		}
	};

	return (
		<div className="flex flex-col h-full w-full py-2">
			{/* Globals Section (Lowest Priority) */}
			<div className="mb-4">
				<button
					onClick={() => setSelectedCategory({ type: "globals" })}
					className={cn(
						"w-full flex items-center gap-2 px-7.5 py-2 text-left text-sm hover:bg-accent transition-colors",
						isSelected({ type: "globals" }) &&
							"bg-primary/10 text-primary hover:bg-primary/15"
					)}
				>
					<Globe className="w-4 h-4 text-green-500" />
					<span className="font-medium">Globals</span>
				</button>
			</div>

			{/* Environments Section (Medium Priority) */}
			<div className="mb-4">
				<div className="flex items-center">
					<button
						onClick={() => setEnvironmentsExpanded(!environmentsExpanded)}
						className="flex-1 flex items-center gap-2 px-3 py-1.5 text-left text-xs uppercase tracking-wider text-muted-foreground hover:bg-accent"
					>
						{environmentsExpanded ? (
							<ChevronDown className="w-3 h-3" />
						) : (
							<ChevronRight className="w-3 h-3" />
						)}
						<Cloud className="w-3 h-3" />
						<span>Environments</span>
						<Badge variant="secondary" className="ml-auto text-xs px-1.5 py-0">
							{environments.length}
						</Badge>
					</button>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => {
							setEnvironmentsExpanded(true);
							setCreatingEnvironment(true);
						}}
						className="h-6 w-6 mr-2"
						title="Add Environment"
					>
						<Plus className="w-3 h-3" />
					</Button>
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
											setNewEnvName("New Environment");
										}
									}}
									onBlur={() => {
										if (newEnvName.trim()) {
											handleCreateEnvironment();
										} else {
											setCreatingEnvironment(false);
											setNewEnvName("New Environment");
										}
									}}
									autoFocus
									className="h-8 text-sm"
									placeholder="Environment name"
								/>
							</div>
						)}

						{environments.length === 0 && !creatingEnvironment ? (
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
									<div
										key={environment.id}
										className={cn(
											"group flex items-center gap-2 px-3 py-2 pl-12.5 text-sm hover:bg-accent transition-colors cursor-pointer",
											isSelected({
												type: "environment",
												environmentId: environment.id,
											}) &&
												"bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/70"
										)}
										onClick={() =>
											setSelectedCategory({
												type: "environment",
												environmentId: environment.id,
											})
										}
									>
										{/* <Cloud className="w-4 h-4 text-blue-400 shrink-0" /> */}
										<span className="truncate flex-1">{environment.name}</span>
										{variableCount > 0 && (
											<Badge
												variant="secondary"
												className="text-xs bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-300 px-1.5 py-0 shrink-0"
											>
												{variableCount}
											</Badge>
										)}
										<Button
											variant="ghost"
											size="icon"
											onClick={(e) =>
												handleDeleteEnvironment(environment.id, e)
											}
											disabled={isDeleting}
											className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
											title="Delete Environment"
										>
											{isDeleting ? (
												<Loader2 className="w-3 h-3 animate-spin" />
											) : (
												<Trash2 className="w-3 h-3" />
											)}
										</Button>
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
					className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs uppercase tracking-wider text-muted-foreground hover:bg-accent"
				>
					{collectionsExpanded ? (
						<ChevronDown className="w-3 h-3" />
					) : (
						<ChevronRight className="w-3 h-3" />
					)}
					<Layers className="w-3 h-3" />
					<span>Collections</span>
					<Badge variant="secondary" className="ml-auto text-xs px-1.5 py-0">
						{collections.length}
					</Badge>
				</button>

				{collectionsExpanded && (
					<div className="mt-1">
						{collections.length === 0 ? (
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
											setSelectedCategory({
												type: "collection",
												collectionId: collection.id,
											})
										}
										className={cn(
											"w-full flex items-center gap-2 px-3 py-2 pl-12.5 text-left text-sm hover:bg-accent transition-colors",
											isSelected({
												type: "collection",
												collectionId: collection.id,
											}) &&
												"bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-950/70"
										)}
									>
										{/* <Folder className="w-4 h-4 text-orange-400" /> */}
										<span className="truncate flex-1">{collection.name}</span>
										{variableCount > 0 && (
											<Badge
												variant="secondary"
												className="text-xs bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-300 px-1.5 py-0"
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
	);
}
