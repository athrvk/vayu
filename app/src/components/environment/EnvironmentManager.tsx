import { useState, useEffect } from "react";
import { Plus, Edit2, Trash2, Check, X } from "lucide-react";
import { useEnvironmentStore } from "@/stores";
import { apiService } from "@/services";
import type { Environment } from "@/types";

export default function EnvironmentManager() {
	const {
		environments,
		setEnvironments,
		activeEnvironmentId,
		addEnvironment,
		updateEnvironment: updateStoreEnvironment,
		removeEnvironment,
	} = useEnvironmentStore();

	const [creating, setCreating] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [formData, setFormData] = useState<{
		name: string;
		variables: Record<string, string>;
	}>({
		name: "",
		variables: {},
	});

	useEffect(() => {
		loadEnvironments();
	}, []);

	const loadEnvironments = async () => {
		try {
			const envs = await apiService.listEnvironments();
			setEnvironments(envs);
		} catch (error) {
			console.error("Failed to load environments:", error);
		}
	};

	const handleCreate = () => {
		setCreating(true);
		setFormData({ name: "New Environment", variables: {} });
	};

	const handleEdit = (env: Environment) => {
		setEditing(env.id);
		setFormData({ name: env.name, variables: env.variables });
	};

	const handleSave = async () => {
		try {
			if (creating) {
				const newEnv = await apiService.createEnvironment({
					name: formData.name,
					variables: formData.variables,
					is_active: false,
				});
				addEnvironment(newEnv);
				setCreating(false);
			} else if (editing) {
				const updated = await apiService.updateEnvironment({
					id: editing,
					name: formData.name,
					variables: formData.variables,
				});
				updateStoreEnvironment(updated);
				setEditing(null);
			}
			setFormData({ name: "", variables: {} });
		} catch (error) {
			console.error("Failed to save environment:", error);
		}
	};

	const handleCancel = () => {
		setCreating(false);
		setEditing(null);
		setFormData({ name: "", variables: {} });
	};

	const handleDelete = async (id: string) => {
		if (confirm("Delete this environment?")) {
			try {
				await apiService.deleteEnvironment(id);
				removeEnvironment(id);
			} catch (error) {
				console.error("Failed to delete environment:", error);
			}
		}
	};

	const handleSetActive = async (id: string) => {
		try {
			await apiService.updateEnvironment({ id, is_active: true });
			// Deactivate others
			for (const env of environments) {
				if (env.id !== id && env.is_active) {
					await apiService.updateEnvironment({ id: env.id, is_active: false });
				}
			}
			await loadEnvironments();
		} catch (error) {
			console.error("Failed to set active environment:", error);
		}
	};

	const handleVariableChange = (key: string, value: string) => {
		setFormData((prev) => ({
			...prev,
			variables: { ...prev.variables, [key]: value },
		}));
	};

	const handleRemoveVariable = (key: string) => {
		setFormData((prev) => {
			const { [key]: _, ...rest } = prev.variables;
			return { ...prev, variables: rest };
		});
	};

	const handleAddVariable = () => {
		const key = prompt("Variable name:");
		if (key && key.trim()) {
			setFormData((prev) => ({
				...prev,
				variables: { ...prev.variables, [key.trim()]: "" },
			}));
		}
	};

	return (
		<div className="p-4 space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-semibold text-gray-700">Environments</h2>
				<button
					onClick={handleCreate}
					className="p-1.5 hover:bg-gray-100 rounded transition-colors"
					title="New Environment"
				>
					<Plus className="w-4 h-4 text-gray-600" />
				</button>
			</div>

			{/* Creating/Editing Form */}
			{(creating || editing) && (
				<div className="p-4 bg-white border border-gray-300 rounded-lg space-y-3">
					<input
						type="text"
						value={formData.name}
						onChange={(e) => setFormData({ ...formData, name: e.target.value })}
						placeholder="Environment name"
						className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
					/>

					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<label className="text-sm font-medium text-gray-700">
								Variables
							</label>
							<button
								onClick={handleAddVariable}
								className="text-xs text-primary-600 hover:text-primary-700"
							>
								+ Add Variable
							</button>
						</div>

						{Object.entries(formData.variables).map(([key, value]) => (
							<div key={key} className="flex gap-2">
								<input
									type="text"
									value={key}
									readOnly
									className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded bg-gray-50"
								/>
								<input
									type="text"
									value={value}
									onChange={(e) => handleVariableChange(key, e.target.value)}
									placeholder="Value"
									className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
								/>
								<button
									onClick={() => handleRemoveVariable(key)}
									className="p-1 hover:bg-red-100 rounded"
								>
									<X className="w-4 h-4 text-red-600" />
								</button>
							</div>
						))}
					</div>

					<div className="flex gap-2 justify-end">
						<button
							onClick={handleCancel}
							className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
						>
							Cancel
						</button>
						<button
							onClick={handleSave}
							className="px-3 py-1.5 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
						>
							Save
						</button>
					</div>
				</div>
			)}

			{/* Environments List */}
			{environments.length === 0 && !creating && (
				<div className="text-center py-8 text-sm text-gray-500">
					<p>No environments yet</p>
					<button
						onClick={handleCreate}
						className="mt-3 text-primary-600 hover:text-primary-700 font-medium"
					>
						Create your first environment
					</button>
				</div>
			)}

			{environments.map((env) => (
				<div
					key={env.id}
					className={`p-3 rounded-lg border ${
						env.id === activeEnvironmentId
							? "border-primary-500 bg-primary-50"
							: "border-gray-200 bg-white"
					}`}
				>
					<div className="flex items-start justify-between mb-2">
						<div className="flex-1">
							<h3 className="font-medium text-gray-900">{env.name}</h3>
							{env.id === activeEnvironmentId && (
								<span className="text-xs text-primary-600 font-medium">
									Active
								</span>
							)}
						</div>
						<div className="flex gap-1">
							{env.id !== activeEnvironmentId && (
								<button
									onClick={() => handleSetActive(env.id)}
									className="p-1 hover:bg-green-100 rounded"
									title="Set as active"
								>
									<Check className="w-4 h-4 text-green-600" />
								</button>
							)}
							<button
								onClick={() => handleEdit(env)}
								className="p-1 hover:bg-blue-100 rounded"
								title="Edit"
							>
								<Edit2 className="w-4 h-4 text-blue-600" />
							</button>
							<button
								onClick={() => handleDelete(env.id)}
								className="p-1 hover:bg-red-100 rounded"
								title="Delete"
							>
								<Trash2 className="w-4 h-4 text-red-600" />
							</button>
						</div>
					</div>

					<div className="space-y-1">
						{Object.entries(env.variables).map(([key, value]) => (
							<div key={key} className="flex gap-2 text-xs">
								<span className="font-mono text-gray-700">{key}:</span>
								<span className="font-mono text-gray-600">{value}</span>
							</div>
						))}
						{Object.keys(env.variables).length === 0 && (
							<p className="text-xs text-gray-400">No variables</p>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
