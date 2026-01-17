
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UrlInput Component
 *
 * URL input field with variable support and query param syncing
 */

import { useCallback } from "react";
import { useRequestBuilderContext } from "../../context";
import VariableInput from "../../shared/VariableInput";
import { generateId } from "../../utils/id";
import type { KeyValueItem } from "../../types";

// Parse URL to extract query params
function parseQueryParams(url: string): KeyValueItem[] {
	try {
		const queryStart = url.indexOf("?");
		if (queryStart === -1) return [];

		const queryString = url.slice(queryStart + 1);
		if (!queryString) return [];

		const pairs = queryString.split("&").filter(Boolean);

		return pairs.map((pair) => {
			const [key, ...valueParts] = pair.split("=");
			const value = valueParts.join("=");
			return {
				id: generateId(),
				key: decodeURIComponent(key || ""),
				value: decodeURIComponent(value || ""),
				enabled: true,
			};
		});
	} catch {
		return [];
	}
}

export default function UrlInput() {
	const { request, updateField } = useRequestBuilderContext();

	// Sync params from URL when URL changes directly
	const handleUrlChange = useCallback(
		(newUrl: string) => {
			// Trim leading/trailing whitespace to prevent malformed URL errors
			const trimmedUrl = newUrl.trim();
			updateField("url", trimmedUrl);

			// Extract and sync params
			const newParams = parseQueryParams(trimmedUrl);
			if (newParams.length > 0) {
				updateField("params", newParams);
			}
		},
		[updateField]
	);

	return (
		<div className="flex-1">
			<VariableInput
				value={request.url}
				onChange={handleUrlChange}
				placeholder="https://api.example.com/endpoint?key={{variable}}"
				className="w-full"
			/>
		</div>
	);
}
