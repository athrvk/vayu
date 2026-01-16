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
import { Clock, FileText, Copy, Check, Download, Send } from "lucide-react";
import {
	Tabs,
	TabsList,
	TabsTrigger,
	Badge,
	Button,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui";
import { cn } from "@/lib/utils";
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
			<div className={cn("flex-1 flex items-center justify-center bg-card", className)}>
				<div className="text-center space-y-2">
					<FileText className="w-8 h-8 mx-auto text-muted-foreground/50" />
					<p className="text-sm text-muted-foreground">No response data available</p>
				</div>
			</div>
		);
	}

	const handleCopy = async () => {
		if (effectiveResponse?.body) {
			await navigator.clipboard.writeText(effectiveResponse.body);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleDownload = () => {
		if (effectiveResponse?.body) {
			const blob = new Blob([effectiveResponse.body], { type: "text/plain" });
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
				className={cn("flex flex-col bg-card rounded-lg border overflow-hidden", className)}
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
					{!hiddenTabs.includes("request") && effectiveRequest && (
						<Button
							variant={activeTab === "request" ? "default" : "ghost"}
							size="sm"
							onClick={() => setActiveTab("request")}
							className="text-xs h-7"
						>
							<Send className="w-3 h-3 mr-1" />
							Request
						</Button>
					)}
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
				<div className="flex-1 min-h-[200px] max-h-[500px] overflow-hidden">
					{activeTab === "body" && effectiveResponse?.body && (
						<ResponseBody
							body={effectiveResponse.body}
							headers={effectiveResponse.headers || {}}
							compact
							showModeToggle
						/>
					)}
					{activeTab === "body" && !effectiveResponse?.body && (
						<div className="flex items-center justify-center h-full text-muted-foreground">
							<div className="text-center py-8">
								<FileText className="w-6 h-6 mx-auto mb-2 opacity-30" />
								<p className="text-sm">No response body</p>
							</div>
						</div>
					)}
					{activeTab === "request" && (
						<div className="p-4 space-y-4 overflow-auto h-full">
							{effectiveRequest?.headers &&
								Object.keys(effectiveRequest.headers).length > 0 && (
									<CompactHeadersViewer
										headers={effectiveRequest.headers}
										title="Request Headers"
									/>
								)}
							{effectiveRequest?.body && (
								<div>
									<h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase">
										Request Body
									</h4>
									<pre className="bg-muted p-3 rounded-lg text-xs font-mono overflow-x-auto max-h-[200px] whitespace-pre-wrap">
										{typeof effectiveRequest.body === "object"
											? JSON.stringify(effectiveRequest.body, null, 2)
											: effectiveRequest.body}
									</pre>
								</div>
							)}
							{!effectiveRequest?.headers && !effectiveRequest?.body && (
								<div className="py-8 text-center text-muted-foreground">
									<Send className="w-6 h-6 mx-auto mb-2 opacity-30" />
									<p className="text-sm">No request data</p>
								</div>
							)}
						</div>
					)}
					{activeTab === "headers" && (
						<div className="p-4 space-y-4 overflow-auto h-full">
							{effectiveResponse?.headers &&
								Object.keys(effectiveResponse.headers).length > 0 && (
									<CompactHeadersViewer
										headers={effectiveResponse.headers}
										title="Response Headers"
									/>
								)}
							{effectiveRequest?.headers &&
								Object.keys(effectiveRequest.headers).length > 0 && (
									<CompactHeadersViewer
										headers={effectiveRequest.headers}
										title="Request Headers"
									/>
								)}
							{!effectiveResponse?.headers && !effectiveRequest?.headers && (
								<div className="py-8 text-center text-muted-foreground">
									<FileText className="w-6 h-6 mx-auto mb-2 opacity-30" />
									<p className="text-sm">No headers available</p>
								</div>
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
							className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
						>
							Body
						</TabsTrigger>
						{!hiddenTabs.includes("headers") && (
							<TabsTrigger
								value="headers"
								className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
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
								className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent"
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
									<Button size="icon" variant="ghost" onClick={handleCopy}>
										{copied ? (
											<Check className="w-4 h-4 text-green-500" />
										) : (
											<Copy className="w-4 h-4" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>Copy response</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button size="icon" variant="ghost" onClick={handleDownload}>
										<Download className="w-4 h-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>Download response</TooltipContent>
							</Tooltip>
						</div>
					)}
				</div>

				{/* Tab Content */}
				<div className="flex-1 overflow-hidden">
					{activeTab === "body" && effectiveResponse?.body && (
						<ResponseBody
							body={effectiveResponse.body}
							headers={effectiveResponse.headers || {}}
							showModeToggle
						/>
					)}
					{activeTab === "body" && !effectiveResponse?.body && (
						<div className="flex items-center justify-center h-full text-muted-foreground">
							<div className="text-center">
								<FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
								<p className="text-sm">No response body</p>
							</div>
						</div>
					)}
					{activeTab === "headers" && (
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
					)}
					{activeTab === "request" && (
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
					)}
				</div>
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
			? "bg-green-500"
			: status >= 300 && status < 400
				? "bg-yellow-500"
				: status >= 400 && status < 500
					? "bg-orange-500"
					: "bg-red-500";

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
					<span>{time} ms</span>
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
