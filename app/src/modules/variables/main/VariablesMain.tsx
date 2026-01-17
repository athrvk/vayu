
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Variables Editor
 *
 * Displays the CRUD UI for the selected variable category.
 * The category selection is handled by VariablesCategoryTree in the sidebar.
 * Uses a unified VariableEditor component configured by category type.
 */

import { useVariablesStore } from "@/stores";
import { useCollectionsQuery, useEnvironmentsQuery, useGlobalsQuery } from "@/queries";
import VariableTableEditor from "./VariableTableEditor";
import { Variable } from "lucide-react";

export default function VariablesMain() {
	const { selectedCategory } = useVariablesStore();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();
	const globalsQuery = useGlobalsQuery();

	if (!selectedCategory) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
				<Variable className="w-12 h-12 opacity-50" />
				<div className="text-center">
					<p className="text-lg font-medium">No Category Selected</p>
					<p className="text-sm mt-1">
						Select a category from the sidebar to manage variables
					</p>
				</div>
			</div>
		);
	}

	// Configure the unified editor based on category type
	if (selectedCategory.type === "globals") {
		return (
			<VariableTableEditor
				config={{
					type: "globals",
					globalsData: globalsQuery.data,
					isLoading: globalsQuery.isLoading,
					error: globalsQuery.error,
				}}
			/>
		);
	}

	if (selectedCategory.type === "collection") {
		const collection = collections.find((c) => c.id === selectedCategory.collectionId);
		if (!collection) {
			return (
				<div className="flex-1 flex items-center justify-center text-muted-foreground">
					<p className="text-sm">Collection not found</p>
				</div>
			);
		}
		return (
			<VariableTableEditor
				config={{
					type: "collection",
					collection,
				}}
			/>
		);
	}

	if (selectedCategory.type === "environment") {
		const environment = environments.find((e) => e.id === selectedCategory.environmentId);
		if (!environment) {
			return (
				<div className="flex-1 flex items-center justify-center text-muted-foreground">
					<p className="text-sm">Environment not found</p>
				</div>
			);
		}
		return (
			<VariableTableEditor
				config={{
					type: "environment",
					environment,
				}}
			/>
		);
	}

	return null;
}
