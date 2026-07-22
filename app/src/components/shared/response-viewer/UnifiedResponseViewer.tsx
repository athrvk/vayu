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
import { FileText } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger, Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { EmptyState } from "../EmptyState";
import ResponseBody from "./ResponseBody";
import HeadersViewer, { CompactHeadersViewer } from "./HeadersViewer";
import { ResponseStatusBar } from "./ResponseStatusBar";
import { ResponseActions } from "./ResponseActions";
import { ResponseHeadersPanel } from "./ResponseHeadersPanel";
import { RESPONSE_TAB_TRIGGER } from "./tab-trigger";
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

	// Merge trace data with response/request if available
	const effectiveResponse = response || trace?.response;
	const effectiveRequest = request || trace?.request;

	// Empty state
	if (!effectiveResponse?.body && !effectiveRequest) {
		return (
			<div className={cn("flex-1 flex surface-card", className)}>
				<EmptyState
					icon={FileText}
					title="No response captured"
					description="This run finished without recording request or response data."
				/>
			</div>
		);
	}

	/*
	 * This viewer prefers the raw bytes: a stored run is being inspected, so what
	 * the server actually sent matters more than a prettified rendering. The
	 * request builder copies its formatted body instead - which is why
	 * `ResponseActions` takes the content rather than deriving it.
	 */
	const copyableContent = effectiveResponse?.bodyRaw || effectiveResponse?.body;

	// Compact mode: simpler layout for embedded views
	if (compact) {
		return (
			<div
				className={cn(
					"flex flex-col surface-card border border-rule rounded-lg overflow-hidden",
					className
				)}
			>
				{/* Simple tab buttons */}
				<div className="flex gap-2 p-3 border-b border-rule bg-muted/30">
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
		<div className={cn("flex-1 flex flex-col surface-card overflow-hidden", className)}>
			{/* Response Header with status/time/size */}
			{effectiveResponse?.status !== undefined && (
				<ResponseStatusBar
					status={effectiveResponse.status}
					statusText={effectiveResponse.statusText}
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
				<div className="flex items-center justify-between border-b border-rule px-4">
					<TabsList className="h-auto p-0 bg-transparent">
						<TabsTrigger value="body" className={RESPONSE_TAB_TRIGGER}>
							Body
						</TabsTrigger>
						{!hiddenTabs.includes("headers") && (
							<TabsTrigger value="headers" className={RESPONSE_TAB_TRIGGER}>
								Headers
								{effectiveResponse?.headers && (
									<Badge variant="secondary" className="ml-1.5 text-xs">
										{Object.keys(effectiveResponse.headers).length}
									</Badge>
								)}
							</TabsTrigger>
						)}
						{!hiddenTabs.includes("request") && effectiveRequest && (
							<TabsTrigger value="request" className={RESPONSE_TAB_TRIGGER}>
								Request
							</TabsTrigger>
						)}
					</TabsList>

					{/* No `fileExtension`: a stored run carries no detected body type,
					    so downloads stay `.txt` as they always have here. */}
					{showActions && copyableContent && (
						<ResponseActions content={copyableContent} />
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
						{/* This inlined the same panel the request builder had in
						    `ResponseHeadersTab`, minus its empty state - so a response with
						    no headers showed a blank pane with nothing saying why. */}
						<ResponseHeadersPanel
							requestHeaders={effectiveRequest?.headers}
							responseHeaders={effectiveResponse?.headers}
						/>
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
