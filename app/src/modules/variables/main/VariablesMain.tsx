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
import { Skeleton } from "@/components/ui";
import { EmptyState } from "@/components/shared";

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
			return collectionsLoading ? (
				<LoadingPane label="Loading collection" />
			) : (
				<NotFoundPane label="Collection not found" />
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
				<LoadingPane label="Loading environment" />
			) : (
				<NotFoundPane label="Environment not found" />
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

/** Shown while the owning query is still in flight — never "not found". */
function LoadingPane({ label }: { label: string }) {
	return (
		<div className="flex-1 p-6" role="status" aria-label={label}>
			<div className="space-y-3" aria-hidden="true">
				<Skeleton className="h-6 w-48 rounded-md" />
				<Skeleton className="h-4 w-72 rounded-md" />
				<div className="space-y-2 pt-4">
					{Array.from({ length: 4 }, (_, i) => (
						<Skeleton key={i} className="h-9 w-full rounded-md" />
					))}
				</div>
			</div>
		</div>
	);
}

/** Genuinely missing: the query settled and the entity is not in it. */
function NotFoundPane({ label }: { label: string }) {
	return <EmptyState title={label} />;
}
