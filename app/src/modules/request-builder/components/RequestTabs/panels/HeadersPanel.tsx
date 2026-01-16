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

// Standard HTTP headers for autocomplete
const STANDARD_HEADERS = [
	"Accept",
	"Accept-Charset",
	"Accept-Encoding",
	"Accept-Language",
	"Authorization",
	"Cache-Control",
	"Content-Disposition",
	"Content-Encoding",
	"Content-Language",
	"Content-Length",
	"Content-Type",
	"Cookie",
	"Date",
	"ETag",
	"Expires",
	"Host",
	"If-Match",
	"If-Modified-Since",
	"If-None-Match",
	"If-Unmodified-Since",
	"Origin",
	"Pragma",
	"Range",
	"Referer",
	"User-Agent",
	"X-Api-Key",
	"X-Correlation-Id",
	"X-Forwarded-For",
	"X-Forwarded-Host",
	"X-Forwarded-Proto",
	"X-Request-Id",
	"X-Requested-With",
];

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
					<Label htmlFor="bulk-edit">Headers</Label>
					<Textarea
						id="bulk-edit"
						value={bulkEditText}
						onChange={handleBulkEditTextChange}
						placeholder="User-Agent: MyApp/1.0&#10;Authorization: Bearer token&#10;Content-Type: application/json"
						className="font-mono text-sm min-h-[400px]"
					/>
					<p className="text-xs text-muted-foreground">
						Format: <code className="bg-muted px-1 rounded">Header-Name=value</code>{" "}
						(one per line). Duplicate keys will override previous values.
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
