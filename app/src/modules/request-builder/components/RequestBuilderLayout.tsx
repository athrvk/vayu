
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBuilderLayout Component
 *
 * Internal layout component that uses ResizablePanelGroup for the vertical split between
 * request editor (left) and response viewer (right).
 *
 * Also handles keyboard shortcuts (Ctrl+Enter / Cmd+Enter) for sending requests.
 */

import { useEffect } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui";
import { useRequestBuilderContext } from "../context";
import UrlBar from "./UrlBar";
import RequestTabs from "./RequestTabs";
import ResponseViewer from "./ResponseViewer";

export default function RequestBuilderLayout() {
	const { request, isExecuting, executeRequest } = useRequestBuilderContext();

	// Keyboard shortcut handler: Ctrl+Enter (Windows/Linux) or Cmd+Enter (Mac)
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Check for Ctrl+Enter (Windows/Linux) or Cmd+Enter (Mac)
			const isModifierPressed = event.ctrlKey || event.metaKey;
			const isEnterPressed = event.key === "Enter";

			if (isModifierPressed && isEnterPressed) {
				const target = event.target as HTMLElement;

				// Allow shortcut in regular input fields (like URL input)
				// But prevent it in textareas, Monaco editors, and contenteditable elements
				const isTextarea = target.tagName === "TEXTAREA";
				const isContentEditable =
					target.isContentEditable || target.closest('[contenteditable="true"]') !== null;
				// Monaco editor creates elements with class 'monaco-editor'
				const isMonacoEditor = target.closest(".monaco-editor") !== null;

				// Don't trigger if the request is already executing or URL is empty
				const canExecute = !isExecuting && request.url.trim().length > 0;

				// Only prevent if we're in a textarea, Monaco editor, or contenteditable
				// Regular inputs (like URL) should allow the shortcut
				if (canExecute && !isTextarea && !isContentEditable && !isMonacoEditor) {
					event.preventDefault();
					executeRequest();
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);

		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [request.url, isExecuting, executeRequest]);

	return (
		<div className="h-full flex flex-col">
			{/* URL Bar - Always visible at top */}
			<UrlBar />

			{/* Main content area with resizable panels */}
			<ResizablePanelGroup orientation="horizontal" className="flex-1">
				{/* Request Editor Panel */}
				<ResizablePanel defaultSize={50} minSize={30} className="flex flex-col">
					<RequestTabs />
				</ResizablePanel>

				<ResizableHandle withHandle />

				{/* Response Viewer Panel */}
				<ResizablePanel defaultSize={50} minSize={30} className="flex flex-col">
					<ResponseViewer />
				</ResizablePanel>
			</ResizablePanelGroup>
		</div>
	);
}
