import { useEffect, useState } from "react";
import { Play, Zap, Save, Loader2 } from "lucide-react";
import {
	useAppStore,
	useRequestBuilderStore,
	useCollectionsStore,
	useEnvironmentStore,
	useDashboardStore,
} from "@/stores";
import { useEngine, useAutoSave } from "@/hooks";
import { apiService } from "@/services";
import { getMethodColor } from "@/utils";
import type { HttpMethod } from "@/types";
import ResponseViewer from "./ResponseViewer";
import LoadTestConfigDialog from "./LoadTestConfigDialog";
import ScriptEditor from "./ScriptEditor";

export default function RequestBuilder() {
	const { selectedRequestId, setActiveScreen } = useAppStore();
	const {
		currentRequest,
		setCurrentRequest,
		updateRequestField,
		activeTab,
		setActiveTab,
		responseData,
		setResponseData,
		isExecuting,
		setExecuting,
		hasUnsavedChanges,
		isSaving,
		setSaving,
		setUnsavedChanges,
	} = useRequestBuilderStore();
	const { getRequestById, updateRequest: updateStoreRequest } =
		useCollectionsStore();
	const { activeEnvironmentId } = useEnvironmentStore();
	const { startRun } = useDashboardStore();
	const { executeRequest, startLoadTest } = useEngine();
	const [showLoadTestDialog, setShowLoadTestDialog] = useState(false);
	const [isStartingLoadTest, setIsStartingLoadTest] = useState(false);

	// Enable auto-save
	useAutoSave(true);

	// Load request when selected
	useEffect(() => {
		if (selectedRequestId) {
			const request = getRequestById(selectedRequestId);
			if (request) {
				setCurrentRequest(request);
			}
		}
	}, [selectedRequestId, getRequestById, setCurrentRequest]);

	if (!currentRequest) {
		return (
			<div className="flex-1 flex items-center justify-center text-gray-500">
				<p>Select a request to get started</p>
			</div>
		);
	}

	const httpMethods: HttpMethod[] = [
		"GET",
		"POST",
		"PUT",
		"PATCH",
		"DELETE",
		"HEAD",
		"OPTIONS",
	];

	const handleSend = async () => {
		if (
			!currentRequest?.id ||
			!currentRequest?.method ||
			!currentRequest?.url
		) {
			console.error("Missing required request fields");
			return;
		}

		// Save first if there are unsaved changes
		if (hasUnsavedChanges) {
			await handleSave();
		}

		setExecuting(true);
		setResponseData(null);

		// Build full request object from partial
		const fullRequest: import("@/types").Request = {
			id: currentRequest.id,
			collection_id: currentRequest.collection_id || "",
			name: currentRequest.name || "Untitled",
			method: currentRequest.method,
			url: currentRequest.url,
			headers: currentRequest.headers,
			body: currentRequest.body,
			body_type: currentRequest.body_type,
			auth: currentRequest.auth,
			pre_request_script: currentRequest.pre_request_script,
			test_script: currentRequest.test_script,
			created_at: currentRequest.created_at || new Date().toISOString(),
			updated_at: currentRequest.updated_at || new Date().toISOString(),
			description: currentRequest.description,
		};

		const result = await executeRequest(
			fullRequest,
			activeEnvironmentId || undefined
		);
		if (result) {
			setResponseData(result);
		}
		setExecuting(false);
	};

	const handleLoadTest = () => {
		setShowLoadTestDialog(true);
	};

	const handleStartLoadTest = async (config: any) => {
		if (!currentRequest.id) return;

		setIsStartingLoadTest(true);
		try {
			// Save first if there are unsaved changes
			if (hasUnsavedChanges) {
				await handleSave();
			}

			// Pass the full request object to startLoadTest
			const result = await startLoadTest(
				currentRequest,
				config,
				activeEnvironmentId || undefined
			);

			if (result) {
				startRun(result.runId);
				setActiveScreen("dashboard");
			}

			setShowLoadTestDialog(false);
		} catch (error) {
			console.error("Failed to start load test:", error);
		} finally {
			setIsStartingLoadTest(false);
		}
	};

	const handleSave = async () => {
		if (!currentRequest.id) return;

		setSaving(true);
		try {
			const updated = await apiService.updateRequest({
				id: currentRequest.id,
				name: currentRequest.name,
				description: currentRequest.description,
				method: currentRequest.method,
				url: currentRequest.url,
				headers: currentRequest.headers,
				body: currentRequest.body,
				body_type: currentRequest.body_type,
				auth: currentRequest.auth,
				pre_request_script: currentRequest.pre_request_script,
				test_script: currentRequest.test_script,
			});
			updateStoreRequest(updated);
			setCurrentRequest(updated);
			setUnsavedChanges(false);
			console.log("Request saved successfully:", updated);
		} catch (error) {
			console.error("Failed to save request:", error);
		} finally {
			setSaving(false);
		}
	};

	const tabs = [
		{ id: "params" as const, label: "Params" },
		{ id: "headers" as const, label: "Headers" },
		{ id: "body" as const, label: "Body" },
		{ id: "pre-script" as const, label: "Pre-request Script" },
		{ id: "test-script" as const, label: "Test Script" },
	];

	return (
		<div className="flex-1 flex flex-col overflow-hidden bg-white">
			{/* Header */}
			<div className="border-b border-gray-200 p-4">
				<div className="flex items-center gap-3 mb-3">
					<input
						type="text"
						value={currentRequest.name || ""}
						onChange={(e) => updateRequestField("name", e.target.value)}
						className="text-lg font-semibold border-none outline-none focus:ring-2 focus:ring-primary-500 px-2 py-1 rounded"
						placeholder="Request name"
					/>
					{isSaving && (
						<span className="text-xs text-gray-500 flex items-center gap-1">
							<Loader2 className="w-3 h-3 animate-spin" />
							Saving...
						</span>
					)}
					{hasUnsavedChanges && !isSaving && (
						<span className="text-xs text-gray-500">• Unsaved</span>
					)}
				</div>

				<div className="flex items-center gap-2">
					<select
						value={currentRequest.method || "GET"}
						onChange={(e) =>
							updateRequestField("method", e.target.value as HttpMethod)
						}
						className={`px-3 py-2 font-mono font-semibold text-sm rounded border border-gray-300 focus:outline-none focus:ring-2 focus:ring-primary-500 ${getMethodColor(
							currentRequest.method || "GET"
						)}`}
					>
						{httpMethods.map((method) => (
							<option key={method} value={method}>
								{method}
							</option>
						))}
					</select>

					<input
						type="text"
						value={currentRequest.url || ""}
						onChange={(e) => updateRequestField("url", e.target.value)}
						placeholder="https://api.example.com/endpoint"
						className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
					/>

					<button
						onClick={handleSend}
						disabled={isExecuting || !currentRequest.url}
						className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						{isExecuting ? (
							<>
								<Loader2 className="w-4 h-4 animate-spin" />
								Sending...
							</>
						) : (
							<>
								<Play className="w-4 h-4" />
								Send
							</>
						)}
					</button>

					<button
						onClick={handleLoadTest}
						disabled={isExecuting || !currentRequest.url}
						className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						<Zap className="w-4 h-4" />
						Load Test
					</button>

					<button
						onClick={handleSave}
						disabled={!hasUnsavedChanges || isSaving}
						className="p-2 hover:bg-gray-100 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						title="Save"
					>
						<Save className="w-5 h-5 text-gray-600" />
					</button>
				</div>
			</div>

			{/* Tabs */}
			<div className="flex border-b border-gray-200">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						onClick={() => setActiveTab(tab.id)}
						className={`px-4 py-2 text-sm font-medium transition-colors ${
							activeTab === tab.id
								? "text-primary-600 border-b-2 border-primary-600"
								: "text-gray-600 hover:text-gray-900"
						}`}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Tab Content & Response Viewer */}
			<div className="flex-1 flex overflow-hidden">
				<div className="flex-1 overflow-auto p-4">
					<TabContent />
				</div>

				{responseData && (
					<div className="w-1/2 border-l border-gray-200">
						<ResponseViewer response={responseData} />
					</div>
				)}
			</div>

			{/* Load Test Config Dialog */}
			{showLoadTestDialog && (
				<LoadTestConfigDialog
					onClose={() => setShowLoadTestDialog(false)}
					onStart={handleStartLoadTest}
					isStarting={isStartingLoadTest}
				/>
			)}
		</div>
	);
}

