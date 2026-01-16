/**
 * Variables Panel
 *
 * Split view showing:
 * - Left: Category tree (Globals, Collections, Environments)
 * - Right: Editor for selected category
 */

import { useVariablesStore } from "@/stores";
import { useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import VariablesCategoryTree from "../sidebar/VariablesCategoryTree";
import GlobalsEditor from "./GlobalsEditor";
import CollectionVariablesEditor from "./CollectionVariablesEditor";
import EnvironmentEditor from "./EnvironmentEditor";

export default function VariablesPanel() {
	const { selectedCategory } = useVariablesStore();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();

	const renderEditor = () => {
		if (!selectedCategory) {
			return (
				<div className="flex-1 flex items-center justify-center text-muted-foreground">
					<p className="text-sm">Select a category to manage variables</p>
				</div>
			);
		}

		switch (selectedCategory.type) {
			case "globals":
				return <GlobalsEditor />;
			case "collection":
				const collection = collections.find((c) => c.id === selectedCategory.collectionId);
				if (!collection) {
					return (
						<div className="flex-1 flex items-center justify-center text-muted-foreground">
							<p className="text-sm">Collection not found</p>
						</div>
					);
				}
				return <CollectionVariablesEditor collection={collection} />;
			case "environment":
				const environment = environments.find(
					(e) => e.id === selectedCategory.environmentId
				);
				if (!environment) {
					return (
						<div className="flex-1 flex items-center justify-center text-muted-foreground">
							<p className="text-sm">Environment not found</p>
						</div>
					);
				}
				return <EnvironmentEditor environment={environment} />;
			default:
				return null;
		}
	};

	return (
		<div className="flex h-full">
			{/* Left Panel - Category Tree */}
			<div className="w-64 border-r overflow-y-auto bg-muted/30">
				<VariablesCategoryTree collections={collections} environments={environments} />
			</div>

			{/* Right Panel - Editor */}
			<div className="flex-1 overflow-y-auto bg-card">{renderEditor()}</div>
		</div>
	);
}
