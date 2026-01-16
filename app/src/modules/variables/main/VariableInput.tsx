/**
 * VariableInput Component
 *
 * A convenience wrapper around TemplatedInput that automatically
 * connects to the useVariableResolver hook and supports inline
 * variable editing.
 *
 * For new code, prefer using TemplatedInput directly with your own
 * variable resolution logic, or use this wrapper for quick integration.
 */

import { TemplatedInput, type VariableInfo, type VariableScope } from "@/components/ui";
import { useVariableResolver } from "@/hooks";
import {
	useGlobalsQuery,
	useUpdateGlobalsMutation,
	useCollectionsQuery,
	useUpdateCollectionMutation,
	useEnvironmentsQuery,
	useUpdateEnvironmentMutation,
} from "@/queries";
import { useVariablesStore } from "@/stores";
import type { VariableValue } from "@/types";

interface VariableInputProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
	disabled?: boolean;
	collectionId?: string;
	/** Enable inline variable editing (default: true) */
	enableInlineEdit?: boolean;
}

export default function VariableInput({
	value,
	onChange,
	placeholder = "Enter value...",
	className,
	disabled = false,
	collectionId,
	enableInlineEdit = true,
}: VariableInputProps) {
	const { getAllVariables, getVariable } = useVariableResolver({ collectionId });
	const { activeEnvironmentId } = useVariablesStore();

	// Data queries
	const { data: globalsData } = useGlobalsQuery();
	const { data: collections = [] } = useCollectionsQuery();
	const { data: environments = [] } = useEnvironmentsQuery();

	// Mutations
	const updateGlobalsMutation = useUpdateGlobalsMutation();
	const updateCollectionMutation = useUpdateCollectionMutation();
	const updateEnvironmentMutation = useUpdateEnvironmentMutation();

	// Convert the resolver's format to what TemplatedInput expects
	const getVariables = (): Record<string, VariableInfo> => {
		const vars = getAllVariables();
		const result: Record<string, VariableInfo> = {};
		for (const [name, source] of Object.entries(vars)) {
			result[name] = {
				value: source.value,
				scope: source.scope,
			};
		}
		return result;
	};

	const resolveVariable = (name: string): VariableInfo | null => {
		const varInfo = getVariable(name);
		if (!varInfo) return null;
		return {
			value: varInfo.value,
			scope: varInfo.scope,
		};
	};

	// Handler to update variable value inline
	const handleUpdateVariable = (name: string, newValue: string, scope: VariableScope) => {
		if (!enableInlineEdit) return;

		switch (scope) {
			case "global": {
				if (!globalsData?.variables) return;
				const updatedVars: Record<string, VariableValue> = { ...globalsData.variables };
				if (updatedVars[name]) {
					updatedVars[name] = { ...updatedVars[name], value: newValue };
				} else {
					updatedVars[name] = { value: newValue, enabled: true };
				}
				updateGlobalsMutation.mutate({ variables: updatedVars });
				break;
			}
			case "collection": {
				if (!collectionId) return;
				const collection = collections.find((c) => c.id === collectionId);
				if (!collection) return;
				const updatedVars: Record<string, VariableValue> = { ...collection.variables };
				if (updatedVars[name]) {
					updatedVars[name] = { ...updatedVars[name], value: newValue };
				} else {
					updatedVars[name] = { value: newValue, enabled: true };
				}
				updateCollectionMutation.mutate({ id: collectionId, variables: updatedVars });
				break;
			}
			case "environment": {
				if (!activeEnvironmentId) return;
				const environment = environments.find((e) => e.id === activeEnvironmentId);
				if (!environment) return;
				const updatedVars: Record<string, VariableValue> = { ...environment.variables };
				if (updatedVars[name]) {
					updatedVars[name] = { ...updatedVars[name], value: newValue };
				} else {
					updatedVars[name] = { value: newValue, enabled: true };
				}
				updateEnvironmentMutation.mutate({
					id: activeEnvironmentId,
					variables: updatedVars,
				});
				break;
			}
		}
	};

	return (
		<TemplatedInput
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			className={className}
			disabled={disabled}
			getVariables={getVariables}
			resolveVariable={resolveVariable}
			onUpdateVariable={enableInlineEdit ? handleUpdateVariable : undefined}
		/>
	);
}
