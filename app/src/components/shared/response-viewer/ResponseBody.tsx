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
	headers,
	className,
	defaultMode = "pretty",
	height = "100%",
	showModeToggle = true,
	compact = false,
}: ExtendedResponseBodyProps) {
	const [viewMode, setViewMode] = useState<ViewMode>(defaultMode);

	// Detect body type from content and headers
	const detectedType = useMemo(() => detectBodyType(headers, body), [headers, body]);

	// Check if preview is available
	const canPreview = detectedType === "html" || detectedType === "image";

	// Format body for pretty view
	const formattedBody = useMemo(() => {
		if (viewMode === "raw") return body;
		return formatBody(body, detectedType);
	}, [body, detectedType, viewMode]);

	// Get Monaco language
	const language = useMemo(() => getMonacoLanguage(detectedType), [detectedType]);

	// Prepare HTML for preview with disabled links and base styles
	const previewHtml = useMemo(() => {
		if (detectedType !== "html") return body;

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
		if (body.includes("</head>")) {
			return body.replace("</head>", disableLinkScript + "</head>");
		} else if (body.includes("</body>")) {
			return body.replace("</body>", disableLinkScript + "</body>");
		} else {
			return body + disableLinkScript;
		}
	}, [body, detectedType]);

	// Handle image types
	if (detectedType === "image") {
		const contentType = headers["content-type"] || headers["Content-Type"] || "image/png";
		return (
			<div
				className={cn("flex-1 flex items-center justify-center p-4 bg-zinc-900", className)}
			>
				<div className="text-center space-y-4">
					<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted text-sm text-muted-foreground">
						<ImageIcon className="w-4 h-4" />
						<span>
							Image Response ({contentType.split("/")[1]?.toUpperCase() || "IMAGE"})
						</span>
					</div>
					<div className="max-w-full max-h-[400px] overflow-auto">
						<img
							src={`data:${contentType};base64,${body}`}
							alt="Response"
							className="max-w-full h-auto rounded-md border border-border"
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
					<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted text-sm text-muted-foreground">
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
					<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted text-sm text-muted-foreground">
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
					<div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
						<Button
							size="sm"
							variant={viewMode === "pretty" ? "secondary" : "ghost"}
							onClick={() => setViewMode("pretty")}
							className={cn(
								"h-7 px-2 text-xs gap-1",
								compact && "h-6 px-1.5 text-[11px]"
							)}
						>
							<Code className={cn("w-3 h-3", compact && "w-2.5 h-2.5")} />
							Pretty
						</Button>
						<Button
							size="sm"
							variant={viewMode === "raw" ? "secondary" : "ghost"}
							onClick={() => setViewMode("raw")}
							className={cn(
								"h-7 px-2 text-xs gap-1",
								compact && "h-6 px-1.5 text-[11px]"
							)}
						>
							<FileText className={cn("w-3 h-3", compact && "w-2.5 h-2.5")} />
							Raw
						</Button>
						{canPreview && (
							<Button
								size="sm"
								variant={viewMode === "preview" ? "secondary" : "ghost"}
								onClick={() => setViewMode("preview")}
								className={cn(
									"h-7 px-2 text-xs gap-1",
									compact && "h-6 px-1.5 text-[11px]"
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