function TabContent() {
	const { currentRequest, updateRequestField, activeTab } =
		useRequestBuilderStore();

	if (!currentRequest) return null;

	switch (activeTab) {
		case "params":
			return (
				<div className="space-y-2">
					<p className="text-sm text-gray-500">
						Use {"{"}
						{"{"} and {"}"}
						{"}"} for environment variables in the URL
					</p>
					<div className="p-4 bg-gray-50 rounded">
						<code className="text-sm font-mono">{currentRequest.url}</code>
					</div>
				</div>
			);

		case "headers":
			return <HeadersEditor />;

		case "body":
			return (
				<div className="space-y-3">
					<select
						value={currentRequest.body_type || "json"}
						onChange={(e) =>
							updateRequestField("body_type", e.target.value as any)
						}
						className="px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
					>
						<option value="json">JSON</option>
						<option value="text">Text</option>
						<option value="form-data">Form Data</option>
						<option value="x-www-form-urlencoded">URL Encoded</option>
					</select>
					<textarea
						value={currentRequest.body || ""}
						onChange={(e) => updateRequestField("body", e.target.value)}
						placeholder="Request body"
						className="w-full h-96 px-3 py-2 border border-gray-300 rounded font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
					/>
				</div>
			);

		case "pre-script":
			return (
				<div className="space-y-3">
					<p className="text-sm text-gray-600">
						Execute JavaScript before sending the request. Use{" "}
						<code className="bg-gray-100 px-1">pm</code> API.
					</p>
					<ScriptEditor
						value={currentRequest.pre_request_script || ""}
						onChange={(value) => updateRequestField("pre_request_script", value)}
						placeholder="// Pre-request script (JavaScript)&#10;pm.environment.set('timestamp', Date.now());"
					/>
				</div>
			);

		case "test-script":
			return (
				<div className="space-y-3">
					<p className="text-sm text-gray-600">
						Execute JavaScript after receiving the response. Use{" "}
						<code className="bg-gray-100 px-1">pm.test()</code> for assertions.
					</p>
					<ScriptEditor
						value={currentRequest.test_script || ""}
						onChange={(value) => updateRequestField("test_script", value)}
						placeholder="// Test script (JavaScript)&#10;pm.test('Status code is 200', () => {&#10;  pm.response.to.have.status(200);&#10;});"
					/>
				</div>
			);

		default:
			return null;
	}
}

