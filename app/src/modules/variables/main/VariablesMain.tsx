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

import { useVariablesStore } from "@/modules/variables/variables-store";
import { useCollectionsQuery, useEnvironmentsQuery, useGlobalsQuery } from "@/queries";
import VariableTableEditor from "./VariableTableEditor";
import { Variable } from "lucide-react";
import { DetailSkeleton, EmptyState } from "@/components/shared";

export default function VariablesMain() {
	const { selectedCategory } = useVariablesStore();
	// isLoading matters here, not just the data. Both queries default to `[]`,
	// so a category selected from a previous session resolved to `undefined`
	// while its query was still in flight and the screen announced "not found"
	// — an error, for something that simply had not arrived yet.
	const { data: collections = [], isLoading: collectionsLoading } = useCollectionsQuery();
	const { data: environments = [], isLoading: environmentsLoading } = useEnvironmentsQuery();
	const globalsQuery = useGlobalsQuery();

	if (!selectedCategory) {
		return (
			<EmptyState
				icon={Variable}
				title="No category selected"
				description="Pick a category from the sidebar to manage its variables."
			/>
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
			// Still in flight is not the same as missing: saying "not found"
			// here tells the user their collection is gone.
			return collectionsLoading ? (
				<DetailSkeleton label="Loading collection" />
			) : (
				<EmptyState title="Collection not found" />
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
			return environmentsLoading ? (
				<DetailSkeleton label="Loading environment" />
			) : (
				<EmptyState title="Environment not found" />
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
