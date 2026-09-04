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

import { useCallback, useEffect } from "react";
import { detectCommand, importCommand } from "@/services/curl/parseCurl";
import { useToastStore } from "@/stores";
import { droppedFlagsNotice } from "../../utils/paste-disclosure";
import { useRequestBuilderContext } from "../../context";
import VariableInput from "@/components/shared/VariableInput";
import { REQUEST_URL_INPUT_ID } from "@/constants/dom-ids";
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

	/** Replace the request with what a curl/wget command describes. */
	const importIntoRequest = useCallback(
		(text: string) => {
			const imported = importCommand(text);
			if (!imported) return;
			// Request-shape replacement; identity & scripts are preserved.
			setRequest(imported.request);
			// And what it could not carry, said out loud rather than eaten
			// (issue #708). After the import, never instead of it.
			const notice = droppedFlagsNotice(imported.dropped);
			if (notice) showToast(notice);
		},
		[setRequest, showToast]
	);

	// Auto-import a pasted curl/wget command into the whole request.
	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLInputElement>) => {
			const text = e.clipboardData.getData("text");
			if (!detectCommand(text)) return; // not a command - normal paste

			// A multi-line command must never land in the single-line input.
			e.preventDefault();

			importIntoRequest(text);
		},
		[importIntoRequest]
	);

	/*
	 * The same import, asked for by the right-click menu's "Paste as curl"
	 * (#1359). The menu is composed in the main process, which reads the
	 * clipboard and offers the item only for text this would accept, then hands
	 * that text back here: the offer exists to make the paste behaviour above
	 * discoverable, so it must be the same import and not a second one.
	 */
	useEffect(() => {
		return window.electronAPI?.onContextMenuCommand?.((command) => {
			if (command.type !== "import-command") return; // the token popover is not ours
			importIntoRequest(command.text);
		});
	}, [importIntoRequest]);

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
			// So ⌘L can find it from the Shell, which is outside this subtree.
			id={REQUEST_URL_INPUT_ID}
			// The one field whose right-click menu offers to import a command from
			// the clipboard, because it is the one that imports a pasted one.
			contextKind="url-bar"
			variables={variables}
			className={className ?? "w-full"}
		/>
	);
}
