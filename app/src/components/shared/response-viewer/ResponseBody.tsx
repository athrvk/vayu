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
 */

import { useState, useMemo } from "react";
import { FileCode, Image as ImageIcon, File, Eye, Code, FileText } from "lucide-react";
import { CodeEditor, ToggleGroup, ToggleGroupItem } from "@/components/ui";
import { cn } from "@/lib/utils";
import { detectBodyType, getMonacoLanguage, formatBody } from "./utils";
import type { ResponseBodyProps, ViewMode } from "./types";

interface ExtendedResponseBodyProps extends ResponseBodyProps {
	/** Default view mode */
	defaultMode?: ViewMode;
	/** Height for the editor (use "100%" for flex containers) */
	height?: string;
	/** Show view mode toggle buttons */
	showModeToggle?: boolean;
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
	compact = false,
}: ExtendedResponseBodyProps) {
	const [viewMode, setViewMode] = useState<ViewMode>(defaultMode);

	// Detect body type from content and headers
	const detectedType = useMemo(
		() => detectBodyType(headers, bodyRaw || body),
		[headers, bodyRaw, body]
	);

	// Check if preview is available
	const canPreview = detectedType === "html" || detectedType === "image";

	// Format body for display
	// Raw mode: use bodyRaw (original raw bytes from server) if available, fallback to body
	// Pretty mode: use formatted body
	const formattedBody = useMemo(() => {
		if (viewMode === "raw") {
			// Use bodyRaw for raw view to show actual server response
			return bodyRaw || body;
		}
		return formatBody(body, detectedType);
	}, [body, bodyRaw, detectedType, viewMode]);

	// Get Monaco language
	const language = useMemo(() => getMonacoLanguage(detectedType), [detectedType]);

	// Prepare HTML for preview with disabled links and base styles
	// Use bodyRaw for preview to show actual server response
	const previewHtml = useMemo(() => {
		const htmlContent = bodyRaw || body;
		if (detectedType !== "html") return htmlContent;

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
	}, [body, bodyRaw, detectedType]);

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
			 * `surface-sunken` rather than `bg-muted/20`: an arbitrary alpha
			 * declares no `--rule`, so the segmented control inside it had nothing
			 * for its border to resolve against.
			 */}
			<div className="flex h-8 items-center justify-between gap-2 px-4 border-b border-rule surface-sunken">
				<div className="flex items-center gap-2">
					{/* 14px, matching the tab row's `w-3.5` icons. It was 16px. */}
					<FileCode className="w-3.5 h-3.5 text-muted-foreground" />
					<span className="text-[11px] text-muted-foreground uppercase tracking-[0.06em]">
						{detectedType}
					</span>
				</div>

				{showModeToggle && (
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
			</div>

			{/* Content */}
			<div className="flex-1 min-h-0">
				{viewMode === "preview" && detectedType === "html" ? (
					<iframe
						srcDoc={previewHtml}
						className="w-full h-full bg-white"
						sandbox="allow-scripts allow-same-origin"
						title="HTML Preview"
					/>
				) : (
					<CodeEditor
						height={height}
						language={viewMode === "raw" ? "plaintext" : language}
						value={formattedBody}
						readOnly
						fontSize={compact ? 12 : 13}
					/>
				)}
			</div>
		</div>
	);
}
