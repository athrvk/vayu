/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The CRUD UI for the variable category selected in the sidebar's `VariablesCategoryTree`, through
 * the one `VariableTableEditor` configured by category type.
 */

import { useVariablesStore } from "@/modules/variables/variables-store";
import { useCollectionsQuery, useEnvironmentsQuery, useGlobalsQuery } from "@/queries";
import VariableTableEditor from "./VariableTableEditor";
// `Braces` is the app-wide mark for variables: see the note in `constants/drawer-views.ts`.
import { Braces } from "lucide-react";
import { DetailSkeleton, EmptyState, ErrorState } from "@/components/shared";

export default function VariablesMain() {
	const selectedCategory = useVariablesStore((s) => s.selectedCategory);
	// isLoading matters, not just the data: both queries default to `[]`, so a category selected in
	// a previous session resolves to `undefined` while its query is in flight, and "not found"
	// would announce an error for something that has not arrived. isError too, each branch below
	// reading its own query's: the two are fetched independently, and a collections failure says
	// nothing about the environments.
	const {
		data: collections = [],
		isLoading: collectionsLoading,
		isError: collectionsFailed,
		error: collectionsError,
		refetch: refetchCollections,
	} = useCollectionsQuery();
	const {
		data: environments = [],
		isLoading: environmentsLoading,
		isError: environmentsFailed,
		error: environmentsError,
		refetch: refetchEnvironments,
	} = useEnvironmentsQuery();
	const globalsQuery = useGlobalsQuery();

	if (!selectedCategory) {
		return (
			<EmptyState
				icon={Braces}
				title="No category selected"
				description="Pick a category from the sidebar to manage its variables."
			/>
		);
	}

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
			if (collectionsLoading) {
				return <DetailSkeleton label="Loading collection" />;
			}
			// Nor is a failed fetch. Reached only when nothing was found, so a
			// collection still in cache renders normally through a failed
			// background refetch.
			if (collectionsFailed) {
				return (
					<ErrorState
						title="Couldn't load the collection"
						detail={
							collectionsError instanceof Error ? collectionsError.message : undefined
						}
						onRetry={() => void refetchCollections()}
					/>
				);
			}
			return <EmptyState title="Collection not found" />;
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
			if (environmentsLoading) {
				return <DetailSkeleton label="Loading environment" />;
			}
			if (environmentsFailed) {
				return (
					<ErrorState
						title="Couldn't load the environment"
						detail={
							environmentsError instanceof Error
								? environmentsError.message
								: undefined
						}
						onRetry={() => void refetchEnvironments()}
					/>
				);
			}
			return <EmptyState title="Environment not found" />;
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
