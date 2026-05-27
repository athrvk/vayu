/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * BodyPanel Component
 *
 * Request body editor with multiple modes:
 * - none: No body
 * - json: Monaco editor with JSON syntax
 * - text: Plain text editor
 * - graphql: Split editor — query (top) + variables JSON (bottom)
 * - form-data: Key-value editor
 * - x-www-form-urlencoded: Key-value editor
 */

import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Button,
	CodeEditor,
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "../../../shared/KeyValueEditor";
import type { BodyMode, KeyValueItem } from "../../../types";
import { createEmptyKeyValue } from "../../../utils/key-value";
import { generateUUID } from "../../../utils/id";
import { useSchemaCache } from "@/lib/graphql/schema-cache";
import { useResizable } from "@/hooks/useResizable";
import { cn } from "@/lib/utils";

const BODY_MODES: { value: BodyMode; label: string; description: string }[] = [
	{ value: "none", label: "None", description: "No request body" },
	{ value: "json", label: "JSON", description: "application/json" },
	{ value: "text", label: "Text", description: "text/plain" },
	{ value: "graphql", label: "GraphQL", description: "application/json" },
	{ value: "form-data", label: "Form Data", description: "multipart/form-data" },
	{
		value: "x-www-form-urlencoded",
		label: "URL Encoded",
		description: "application/x-www-form-urlencoded",
	},
];

function parseGraphQLBody(body: string): { query: string; variables: string } {
	try {
		const parsed = JSON.parse(body);
		if (parsed && typeof parsed.query === "string") {
			return {
				query: parsed.query,
				variables: parsed.variables ? JSON.stringify(parsed.variables, null, 2) : "",
			};
		}
	} catch {
		// Body is not JSON — treat as a raw query string (e.g. Insomnia import)
	}
	// Raw query string — show as-is, no variables
	return { query: body, variables: "" };
}

function serializeGraphQLBody(query: string, variables: string): string {
	try {
		const vars = variables.trim() ? JSON.parse(variables) : undefined;
		return JSON.stringify({ query, ...(vars !== undefined && { variables: vars }) });
	} catch {
		// Variables panel has in-progress invalid JSON — preserve query only
		return JSON.stringify({ query });
	}
}

function SchemaStatusBadge({ status }: { status: "idle" | "loading" | "ready" | "error" }) {
	if (status === "idle") return null;
	if (status === "loading") {
		return (
			<span className="flex items-center gap-1 text-[10px] text-muted-foreground">
				<Loader2 className="w-3 h-3 animate-spin" />
				Schema
			</span>
		);
	}
	if (status === "ready") {
		return (
			<span className="flex items-center gap-1 text-[10px] text-success">
				<CheckCircle2 className="w-3 h-3" />
				Schema
			</span>
		);
	}
	return (
		<span
			className="flex items-center gap-1 text-[10px] text-destructive"
			title="Schema introspection failed — syntax checking only"
		>
			<AlertCircle className="w-3 h-3" />
			No schema
		</span>
	);
}

function ResizeHandle({
	onMouseDown,
	active,
}: {
	onMouseDown: (e: React.MouseEvent) => void;
	active: boolean;
}) {
	return (
		<div
			role="separator"
			aria-orientation="horizontal"
			onMouseDown={onMouseDown}
			className={cn(
				"h-1.5 cursor-row-resize bg-border hover:bg-primary transition-colors",
				active && "bg-primary"
			)}
		/>
	);
}

