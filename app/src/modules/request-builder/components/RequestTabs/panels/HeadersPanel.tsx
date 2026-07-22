/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * HeadersPanel Component
 *
 * Request headers editor with inline bulk edit support
 * Uses useHeadersManager hook for centralized header management
 */

import { useState } from "react";
import { Edit3, Table2 } from "lucide-react";
import { useRequestBuilderContext } from "../../../context";
import KeyValueEditor from "../../../shared/KeyValueEditor";
import type { KeyValueItem } from "../../../types";
import { useHeadersManager } from "../../../hooks/useHeadersManager";
import { Button, Label } from "@/components/ui";
import { Textarea } from "@/components/ui/textarea";
import { STANDARD_HEADERS } from "@/constants/http";

export default function HeadersPanel() {
	const { request, updateField } = useRequestBuilderContext();
	const [isBulkEditMode, setIsBulkEditMode] = useState(false);
	const [bulkEditText, setBulkEditText] = useState("");

	// Use centralized headers manager hook
	const {
		displayHeaders,
		handleHeadersChange,
		handleBulkEdit,
		formatForBulkEdit,
		canEdit,
		canRemove,
		canDisable,
	} = useHeadersManager({
		headers: request.headers,
		onUpdate: (newHeaders: KeyValueItem[]) => updateField("headers", newHeaders),
	});

	// Toggle between table and bulk edit mode
	const handleToggleMode = () => {
		if (isBulkEditMode) {
			// Switching to table mode - save bulk edit
			handleBulkEdit(bulkEditText);
			setIsBulkEditMode(false);
		} else {
			// Switching to bulk edit mode - load current headers
			setBulkEditText(formatForBulkEdit());
			setIsBulkEditMode(true);
		}
	};

	// Handle bulk edit text change
	const handleBulkEditTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		setBulkEditText(e.target.value);
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Add headers to include with your request. Use{" "}
					<code className="bg-muted px-1 rounded-md">{"{{variable}}"}</code> for dynamic
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
					<Label htmlFor="bulk-edit">Headers</Label>
					<Textarea
						id="bulk-edit"
						value={bulkEditText}
						onChange={handleBulkEditTextChange}
						placeholder="User-Agent: MyApp/1.0&#10;Authorization: Bearer token&#10;Content-Type: application/json"
						className="font-mono text-sm min-h-[400px]"
					/>
					{/*
					 * The format shown here now matches the placeholder above it and
					 * the parser below it - all three disagreed. It advertised
					 * `Header-Name=value` while the placeholder demonstrated
					 * `Authorization: Bearer token`, and the parser accepted only the
					 * first, discarding every line written in the second.
					 *
					 * "Duplicate keys will override previous values" was also untrue:
					 * nothing dedupes, so both rows survive and both are sent - which
					 * is what HTTP allows and what a user pasting a real header block
					 * would want.
					 */}
					<p className="text-xs text-muted-foreground">
						Format: <code className="bg-muted px-1 rounded-md">Header-Name: value</code>{" "}
						(one per line). Repeated names are kept as separate headers.
					</p>
				</div>
			) : (
				<KeyValueEditor
					items={displayHeaders}
					onChange={handleHeadersChange}
					keyPlaceholder="Header"
					valuePlaceholder="Value"
					showResolved={true}
					allowDisable={true}
					keySuggestions={STANDARD_HEADERS}
					canEdit={canEdit}
					canRemove={canRemove}
					canDisable={canDisable}
				/>
			)}
		</div>
	);
}
