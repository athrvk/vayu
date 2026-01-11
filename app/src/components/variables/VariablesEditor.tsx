/**
 * Variables Editor
 * 
 * Displays the CRUD UI for the selected variable category.
 * The category selection is handled by VariablesCategoryTree in the sidebar.
 */

import { useVariablesStore } from "@/stores";
import { useCollectionsQuery, useEnvironmentsQuery } from "@/queries";
import GlobalsEditor from "./GlobalsEditor";
import CollectionVariablesEditor from "./CollectionVariablesEditor";
import EnvironmentEditor from "./EnvironmentEditor";
import { Variable } from "lucide-react";

export default function VariablesEditor() {
    const { selectedCategory } = useVariablesStore();
    const { data: collections = [] } = useCollectionsQuery();
    const { data: environments = [] } = useEnvironmentsQuery();

    if (!selectedCategory) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4">
                <Variable className="w-12 h-12 opacity-50" />
                <div className="text-center">
                    <p className="text-lg font-medium">No Category Selected</p>
                    <p className="text-sm mt-1">Select a category from the sidebar to manage variables</p>
                </div>
            </div>
        );
    }

    switch (selectedCategory.type) {
        case 'globals':
            return <GlobalsEditor />;
        case 'collection':
            const collection = collections.find(c => c.id === selectedCategory.collectionId);
            if (!collection) {
                return (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                        <p className="text-sm">Collection not found</p>
                    </div>
                );
            }
            return <CollectionVariablesEditor collection={collection} />;
        case 'environment':
            const environment = environments.find(e => e.id === selectedCategory.environmentId);
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
}
