
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ParamsPanel Component
 *
 * Query parameters editor with URL sync and bulk edit support
 */

import { useState, useCallback } from "react";
import { Edit3, Table2 } from "lucide-react";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "../../../shared/KeyValueEditor";
import type { KeyValueItem } from "../../../types";
import { formatParamsToText, parseParamsFromText } from "../../../utils/params-format";
import { Button, Label } from "@/components/ui";
import { Textarea } from "@/components/ui/textarea";

// Build URL from base and params
// Note: We don't URL-encode values containing {{variables}} - they get resolved and encoded at request time
function buildUrlWithParams(baseUrl: string, params: KeyValueItem[]): string {
	const queryStart = baseUrl.indexOf("?");
	const base = queryStart === -1 ? baseUrl : baseUrl.slice(0, queryStart);

	const enabledParams = params.filter((p) => p.enabled && p.key.trim());
	if (enabledParams.length === 0) return base;

	const queryString = enabledParams
		.map((p) => {
			// Don't encode if contains variable placeholder - will be resolved later
			const hasVarInKey = /\{\{[^{}]+\}\}/.test(p.key);
			const hasVarInValue = /\{\{[^{}]+\}\}/.test(p.value);
			const key = hasVarInKey ? p.key : encodeURIComponent(p.key);
			const value = hasVarInValue ? p.value : encodeURIComponent(p.value);
			return p.value ? `${key}=${value}` : key;
		})
		.join("&");

	return `${base}?${queryString}`;
}

export default function ParamsPanel() {
	const { request, updateField, resolveString } = useRequestBuilderContext();
	const [isBulkEditMode, setIsBulkEditMode] = useState(false);
	const [bulkEditText, setBulkEditText] = useState("");

	// Handle params change and sync to URL
	const handleParamsChange = useCallback(
		(newParams: KeyValueItem[]) => {
			// Filter out any system headers that shouldn't be in params (separation of concerns)
			const filteredParams = newParams.filter((param) => !param.system);

			updateField("params", filteredParams);

			// Sync to URL
			const newUrl = buildUrlWithParams(request.url, filteredParams);
			updateField("url", newUrl);
		},
		[request.url, updateField]
	);

	// Handle bulk edit text
	const handleBulkEdit = useCallback(
		(text: string) => {
			const parsedParams = parseParamsFromText(text);
			handleParamsChange(parsedParams);
		},
		[handleParamsChange]
	);

	// Format params for bulk edit display
	const formatForBulkEdit = useCallback(() => {
		return formatParamsToText(request.params);
	}, [request.params]);

	// Toggle between table and bulk edit mode
	const handleToggleMode = () => {
		if (isBulkEditMode) {
			// Switching to table mode - save bulk edit
			handleBulkEdit(bulkEditText);
			setIsBulkEditMode(false);
		} else {
			// Switching to bulk edit mode - load current params
			setBulkEditText(formatForBulkEdit());
			setIsBulkEditMode(true);
		}
	};

	// Handle bulk edit text change
	const handleBulkEditTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setBulkEditText(e.target.value);
	};

	const resolvedUrl = resolveString(request.url);
	const displayParams = request.params.filter((param) => !param.system);

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Add query parameters to include with your request. Use{" "}
					<code className="bg-muted px-1 rounded">{"{{variable}}"}</code> for dynamic
					values.
				</p>
				<Button variant="outline" size="sm" onClick={handleToggleMode} className="shrink-0">
					{isBulkEditMode ? (
						<>
							<Table2 className="w-4 h-4 mr-1" />
							Table View
						</>
					) : (
						<>
							<Edit3 className="w-4 h-4 mr-1" />
							Bulk Edit
						</>
					)}
				</Button>
			</div>

			{isBulkEditMode ? (
				<div className="space-y-2">
					<Label htmlFor="bulk-edit">Query Parameters</Label>
					<Textarea
						id="bulk-edit"
						value={bulkEditText}
						onChange={handleBulkEditTextChange}
						placeholder="page=1&#10;limit=10&#10;sort=name"
						className="font-mono text-sm min-h-[400px]"
					/>
					<p className="text-xs text-muted-foreground">
						Format: <code className="bg-muted px-1 rounded">key=value</code> (one per
						line). Duplicate keys will override previous values.
					</p>
				</div>
			) : (
				<>
					{/* Query Parameters Editor */}
					<div className="space-y-2">
						<KeyValueEditor
							items={displayParams}
							onChange={handleParamsChange}
							keyPlaceholder="Parameter"
							valuePlaceholder="Value"
							showResolved={true}
							allowDisable={true}
						/>
					</div>

					{/* Full Resolved URL */}
					<div className="space-y-2">
						<label className="text-sm font-medium text-muted-foreground">
							Full Resolved URL
						</label>
						<div className="p-3 bg-muted rounded-md font-mono text-sm break-all">
							{resolvedUrl || (
								<span className="text-muted-foreground italic">No URL</span>
							)}
						</div>
					</div>
				</>
			)}
		</div>
	);
}
