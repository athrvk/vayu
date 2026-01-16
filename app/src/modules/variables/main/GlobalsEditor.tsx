/**
 * Globals Editor
 *
 * Editor for global variables that are available across all requests.
 * Uses centralized save store for auto-save with visual feedback.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Globe, Trash2, AlertCircle } from "lucide-react";
import { useGlobalsQuery, useUpdateGlobalsMutation } from "@/queries";
import { useSaveStore } from "@/stores/save-store";
import type { VariableValue } from "@/types";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

interface VariableRow {
	key: string;
	value: string;
	enabled: boolean;
	isNew?: boolean;
}

const CONTEXT_ID = "globals-editor";

export default function GlobalsEditor() {
	const { data: globalsData, isLoading, error } = useGlobalsQuery();
	const updateMutation = useUpdateGlobalsMutation();
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
				{ variables: variablesObj },
				{
					onSuccess: () => {
						setHasPendingChanges(false);
						completeSave();
						// Reset to idle after showing "saved"
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
	}, [updateMutation, startSaving, completeSave, failSave, setStatus]);

	// Keep performSaveRef updated
	useEffect(() => {
		performSaveRef.current = performSave;
	}, [performSave]);

	// Register save context on mount
	useEffect(() => {
		registerContext({
			id: CONTEXT_ID,
			name: "Global Variables",
			save: () => performSaveRef.current(),
			hasPendingChanges: false,
		});
		setActiveContext(CONTEXT_ID);

		return () => {
			unregisterContext(CONTEXT_ID);
			if (saveTimeoutRef.current) {
				clearTimeout(saveTimeoutRef.current);
			}
		};
	}, [registerContext, unregisterContext, setActiveContext]);

	// Update context when hasPendingChanges changes
	useEffect(() => {
		updateContext(CONTEXT_ID, { hasPendingChanges });
	}, [hasPendingChanges, updateContext]);

	// Handle blur - save when user leaves the field
	const handleBlur = useCallback(() => {
		if (hasPendingChanges) {
			// Clear any pending timeout and save immediately
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

	// Initialize variables from server data
	useEffect(() => {
		if (globalsData?.variables) {
			const rows: VariableRow[] = Object.entries(globalsData.variables).map(([key, val]) => ({
				key,
				value: val.value,
				enabled: val.enabled,
			}));
			// Add empty row for new entries
			rows.push({ key: "", value: "", enabled: true, isNew: true });
			setVariables(rows);
		} else {
			setVariables([{ key: "", value: "", enabled: true, isNew: true }]);
		}
	}, [globalsData]);

	const updateVariable = (index: number, field: keyof VariableRow, value: string | boolean) => {
		const newVariables = [...variables];
		newVariables[index] = { ...newVariables[index], [field]: value };

		// If editing the last row (new row), add another empty row
		if (newVariables[index].isNew && (newVariables[index].key || newVariables[index].value)) {
			newVariables[index].isNew = false;
			newVariables.push({ key: "", value: "", enabled: true, isNew: true });
		}

		setVariables(newVariables);
		setHasPendingChanges(true);
		markPendingSave(CONTEXT_ID);
	};

	const removeVariable = (index: number) => {
		const newVariables = variables.filter((_, i) => i !== index);
		// Ensure there's always at least one row
		if (newVariables.length === 0 || !newVariables.some((v) => v.isNew)) {
			newVariables.push({ key: "", value: "", enabled: true, isNew: true });
		}
		setVariables(newVariables);
		// Save immediately on delete (not editing text)
		setHasPendingChanges(true);
		performSaveRef.current();
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-full">
				<div className="animate-spin w-6 h-6 border-2 border-green-500 border-t-transparent rounded-full" />
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex items-center justify-center h-full text-destructive">
				<AlertCircle className="w-5 h-5 mr-2" />
				<span>Failed to load globals</span>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
				<div className="flex items-center gap-2">
					<Globe className="w-5 h-5 text-green-500" />
					<h2 className="text-lg font-semibold text-foreground">Global Variables</h2>
				</div>
			</div>

			<div className="px-4 py-2 text-xs text-muted-foreground bg-green-50 dark:bg-green-950/30 border-b border-green-100 dark:border-green-900">
				Global variables are available in all requests (lowest priority). They can be
				overridden by environment and collection variables.
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
											// Checkboxes save immediately
											performSaveRef.current();
										}}
										className="w-4 h-4 rounded border-input text-green-500 focus:ring-green-500 accent-green-500"
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
											className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
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

			{/* Footer with count */}
			<div className="px-4 py-2 border-t bg-muted/50 text-xs text-muted-foreground">
				{variables.filter((v) => v.key && !v.isNew).length} variable(s)
			</div>
		</div>
	);
}
