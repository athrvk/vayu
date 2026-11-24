/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The URL field, variable-aware and synced to the query params; a pasted curl/wget command fills
 * the whole request.
 */

import { useCallback, useEffect } from "react";
import { detectCommand, readCommand } from "@/services/curl/parseCurl";
import { useTabsStore, useToastStore } from "@/stores";
import { focusRequestUrl } from "@/components/layout/region-focus";
import { pasteNotices, unreadableCommandNotice } from "../../utils/paste-disclosure";
import { useRequestBuilderContext } from "../../context";
import VariableInput from "@/components/shared/VariableInput";
import { REQUEST_URL_INPUT_ID } from "@/constants/dom-ids";
import { useVariableSupport } from "../../hooks/useVariableSupport";
import { joinWrappedLines, mergeParamsFromUrl } from "../../utils/url";

/**
 * Types `text` over the selection as a user would, through the browser's `input` event, so it
 * reaches `onChange` and the caret lands after it as for a native paste; setting `value` would move
 * the caret to the end.
 */
function insertAtSelection(input: HTMLInputElement, text: string): void {
	const start = input.selectionStart ?? input.value.length;
	const end = input.selectionEnd ?? start;
	input.setRangeText(text, start, end, "end");
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

interface UrlInputProps {
	className?: string;
}

export default function UrlInput({ className }: UrlInputProps) {
	const { request, updateField, setRequest } = useRequestBuilderContext();
	const variables = useVariableSupport();
	const showToast = useToastStore((s) => s.showToast);

	const handleUrlChange = useCallback(
		(newUrl: string) => {
			// Trimmed, so stray whitespace does not make a malformed URL.
			const trimmedUrl = newUrl.trim();
			updateField("url", trimmedUrl);

			// Merge, never replace: a disabled row is invisible in the URL and must survive an
			// edit, and clearing the query must clear the enabled rows it carried (#1482). Rows
			// keep the query as written (#1771).
			updateField("params", mergeParamsFromUrl(request.params, trimmedUrl, request.url));
		},
		[request.params, request.url, updateField]
	);

	// The field mounts after the tab opens, so a new blank request's ask for the caret is a nav
	// intent, answered once mounted (#3400).
	const focusRequested = useTabsStore(
		(s) => s.navIntent?.kind === "focusUrl" && s.navIntent.target === request.id
	);
	const takeNavIntent = useTabsStore((s) => s.takeNavIntent);
	useEffect(() => {
		if (!focusRequested || !request.id) return;
		if (takeNavIntent("focusUrl", request.id)) focusRequestUrl();
	}, [focusRequested, request.id, takeNavIntent]);

	/**
	 * Replaces the request with what a curl/wget command describes. An unreadable command leaves
	 * the request alone and says why (#3685): the paste's default is already prevented, so silence
	 * would be a vanished paste.
	 */
	const importIntoRequest = useCallback(
		(text: string) => {
			const reading = readCommand(text);
			if (!reading.ok) {
				showToast(unreadableCommandNotice(reading.reason));
				return;
			}
			const imported = reading.command;
			// The request's shape is replaced; identity and scripts are kept.
			setRequest(imported.request);
			// What it could not carry, said rather than eaten (#708), with the shell variables it
			// turned into `{{NAME}}` (#3777). After the import, never instead of it.
			for (const notice of pasteNotices(imported)) showToast(notice);
		},
		[setRequest, showToast]
	);

	/*
	 * A pasted curl/wget command replaces the request. Other text with a line break is a wrapped
	 * URL: Chromium would turn each break into a space and send the wrong request, so it is joined
	 * (#3688).
	 */
	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLInputElement>) => {
			const text = e.clipboardData.getData("text");
			if (detectCommand(text)) {
				// A multi-line command must never land in the single-line input.
				e.preventDefault();
				importIntoRequest(text);
				return;
			}
			if (!/[\r\n]/.test(text)) return; // one line - normal paste

			e.preventDefault();
			insertAtSelection(e.currentTarget, joinWrappedLines(text));
		},
		[importIntoRequest]
	);

	/*
	 * The same import from the right-click "Paste as curl" (#1359). Main composes the menu, reads
	 * the clipboard, offers the item only for text this accepts and hands it back: the item exists
	 * to make the paste behaviour discoverable, so it must be the same import, not a second.
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
			placeholder="Paste a URL or a cURL command"
			// Explicit: the placeholder is an instruction, not the name, and is withheld once the
			// URL has a variable.
			aria-label="Request URL"
			// So ⌘L can find it from the Shell, which is outside this subtree.
			id={REQUEST_URL_INPUT_ID}
			// The one field whose right-click offers a clipboard command import, as it imports a
			// pasted one.
			contextKind="url-bar"
			variables={variables}
			className={className ?? "w-full"}
		/>
	);
}
