/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UnifiedResponseViewer Component
 *
 * A centralized response viewer component that can be used across the application:
 * - Request Builder (live responses)
 * - Design Mode History (historical design runs)
 * - Load Test History (sample requests)
 *
 * Features:
 * - Pretty/Raw/Preview view modes (like Postman)
 * - Request and response headers
 * - Timing breakdown
 * - Compact mode for embedded views
 */

import { useState } from "react";
import { Clock, FileText, Copy, Check, Download } from "lucide-react";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	Badge,
	Button,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { EmptyState } from "../EmptyState";
import ResponseBody from "./ResponseBody";
import HeadersViewer, { CompactHeadersViewer } from "./HeadersViewer";
import { formatSize } from "./utils";
import type { UnifiedResponseViewerProps } from "./types";

type ResponseTab = "body" | "headers" | "request";

export default function UnifiedResponseViewer({
	response,
	request,
	trace,
	compact = false,
	showActions = true,
	hiddenTabs = [],
	className,
}: UnifiedResponseViewerProps) {
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");
	const [copied, setCopied] = useState(false);

	// Merge trace data with response/request if available
	const effectiveResponse = response || trace?.response;
	const effectiveRequest = request || trace?.request;

	// Empty state
	if (!effectiveResponse?.body && !effectiveRequest) {
		return (
			<div className={cn("flex-1 flex bg-card", className)}>
				<EmptyState
					icon={FileText}
					title="No response captured"
					description="This run finished without recording request or response data."
				/>
			</div>
		);
	}

	const handleCopy = async () => {
		const content = effectiveResponse?.bodyRaw || effectiveResponse?.body;
		if (content) {
			await navigator.clipboard.writeText(content);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleDownload = () => {
		const content = effectiveResponse?.bodyRaw || effectiveResponse?.body;
		if (content) {
			const blob = new Blob([content], { type: "text/plain" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `response-${Date.now()}.txt`;
			a.click();
			URL.revokeObjectURL(url);
		}
	};

	// Compact mode: simpler layout for embedded views
	if (compact) {
		return (
			<div
				className={cn("flex flex-col bg-card border rounded-lg overflow-hidden", className)}
			>
				{/* Simple tab buttons */}
				<div className="flex gap-2 p-3 border-b bg-muted/30">
					<Button
						variant={activeTab === "body" ? "default" : "ghost"}
						size="sm"
						onClick={() => setActiveTab("body")}
						className="text-xs h-7"
					>
						<FileText className="w-3 h-3 mr-1" />
						Response
					</Button>
					{!hiddenTabs.includes("headers") && (
						<Button
							variant={activeTab === "headers" ? "default" : "ghost"}
							size="sm"
							onClick={() => setActiveTab("headers")}
							className="text-xs h-7"
						>
							Headers
						</Button>
					)}
				</div>

				{/* Content */}
				<div className="h-[500px] overflow-auto">
					{activeTab === "body" && effectiveResponse?.body && (
						<ResponseBody
							body={effectiveResponse.body}
							bodyRaw={effectiveResponse.bodyRaw}
							headers={effectiveResponse.headers || {}}
							compact
							showModeToggle
						/>
					)}
					{activeTab === "body" && !effectiveResponse?.body && (
						// `h-full` because this scroll container is not a flex column,
						// so the primitive's `flex-1` has nothing to grow against.
						<EmptyState icon={FileText} title="No response body" className="h-full" />
					)}
					{activeTab === "headers" && (
						<div className="p-4 space-y-4 overflow-auto h-full">
							{effectiveRequest?.headers &&
								Object.keys(effectiveRequest.headers).length > 0 && (
									<CompactHeadersViewer
										headers={effectiveRequest.headers}
										title="Request Headers"
									/>
								)}
							{effectiveResponse?.headers &&
								Object.keys(effectiveResponse.headers).length > 0 && (
									<CompactHeadersViewer
										headers={effectiveResponse.headers}
										title="Response Headers"
									/>
								)}
							{(!effectiveRequest?.headers ||
								Object.keys(effectiveRequest.headers).length === 0) &&
								(!effectiveResponse?.headers ||
									Object.keys(effectiveResponse.headers).length === 0) && (
									<EmptyState icon={FileText} title="No headers available" />
								)}
						</div>
					)}
				</div>
			</div>
		);
	}

	// Full mode: complete response viewer with all features
	return (
		<div className={cn("flex-1 flex flex-col bg-card overflow-hidden", className)}>
			{/* Response Header with status/time/size */}
			{effectiveResponse?.status !== undefined && (
				<ResponseStatusBar
					status={effectiveResponse.status}
					statusText={effectiveResponse.statusText || ""}
					time={effectiveResponse.time}
					size={effectiveResponse.size}
				/>
			)}

			{/* Tabs */}
			<Tabs
				value={activeTab}
				onValueChange={(v) => setActiveTab(v as ResponseTab)}
				className="flex-1 flex flex-col overflow-hidden"
			>
				<div className="flex items-center justify-between border-b border-border px-4">
					<TabsList className="h-auto p-0 bg-transparent">
						<TabsTrigger
							value="body"
							className="border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
						>
							Body
						</TabsTrigger>
						{!hiddenTabs.includes("headers") && (
							<TabsTrigger
								value="headers"
								className="border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
							>
								Headers
								{effectiveResponse?.headers && (
									<Badge variant="secondary" className="ml-1.5 text-xs">
										{Object.keys(effectiveResponse.headers).length}
									</Badge>
								)}
							</TabsTrigger>
						)}
						{!hiddenTabs.includes("request") && effectiveRequest && (
							<TabsTrigger
								value="request"
								className="border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
							>
								Request
							</TabsTrigger>
						)}
					</TabsList>

					{/* Actions */}
					{showActions && effectiveResponse?.body && (
						<div className="flex items-center gap-1">
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="icon"
										variant="ghost"
										onClick={handleCopy}
										aria-label="Copy response"
									>
										{copied ? (
											<Check className="w-4 h-4 text-status-success-text" />
										) : (
											<Copy className="w-4 h-4" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>Copy response</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										size="icon"
										variant="ghost"
										onClick={handleDownload}
										aria-label="Download response"
									>
										<Download className="w-4 h-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Download response</TooltipContent>
							</Tooltip>
						</div>
					)}
				</div>

				{/*
				 * TabsContent per value. Radix builds each trigger's aria-controls
				 * from its value, so content rendered outside the Tabs tree left all
				 * three triggers advertising panels that were never rendered.
				 */}
				<TabsContent value="body" className="mt-0 flex-1 overflow-hidden">
					{effectiveResponse?.body && (
						<ResponseBody
							body={effectiveResponse.body}
							bodyRaw={effectiveResponse.bodyRaw}
							headers={effectiveResponse.headers || {}}
							showModeToggle
						/>
					)}
					{!effectiveResponse?.body && (
						// `h-full` because TabsContent is not a flex column, so the
						// primitive's `flex-1` has nothing to grow against.
						<EmptyState icon={FileText} title="No response body" className="h-full" />
					)}
				</TabsContent>
				{!hiddenTabs.includes("headers") && (
					<TabsContent value="headers" className="mt-0 flex-1 overflow-hidden">
						<div className="p-4 overflow-auto h-full space-y-4">
							{effectiveRequest?.headers &&
								Object.keys(effectiveRequest.headers).length > 0 && (
									<HeadersViewer
										headers={effectiveRequest.headers}
										variant="request"
										defaultOpen={false}
									/>
								)}
							<HeadersViewer
								headers={effectiveResponse?.headers || {}}
								variant="response"
								defaultOpen={true}
							/>
						</div>
					</TabsContent>
				)}
				{!hiddenTabs.includes("request") && effectiveRequest && (
					<TabsContent value="request" className="mt-0 flex-1 overflow-hidden">
						<div className="p-4 overflow-auto h-full space-y-4">
							{effectiveRequest?.headers &&
								Object.keys(effectiveRequest.headers).length > 0 && (
									<HeadersViewer
										headers={effectiveRequest.headers}
										variant="request"
										defaultOpen={true}
									/>
								)}
							{effectiveRequest?.body && (
								<div>
									<h4 className="text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
										Request Body
									</h4>
									<ResponseBody
										body={
											typeof effectiveRequest.body === "object"
												? JSON.stringify(effectiveRequest.body, null, 2)
												: effectiveRequest.body
										}
										headers={effectiveRequest.headers || {}}
										compact
									/>
								</div>
							)}
						</div>
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}

// Status bar component
function ResponseStatusBar({
	status,
	statusText,
	time,
	size,
}: {
	status: number;
	statusText: string;
	time?: number;
	size?: number;
}) {
	const statusColor =
		status >= 200 && status < 300
			? "bg-status-success-fill"
			: status >= 300 && status < 400
				? "bg-status-warning-fill"
				: status >= 400 && status < 500
					? "bg-status-stopped-fill"
					: "bg-status-error-fill";

	return (
		<div className="flex items-center gap-4 px-4 py-3 border-b border-border bg-muted/30">
			{/* Status */}
			<Badge className={cn("font-mono", statusColor)}>
				{status} {statusText}
			</Badge>

			{/* Time */}
			{time !== undefined && (
				<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<Clock className="w-4 h-4" />
					<span>{time.toFixed(4)} ms</span>
				</div>
			)}

			{/* Size */}
			{size !== undefined && (
				<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<FileText className="w-4 h-4" />
					<span>{formatSize(size)}</span>
				</div>
			)}
		</div>
	);
}
