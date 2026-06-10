/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UrlInput Component
 *
 * URL input field with variable support and query param syncing.
 * Pasting a curl/wget command auto-populates the whole request.
 */

import { useCallback } from "react";
import { detectCommand, parseCommand } from "@/services/curl/parseCurl";
import { useRequestBuilderContext } from "../../context";
import VariableInput from "../../shared/VariableInput";
import { parseQueryParams } from "../../utils/url";

interface UrlInputProps {
	className?: string;
}

export default function UrlInput({ className }: UrlInputProps) {
	const { request, updateField, setRequest } = useRequestBuilderContext();

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

	// Auto-import a pasted curl/wget command into the whole request.
	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLInputElement>) => {
			const text = e.clipboardData.getData("text");
			if (!detectCommand(text)) return; // not a command — normal paste

			// A multi-line command must never land in the single-line input.
			e.preventDefault();

			const parsed = parseCommand(text);
			if (parsed) {
				// Request-shape replacement; identity & scripts are preserved.
				setRequest(parsed);
			}
		},
		[setRequest]
	);

	return (
		<VariableInput
			value={request.url}
			onChange={handleUrlChange}
			onPaste={handlePaste}
			placeholder="https://api.example.com/endpoint?key={{variable}}"
			className={className ?? "w-full"}
		/>
	);
}
