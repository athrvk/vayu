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
import { detectCommand, importCommand } from "@/services/curl/parseCurl";
import { useToastStore } from "@/stores";
import { droppedFlagsNotice } from "../../utils/paste-disclosure";
import { useRequestBuilderContext } from "../../context";
import VariableInput from "@/components/shared/VariableInput";
import { useVariableSupport } from "../../hooks/useVariableSupport";
import { parseQueryParams } from "../../utils/url";

interface UrlInputProps {
	className?: string;
}

export default function UrlInput({ className }: UrlInputProps) {
	const { request, updateField, setRequest } = useRequestBuilderContext();
	const variables = useVariableSupport();
	const showToast = useToastStore((s) => s.showToast);

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
			if (!detectCommand(text)) return; // not a command - normal paste

			// A multi-line command must never land in the single-line input.
			e.preventDefault();

			const imported = importCommand(text);
			if (imported) {
				// Request-shape replacement; identity & scripts are preserved.
				setRequest(imported.request);
				// And what it could not carry, said out loud rather than eaten
				// (issue #708). After the import, never instead of it.
				const notice = droppedFlagsNotice(imported.dropped);
				if (notice) showToast(notice);
			}
		},
		[setRequest, showToast]
	);

	return (
		<VariableInput
			value={request.url}
			onChange={handleUrlChange}
			onPaste={handlePaste}
			placeholder="https://api.example.com/endpoint?key={{variable}}"
			// Explicit, because the placeholder here is a sample URL - it would
			// make a poor spoken name, and it is withheld entirely once the URL
			// contains a variable.
			aria-label="Request URL"
			variables={variables}
			className={className ?? "w-full"}
		/>
	);
}