function HeadersEditor() {
	const { currentRequest, updateRequestField } = useRequestBuilderStore();
	const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>(
		[]
	);

	useEffect(() => {
		if (currentRequest?.headers) {
			const headerArray = Object.entries(currentRequest.headers).map(
				([key, value]) => ({
					key,
					value,
				})
			);
			setHeaders(
				headerArray.length > 0 ? headerArray : [{ key: "", value: "" }]
			);
		} else {
			setHeaders([{ key: "", value: "" }]);
		}
	}, [currentRequest?.headers]);

	const handleHeaderChange = (
		index: number,
		field: "key" | "value",
		value: string
	) => {
		const newHeaders = [...headers];
		newHeaders[index][field] = value;
		setHeaders(newHeaders);

		// Convert to object and update
		const headersObj: Record<string, string> = {};
		newHeaders.forEach(({ key, value }) => {
			if (key.trim()) {
				headersObj[key] = value;
			}
		});
		updateRequestField("headers", headersObj);
	};

	const addHeader = () => {
		setHeaders([...headers, { key: "", value: "" }]);
	};

	const removeHeader = (index: number) => {
		const newHeaders = headers.filter((_, i) => i !== index);
		setHeaders(newHeaders.length > 0 ? newHeaders : [{ key: "", value: "" }]);

		const headersObj: Record<string, string> = {};
		newHeaders.forEach(({ key, value }) => {
			if (key.trim()) {
				headersObj[key] = value;
			}
		});
		updateRequestField("headers", headersObj);
	};

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between mb-2">
				<p className="text-sm text-gray-600">Request Headers</p>
				<button
					onClick={addHeader}
					className="px-3 py-1 text-sm bg-primary-600 text-white rounded hover:bg-primary-700"
				>
					Add Header
				</button>
			</div>

			<div className="space-y-2">
				{headers.map((header, index) => (
					<div key={index} className="flex gap-2">
						<input
							type="text"
							value={header.key}
							onChange={(e) => handleHeaderChange(index, "key", e.target.value)}
							placeholder="Header name"
							className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
						/>
						<input
							type="text"
							value={header.value}
							onChange={(e) =>
								handleHeaderChange(index, "value", e.target.value)
							}
							placeholder="Header value"
							className="flex-1 px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
						/>
						<button
							onClick={() => removeHeader(index)}
							className="px-3 py-2 bg-red-100 text-red-600 rounded hover:bg-red-200"
						>
							Remove
						</button>
					</div>
				))}
			</div>
		</div>
	);
}
