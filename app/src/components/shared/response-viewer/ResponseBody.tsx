
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
import Editor from "@monaco-editor/react";
import { Button } from "@/components/ui";
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
	const detectedType = useMemo(() => detectBodyType(headers, bodyRaw || body), [headers, bodyRaw, body]);

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
				className={cn("flex-1 flex items-center justify-center p-4 bg-zinc-900", className)}
			>
				<div className="text-center space-y-4">
					<div className="inline-flex items-center gap-2 px-3 py-1.5 bg-muted text-sm text-muted-foreground">
						<ImageIcon className="w-4 h-4" />
						<span>
							Image Response ({contentType.split("/")[1]?.toUpperCase() || "IMAGE"})
						</span>
					</div>
					<div className="max-w-full max-h-[400px] overflow-auto">
						<img
							src={`data:${contentType};base64,${imageData}`}
							alt="Response"
							className="max-w-full h-auto border border-border"
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
				className={cn("flex-1 flex items-center justify-center p-4 bg-zinc-900", className)}
			>
				<div className="text-center space-y-4">
					<div className="inline-flex items-center gap-2 px-3 py-1.5 bg-muted text-sm text-muted-foreground">
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
				className={cn("flex-1 flex items-center justify-center p-4 bg-zinc-900", className)}
			>
				<div className="text-center space-y-4">
					<div className="inline-flex items-center gap-2 px-3 py-1.5 bg-muted text-sm text-muted-foreground">
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
			{/* Mode Toggle Header */}
			<div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border bg-muted/20">
				<div className="flex items-center gap-2">
					<FileCode className="w-4 h-4 text-muted-foreground" />
					<span className="text-xs text-muted-foreground uppercase tracking-wide">
						{detectedType}
					</span>
				</div>

				{showModeToggle && (
					<div className="flex items-center gap-1 bg-muted p-0.5">
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setViewMode("pretty")}
							className={cn(
								"h-7 px-2 text-xs gap-1",
								compact && "h-6 px-1.5 text-[11px]",
								viewMode === "pretty"
									? "bg-background text-foreground shadow-sm font-medium"
									: "text-muted-foreground hover:text-foreground hover:bg-background/50"
							)}
						>
							<Code className={cn("w-3 h-3", compact && "w-2.5 h-2.5")} />
							Pretty
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setViewMode("raw")}
							className={cn(
								"h-7 px-2 text-xs gap-1",
								compact && "h-6 px-1.5 text-[11px]",
								viewMode === "raw"
									? "bg-background text-foreground shadow-sm font-medium"
									: "text-muted-foreground hover:text-foreground hover:bg-background/50"
							)}
						>
							<FileText className={cn("w-3 h-3", compact && "w-2.5 h-2.5")} />
							Raw
						</Button>
						{canPreview && (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setViewMode("preview")}
								className={cn(
									"h-7 px-2 text-xs gap-1",
									compact && "h-6 px-1.5 text-[11px]",
									viewMode === "preview"
										? "bg-background text-foreground shadow-sm font-medium"
										: "text-muted-foreground hover:text-foreground hover:bg-background/50"
								)}
							>
								<Eye className={cn("w-3 h-3", compact && "w-2.5 h-2.5")} />
								Preview
							</Button>
						)}
					</div>
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
					<Editor
						height={height}
						language={viewMode === "raw" ? "plaintext" : language}
						value={formattedBody}
						theme="vs-dark"
						options={{
							readOnly: true,
							minimap: { enabled: false },
							fontSize: compact ? 12 : 13,
							lineNumbers: "on",
							scrollBeyondLastLine: false,
							wordWrap: "on",
							automaticLayout: true,
						}}
					/>
				)}
			</div>
		</div>
	);
}
