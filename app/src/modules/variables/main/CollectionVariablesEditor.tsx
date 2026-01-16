/**
 * Collection Variables Editor
 *
 * Editor for variables scoped to a specific collection.
 * Uses centralized save store for auto-save with visual feedback.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Folder, Trash2 } from "lucide-react";
import { useUpdateCollectionMutation } from "@/queries";
import { useSaveStore } from "@/stores/save-store";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Collection, VariableValue } from "@/types";

interface VariableRow {
	key: string;
	value: string;
	enabled: boolean;
	isNew?: boolean;
}

interface CollectionVariablesEditorProps {
	collection: Collection;
}

export default function CollectionVariablesEditor({ collection }: CollectionVariablesEditorProps) {
	const updateMutation = useUpdateCollectionMutation();
	const {
		registerContext,
		unregisterContext,
		updateContext,
		setActiveContext,
		markPendingSave,
		startSaving,
		completeSave,
		failSave,
		setStatus,
	} = useSaveStore();

	const [variables, setVariables] = useState<VariableRow[]>([]);
	const [hasPendingChanges, setHasPendingChanges] = useState(false);
	const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const variablesRef = useRef<VariableRow[]>([]);
	const performSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

	const contextId = `collection-${collection.id}`;

	// Keep variablesRef in sync
	useEffect(() => {
		variablesRef.current = variables;
	}, [variables]);

	// Auto-save function
	const performSave = useCallback(async () => {
		const varsToSave = variablesRef.current;
		const variablesObj: Record<string, VariableValue> = {};

		varsToSave.forEach((v) => {
			if (v.key && !v.isNew) {
				variablesObj[v.key] = {
					value: v.value,
					enabled: v.enabled,
				};
			}
		});

		startSaving();

		return new Promise<void>((resolve, reject) => {
			updateMutation.mutate(
				{
					id: collection.id,
					name: collection.name,
					variables: variablesObj,
				},
				{
					onSuccess: () => {
						setHasPendingChanges(false);
						completeSave();
						setTimeout(() => setStatus("idle"), 2000);
						resolve();
					},
					onError: (error) => {
						failSave(error instanceof Error ? error.message : "Save failed");
						reject(error);
					},
				}
			);
		});
	}, [
		updateMutation,
		collection.id,
		collection.name,
		startSaving,
		completeSave,
		failSave,
		setStatus,
	]);

	// Keep performSaveRef updated
	useEffect(() => {
		performSaveRef.current = performSave;
	}, [performSave]);

	// Register save context on mount
	useEffect(() => {
		registerContext({
			id: contextId,
			name: `Collection: ${collection.name}`,
			save: () => performSaveRef.current(),
			hasPendingChanges: false,
		});
		setActiveContext(contextId);

		return () => {
			unregisterContext(contextId);
			if (saveTimeoutRef.current) {
				clearTimeout(saveTimeoutRef.current);
			}
		};
	}, [contextId, collection.name, registerContext, unregisterContext, setActiveContext]);

	// Update context when hasPendingChanges changes
	useEffect(() => {
		updateContext(contextId, { hasPendingChanges });
	}, [contextId, hasPendingChanges, updateContext]);

	// Handle blur - save when user leaves the field
	const handleBlur = useCallback(() => {
		if (hasPendingChanges) {
			if (saveTimeoutRef.current) {
				clearTimeout(saveTimeoutRef.current);
			}
			performSaveRef.current();
		}
	}, [hasPendingChanges]);

	// Handle focus - cancel any pending save
	const handleFocus = useCallback(() => {
		if (saveTimeoutRef.current) {
			clearTimeout(saveTimeoutRef.current);
		}
	}, []);

	// Initialize variables from collection data
	useEffect(() => {
		if (collection.variables) {
			const rows: VariableRow[] = Object.entries(collection.variables).map(([key, val]) => ({
				key,
				value: val.value,
				enabled: val.enabled,
			}));
			rows.push({ key: "", value: "", enabled: true, isNew: true });
			setVariables(rows);
		} else {
			setVariables([{ key: "", value: "", enabled: true, isNew: true }]);
		}
	}, [collection.id, collection.variables]);

	const updateVariable = (index: number, field: keyof VariableRow, value: string | boolean) => {
		const newVariables = [...variables];
		newVariables[index] = { ...newVariables[index], [field]: value };

		if (newVariables[index].isNew && (newVariables[index].key || newVariables[index].value)) {
			newVariables[index].isNew = false;
			newVariables.push({ key: "", value: "", enabled: true, isNew: true });
		}

		setVariables(newVariables);
		setHasPendingChanges(true);
		markPendingSave(contextId);
	};

	const removeVariable = (index: number) => {
		const newVariables = variables.filter((_, i) => i !== index);
		if (newVariables.length === 0 || !newVariables.some((v) => v.isNew)) {
			newVariables.push({ key: "", value: "", enabled: true, isNew: true });
		}
		setVariables(newVariables);
		setHasPendingChanges(true);
		performSaveRef.current();
	};

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/50">
				<div className="flex items-center gap-2">
					<Folder className="w-5 h-5 text-orange-400" />
					<div>
						<h2 className="text-lg font-semibold text-foreground">{collection.name}</h2>
						<p className="text-xs text-muted-foreground">Collection Variables</p>
					</div>
				</div>
			</div>

			<div className="px-4 py-2 text-xs text-orange-700 dark:text-orange-300 bg-orange-50 dark:bg-orange-950/50 border-b border-orange-100 dark:border-orange-900">
				Collection variables have the highest priority and override both global and
				environment variables.
			</div>

			{/* Variables Table */}
			<div className="flex-1 overflow-y-auto p-4">
				<table className="w-full">
					<thead>
						<tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
							<th className="pb-2 w-8"></th>
							<th className="pb-2 px-2">Variable</th>
							<th className="pb-2 px-2">Value</th>
							<th className="pb-2 w-10"></th>
						</tr>
					</thead>
					<tbody>
						{variables.map((variable, index) => (
							<tr key={index} className="group">
								<td className="py-1">
									<input
										type="checkbox"
										checked={variable.enabled}
										onChange={(e) => {
											updateVariable(index, "enabled", e.target.checked);
											performSaveRef.current();
										}}
										className="w-4 h-4 rounded border-input text-primary focus:ring-ring"
										disabled={variable.isNew && !variable.key}
									/>
								</td>
								<td className="py-1 px-2">
									<Input
										type="text"
										value={variable.key}
										onChange={(e) =>
											updateVariable(index, "key", e.target.value)
										}
										onFocus={handleFocus}
										onBlur={handleBlur}
										placeholder="variable_name"
										className={cn(
											"h-8",
											!variable.enabled &&
												!variable.isNew &&
												"text-muted-foreground bg-muted"
										)}
									/>
								</td>
								<td className="py-1 px-2">
									<Input
										type="text"
										value={variable.value}
										onChange={(e) =>
											updateVariable(index, "value", e.target.value)
										}
										onFocus={handleFocus}
										onBlur={handleBlur}
										placeholder="value"
										className={cn(
											"h-8",
											!variable.enabled &&
												!variable.isNew &&
												"text-muted-foreground bg-muted"
										)}
									/>
								</td>
								<td className="py-1">
									{!variable.isNew && (
										<Button
											variant="ghost"
											size="icon"
											onClick={() => removeVariable(index)}
											className="h-8 w-8 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
										>
											<Trash2 className="w-4 h-4" />
										</Button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* Footer */}
			<div className="px-4 py-2 border-t border-border bg-muted/50 text-xs text-muted-foreground">
				{variables.filter((v) => v.key && !v.isNew).length} variable(s)
			</div>
		</div>
	);
}
