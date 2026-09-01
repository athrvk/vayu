/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseBody Component
 *
 * Displays HTTP response body with multiple view modes:
 * - Pretty: Formatted/syntax highlighted view (default)
 * - Raw: Unformatted text view
 * - Preview: HTML/image rendering (when applicable)
 *
 * Similar to Postman's response body viewer.
 *
 * Past `LARGE_BODY_BYTES` it drops to one mode: no `formatBody`, no syntax
 * highlighting, and a prefix of the raw body in the editor, with a notice
 * saying so. Everything this component does to a body it does synchronously
 * during render, so a multi-megabyte response used to freeze the window between
 * Send and the pane painting. See the constant in `utils.ts` for the three
 * passes and why 2MB.
 */

import { useState, useMemo, type ReactNode } from "react";
import { FileCode, Image as ImageIcon, File, Eye, Code, FileText } from "lucide-react";
import { CodeEditor, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import { cn } from "@/lib/utils";
import { Callout } from "../Callout";
import {
	detectBodyType,
	getMonacoLanguage,
	formatBody,
	formatSize,
	LARGE_BODY_BYTES,
} from "./utils";
import type { ResponseBodyProps, ViewMode } from "./types";

interface ExtendedResponseBodyProps extends ResponseBodyProps {
	/** Default view mode */
	defaultMode?: ViewMode;
	/** Height for the editor (use "100%" for flex containers) */
	height?: string;
	/** Show view mode toggle buttons */
	showModeToggle?: boolean;
	/**
	 * Rendered at the end of the toolbar - copy and download, in the request
	 * builder. A slot rather than a hardcoded `ResponseActions` because the
	 * history viewer mounts this same component with nothing to put there.
	 */
	actions?: ReactNode;
	/** Compact mode for smaller displays */
	compact?: boolean;
}

export default function ResponseBody({
	body,
	bodyRaw,
	headers,
	className,
	defaultMode = "pretty",
	height = "100%",
	showModeToggle = true,
	actions,
	compact = false,
}: ExtendedResponseBodyProps) {
	const [viewMode, setViewMode] = useState<ViewMode>(defaultMode);

	/*
	 * Past `LARGE_BODY_BYTES` the pane stops formatting and shows a raw prefix.
	 * Whichever of the two strings is bigger decides, because either can end up
	 * in the editor - `body` in Pretty, `bodyRaw` in Raw - and the cost is the
	 * one that gets rendered, not the one that was passed first.
	 */
	const bodyLength = Math.max(body.length, bodyRaw?.length ?? 0);
	const isLargeBody = bodyLength > LARGE_BODY_BYTES;

	/*
	 * Detect body type from content and headers.
	 *
	 * Above the gate the *content* half is skipped, because it is itself a pass
	 * over the whole string: with no content-type header - or a generic
	 * `text/plain` one - `detectBodyType` trims the body, `JSON.parse`s it and
	 * lower-cases it looking for markup, which for a 32MB body is the freeze
	 * this threshold exists to prevent, paid before the gate below is even
	 * reached. The header still decides where there is one; an unlabelled large
	 * body reads as text, which is what the pane renders it as either way.
	 */
	const detectedType = useMemo(
		() => detectBodyType(headers, isLargeBody ? "" : bodyRaw || body),
		[headers, bodyRaw, body, isLargeBody]
	);

	// Check if preview is available
	const canPreview = detectedType === "html" || detectedType === "image";

	// Format body for display
	// Raw mode: use bodyRaw (original raw bytes from server) if available, fallback to body
	// Pretty mode: use formatted body
	const formattedBody = useMemo(() => {
		// The gate, and the reason the toggle is hidden with it: there is one
		// view left, so `formatBody`'s parse-and-reindent pass never runs and the
		// editor is handed a bounded prefix rather than a model it will spend
		// seconds tokenising.
		if (isLargeBody) return (bodyRaw || body).slice(0, LARGE_BODY_BYTES);
		if (viewMode === "raw") {
			// Use bodyRaw for raw view to show actual server response
			return bodyRaw || body;
		}
		return formatBody(body, detectedType);
	}, [body, bodyRaw, detectedType, viewMode, isLargeBody]);

	// Get Monaco language
	const language = useMemo(() => getMonacoLanguage(detectedType), [detectedType]);

	// Prepare HTML for preview with disabled links and base styles
	// Use bodyRaw for preview to show actual server response
	const previewHtml = useMemo(() => {
		const htmlContent = bodyRaw || body;
		if (detectedType !== "html") return htmlContent;
		// Unreachable above the gate - the toggle that selects Preview is hidden -
		// and the injection below is another whole-string scan and copy.
		if (isLargeBody) return htmlContent;

		// Inject script to disable link navigation and add base styling
		const disableLinkScript = `
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    // Add tooltip to all links
                    document.querySelectorAll('a').forEach(function(link) {
                        link.setAttribute('title', 'Links are disabled in preview mode for security');
                    });
                });
                document.addEventListener('click', function(e) {
                    if (e.target.tagName === 'A' || e.target.closest('a')) {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }, true);
            </script>
            <style>
                a { cursor: not-allowed !important; }
                a:hover { text-decoration: none !important; opacity: 0.7; }
            </style>
        `;

		// Insert before </head> or </body> or at the end
		if (htmlContent.includes("</head>")) {
			return htmlContent.replace("</head>", disableLinkScript + "</head>");
		} else if (htmlContent.includes("</body>")) {
			return htmlContent.replace("</body>", disableLinkScript + "</body>");
		} else {
			return htmlContent + disableLinkScript;
		}
	}, [body, bodyRaw, detectedType, isLargeBody]);

	// Handle image types - use bodyRaw for actual image data
	if (detectedType === "image") {
		const contentType = headers["content-type"] || headers["Content-Type"] || "image/png";
		const imageData = bodyRaw || body;
		return (
			<div
				className={cn(
					"flex-1 flex items-center justify-center p-4 surface-sunken",
					className
				)}
			>
				<div className="text-center space-y-4">
					<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-rule text-sm text-muted-foreground">
						<ImageIcon className="w-4 h-4" />
						<span>
							Image Response ({contentType.split("/")[1]?.toUpperCase() || "IMAGE"})
						</span>
					</div>
					<div className="max-w-full max-h-[400px] overflow-auto">
						<img
							src={`data:${contentType};base64,${imageData}`}
							alt="Response"
							className="max-w-full h-auto border border-rule"
						/>
					</div>
				</div>
			</div>
		);
	}

	// Handle PDF
	if (detectedType === "pdf") {
		return (
			<div
				className={cn(
					"flex-1 flex items-center justify-center p-4 surface-sunken",
					className
				)}
			>
				<div className="text-center space-y-4">
					<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-rule text-sm text-muted-foreground">
						<File className="w-4 h-4" />
						<span>PDF Document</span>
					</div>
					<p className="text-sm text-muted-foreground">
						PDF preview is not available. Download to view.
					</p>
				</div>
			</div>
		);
	}

	// Handle binary
	if (detectedType === "binary") {
		return (
			<div
				className={cn(
					"flex-1 flex items-center justify-center p-4 surface-sunken",
					className
				)}
			>
				<div className="text-center space-y-4">
					<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-rule text-sm text-muted-foreground">
						<FileCode className="w-4 h-4" />
						<span>Binary Data</span>
					</div>
					<p className="text-sm text-muted-foreground">
						Binary content cannot be displayed. Download to view.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className={cn("flex-1 flex flex-col h-full", className)}>
			{/*
			 * The toolbar sits on a 32px band.
			 *
			 * It was `px-4 py-2` around `h-7` segments - 44px, against a 24px tab
			 * strip directly above it. `ResponseActions` carries a comment saying
			 * its icons are `h-6` precisely so they share that 24px row; this
			 * toolbar never got the same treatment and ran 83% taller than the
			 * band it hangs under. `h-8` with no vertical padding is the same
			 * construction the tab row uses, one step up so the hierarchy still
			 * reads.
			 *
			 * **No background of its own**, which is the second thing that was
			 * wrong here and the harder one to see. It was `bg-muted/20`; the fix
			 * for that was `surface-sunken`, and that over-corrected - a full
			 * `--muted` fill turns this row into a heavy grey band between a
			 * card-coloured tab strip and a card-coloured editor, reading as a
			 * separate block wedged between them rather than part of the pane.
			 *
			 * The rule problem `surface-sunken` was solving does not need a fill to
			 * solve. This row sits inside the pane, which declares `surface-card`,
			 * so `border-b border-rule` already resolves against a card - exactly
			 * how the tab strip above gets its edge, with no background either.
			 * The band is defined by its rule and its height, not by a colour.
			 */}
			<div className="flex h-8 items-center justify-between gap-2 px-4 border-b border-rule">
				<div className="flex items-center gap-2">
					{/* 14px, matching the tab row's `w-3.5` icons. It was 16px. */}
					<FileCode className="w-3.5 h-3.5 text-muted-foreground" />
					<span className="text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
						{detectedType}
					</span>
				</div>

				<div className="flex items-center gap-2">
					{showModeToggle && !isLargeBody && (
						<ToggleGroup
							value={viewMode}
							// Radix clears the value when the active item is pressed again.
							// A view mode has no "off" - ignore the empty string rather than
							// letting the body render nothing.
							onValueChange={(next) => next && setViewMode(next as ViewMode)}
							size={compact ? "xs" : "sm"}
							aria-label="Body view mode"
						>
							<ToggleGroupItem value="pretty">
								<Code className="w-3 h-3" />
								Pretty
							</ToggleGroupItem>
							<ToggleGroupItem value="raw">
								<FileText className="w-3 h-3" />
								Raw
							</ToggleGroupItem>
							{canPreview && (
								<ToggleGroupItem value="preview">
									<Eye className="w-3 h-3" />
									Preview
								</ToggleGroupItem>
							)}
						</ToggleGroup>
					)}
					{actions}
				</div>
			</div>

			{/*
			 * Said here rather than in either viewer, because this is the
			 * component that made the decision: it is the pane's own limit, not
			 * something the engine or the store did to the response. The
			 * separate "the engine only read this much" notice lives in the
			 * request builder's viewer and both can be on screen at once.
			 *
			 * Download is promised only when there is a Download button - the
			 * history viewer mounts this with no `actions` slot.
			 */}
			{isLargeBody && (
				<div className="shrink-0 px-4 pt-3">
					<Callout severity="info" title="Large response">
						This body is {formatSize(bodyLength)}. Formatting is off and only the first{" "}
						{formatSize(LARGE_BODY_BYTES)} is shown here, so the pane stays responsive.
						{actions ? " Download saves the body the app received." : ""}
					</Callout>
				</div>
			)}

			{/* Content */}
			<div className="flex-1 min-h-0">
				{!isLargeBody && viewMode === "preview" && detectedType === "html" ? (
					<iframe
						srcDoc={previewHtml}
						className="w-full h-full bg-white"
						sandbox="allow-scripts allow-same-origin"
						title="HTML Preview"
					/>
				) : (
					<CodeEditor
						height={height}
						// Plaintext above the gate too: tokenising a 2MB model for
						// syntax colours is the third of the three passes the
						// threshold exists to avoid.
						language={isLargeBody || viewMode === "raw" ? "plaintext" : language}
						value={formattedBody}
						readOnly
						fontSize={compact ? 12 : 13}
					/>
				)}
			</div>
		</div>
	);
}
