
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
 * - form-data: Key-value editor (TODO: file upload)
 * - x-www-form-urlencoded: Key-value editor
 */

import { useState } from "react";
import Editor from "@monaco-editor/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Button,
	Badge,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "../../../shared/KeyValueEditor";
import type { BodyMode, KeyValueItem } from "../../../types";
import { createEmptyKeyValue } from "../../../utils/key-value";

const BODY_MODES: { value: BodyMode; label: string; description: string }[] = [
	{ value: "none", label: "None", description: "No request body" },
	{ value: "json", label: "JSON", description: "application/json" },
	{ value: "text", label: "Text", description: "text/plain" },
	{ value: "form-data", label: "Form Data", description: "multipart/form-data" },
	{
		value: "x-www-form-urlencoded",
		label: "URL Encoded",
		description: "application/x-www-form-urlencoded",
	},
];

export default function BodyPanel() {
	const { request, updateField, resolveString } = useRequestBuilderContext();
	const [showPreview, setShowPreview] = useState(false);

	const handleModeChange = (mode: BodyMode) => {
		updateField("bodyMode", mode);

		// Initialize appropriate data for mode
		if (mode === "form-data" && request.formData.length === 0) {
			updateField("formData", [createEmptyKeyValue()]);
		}
		if (mode === "x-www-form-urlencoded" && request.urlEncoded.length === 0) {
			updateField("urlEncoded", [createEmptyKeyValue()]);
		}
	};

	const handleRawChange = (value: string | undefined) => {
		updateField("body", value || "");
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

	return (
		<div className="space-y-4">
			{/* Mode Selector */}
			<div className="flex items-center justify-between">
				<Select value={request.bodyMode} onValueChange={handleModeChange}>
					<SelectTrigger className="w-48">
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

				{hasVariables && request.bodyMode !== "none" && (
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
				<div className={showPreview ? "grid grid-cols-2 gap-4" : ""}>
					<div className="space-y-2">
						{showPreview && (
							<label className="text-xs font-medium text-muted-foreground">
								Source
							</label>
						)}
						<div className="border border-input overflow-hidden">
							<Editor
								height="320px"
								language={request.bodyMode === "json" ? "json" : "plaintext"}
								value={request.body || ""}
								onChange={handleRawChange}
								theme="vs-dark"
								options={{
									minimap: { enabled: false },
									fontSize: 13,
									lineNumbers: "on",
									scrollBeyondLastLine: false,
									wordWrap: "on",
									tabSize: 2,
									automaticLayout: true,
								}}
							/>
						</div>
					</div>

					{showPreview && (
						<div className="space-y-2">
							<label className="text-xs font-medium text-muted-foreground">
								Resolved Preview
							</label>
							<pre className="h-[320px] p-3 border border-input font-mono text-sm bg-muted/50 overflow-auto whitespace-pre-wrap">
								{resolvedBody || (
									<span className="text-muted-foreground italic">Empty body</span>
								)}
							</pre>
						</div>
					)}
				</div>
			)}

			{request.bodyMode === "form-data" && (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<Badge variant="outline" className="text-xs">
							TODO: File upload support
						</Badge>
					</div>
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