export default function BodyPanel() {
	const { request, updateField, resolveString } = useRequestBuilderContext();
	const [showPreview, setShowPreview] = useState(false);

	const schemaStatus = useSchemaCache((s) =>
		s.activeUrl ? (s.byUrl[s.activeUrl]?.status ?? "idle") : "idle"
	);

	// Drag-to-resize editor height, shared across body modes that host an editor.
	const {
		size: editorHeight,
		isResizing,
		startResizing,
	} = useResizable({ defaultSize: 320, min: 160, max: 800, direction: "vertical" });

	const resolvedGqlUrl = resolveString(request.url || "").trim();
	const buildResolvedHeaders = (): Record<string, string> => {
		const headers: Record<string, string> = {};
		for (const h of request.headers) {
			if (h.enabled && h.key) headers[resolveString(h.key)] = resolveString(h.value);
		}
		return headers;
	};

	// In GraphQL mode, track the resolved endpoint as the active schema URL and
	// (debounced) introspect it so the editor's language providers can validate
	// and autocomplete against the schema.
	useEffect(() => {
		if (request.bodyMode !== "graphql") {
			useSchemaCache.getState().setActiveUrl(null);
			return;
		}
		useSchemaCache.getState().setActiveUrl(resolvedGqlUrl || null);
		if (!resolvedGqlUrl) return;
		const headers = buildResolvedHeaders();
		const id = setTimeout(() => {
			void useSchemaCache.getState().ensureSchema(resolvedGqlUrl, headers);
		}, 400);
		return () => clearTimeout(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [request.bodyMode, request.url, request.headers, resolveString]);

	const handleRefreshSchema = () => {
		if (!resolvedGqlUrl) return;
		void useSchemaCache.getState().refreshSchema(resolvedGqlUrl, buildResolvedHeaders());
	};

	const handleModeChange = (mode: BodyMode) => {
		updateField("bodyMode", mode);

		// Initialize appropriate data for mode
		if (mode === "form-data" && request.formData.length === 0) {
			updateField("formData", [createEmptyKeyValue()]);
		}
		if (mode === "x-www-form-urlencoded" && request.urlEncoded.length === 0) {
			updateField("urlEncoded", [createEmptyKeyValue()]);
		}

		// Auto-inject Content-Type: application/json for GraphQL if not already present
		if (mode === "graphql") {
			const hasContentType = request.headers.some(
				(h) => h.key.toLowerCase() === "content-type" && h.enabled
			);
			if (!hasContentType) {
				updateField("headers", [
					...request.headers,
					{
						id: generateUUID(),
						key: "Content-Type",
						value: "application/json",
						enabled: true,
					},
				]);
			}
		}
	};

	const handleRawChange = (value: string) => {
		updateField("body", value);
	};

	const handleFormDataChange = (items: KeyValueItem[]) => {
		updateField("formData", items);
	};

	const handleUrlEncodedChange = (items: KeyValueItem[]) => {
		updateField("urlEncoded", items);
	};

	// Check for variables in body
	const hasVariables = request.body ? /\{\{[^{}]+\}\}/.test(request.body) : false;
	const resolvedBody = request.body ? resolveString(request.body) : "";

	// Parse GraphQL body once at render time so handlers close over stable values
	const { query: gqlQuery, variables: gqlVariables } =
		request.bodyMode === "graphql"
			? parseGraphQLBody(request.body || "")
			: { query: "", variables: "" };

	return (
		<div className="space-y-4">
			{/* Mode Selector */}
			<div className="flex items-center justify-between">
				<Select value={request.bodyMode} onValueChange={handleModeChange}>
					<SelectTrigger className="w-auto">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{BODY_MODES.map((mode) => (
							<SelectItem key={mode.value} value={mode.value}>
								<div className="flex justify-start items-center gap-2">
									<span>{mode.label}</span>
									<span className="text-xs text-muted-foreground">
										({mode.description})
									</span>
								</div>
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				{hasVariables && request.bodyMode !== "none" && request.bodyMode !== "graphql" && (
					<Button
						size="sm"
						variant={showPreview ? "secondary" : "outline"}
						onClick={() => setShowPreview(!showPreview)}
					>
						{showPreview ? "Hide" : "Show"} Preview
					</Button>
				)}
			</div>

			{/* Body Content */}
			{request.bodyMode === "none" && (
				<div className="py-12 text-center text-muted-foreground">
					<p>This request does not have a body.</p>
				</div>
			)}

			{(request.bodyMode === "json" || request.bodyMode === "text") && (
				<div>
					<div className={showPreview ? "grid grid-cols-2 gap-4" : ""}>
						<div className="space-y-2">
							{showPreview && (
								<label className="text-xs font-medium text-muted-foreground">
									Source
								</label>
							)}
							<div
								className="border border-input overflow-hidden"
								style={{ height: editorHeight }}
							>
								<CodeEditor
									height="100%"
									language={request.bodyMode === "json" ? "json" : "plaintext"}
									value={request.body || ""}
									onChange={handleRawChange}
								/>
							</div>
						</div>

						{showPreview && (
							<div className="space-y-2">
								<label className="text-xs font-medium text-muted-foreground">
									Resolved Preview
								</label>
								<pre
									className="p-3 border border-input font-mono text-sm bg-muted/50 overflow-auto whitespace-pre-wrap"
									style={{ height: editorHeight }}
								>
									{resolvedBody || (
										<span className="text-muted-foreground italic">
											Empty body
										</span>
									)}
								</pre>
							</div>
						)}
					</div>
					<ResizeHandle onMouseDown={startResizing} active={isResizing} />
				</div>
			)}

			{request.bodyMode === "graphql" && (
				<div>
					<div
						className="border border-input overflow-hidden"
						style={{ height: editorHeight }}
					>
						<ResizablePanelGroup orientation="vertical" className="h-full">
							<ResizablePanel defaultSize={65} minSize={25} className="flex flex-col">
								<div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-panel shrink-0">
									<span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
										Query
									</span>
									<div className="flex items-center gap-2">
										<SchemaStatusBadge status={schemaStatus} />
										{resolvedGqlUrl && (
											<button
												type="button"
												onClick={handleRefreshSchema}
												disabled={schemaStatus === "loading"}
												title="Refresh schema"
												className="text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
											>
												<RefreshCw
													className={cn(
														"w-3 h-3",
														schemaStatus === "loading" && "animate-spin"
													)}
												/>
											</button>
										)}
									</div>
								</div>
								<div className="flex-1">
									<CodeEditor
										height="100%"
										language="graphql"
										value={gqlQuery}
										onChange={(q) =>
											handleRawChange(serializeGraphQLBody(q, gqlVariables))
										}
									/>
								</div>
							</ResizablePanel>
							<ResizableHandle />
							<ResizablePanel defaultSize={35} minSize={15} className="flex flex-col">
								<div className="px-3 py-1.5 border-b border-border bg-panel shrink-0">
									<span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
										Variables
									</span>
								</div>
								<div className="flex-1">
									<CodeEditor
										height="100%"
										language="json"
										value={gqlVariables}
										onChange={(v) =>
											handleRawChange(serializeGraphQLBody(gqlQuery, v))
										}
									/>
								</div>
							</ResizablePanel>
						</ResizablePanelGroup>
					</div>
					<ResizeHandle onMouseDown={startResizing} active={isResizing} />
				</div>
			)}

			{request.bodyMode === "form-data" && (
				<div className="space-y-2">
					<KeyValueEditor
						items={
							request.formData.length > 0 ? request.formData : [createEmptyKeyValue()]
						}
						onChange={handleFormDataChange}
						keyPlaceholder="Key"
						valuePlaceholder="Value"
						showResolved={true}
						allowDisable={true}
					/>
				</div>
			)}

			{request.bodyMode === "x-www-form-urlencoded" && (
				<KeyValueEditor
					items={
						request.urlEncoded.length > 0 ? request.urlEncoded : [createEmptyKeyValue()]
					}
					onChange={handleUrlEncodedChange}
					keyPlaceholder="Key"
					valuePlaceholder="Value"
					showResolved={true}
					allowDisable={true}
				/>
			)}
		</div>
	);
}
