/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UnifiedResponseViewer Component
 *
 * The embedded response view for one sampled exchange of a load test
 * (`SamplesTab` -> `SampleRequestCard`). Two buttons - Response and Headers -
 * over a fixed-height pane.
 *
 * It used to have a second, full-page mode as well, for design-run history.
 * Design runs now open in the request builder, whose `ResponseViewer` is the
 * real thing - seven tabs, live context - so the full mode had no callers left
 * and is gone. What remains is the embedded case, which stays because a
 * samples list cannot mount a builder per sample.
 *
 * Anything genuinely shared with the builder's pane lives beside this file
 * (`ResponseStatusBar`, `ResponseBody`, `ResponseActions`, ...); the two shells
 * are different on purpose and merging them is what produced the drift those
 * files were extracted to end.
 */

import { useState } from "react";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { EmptyState } from "../EmptyState";
import ResponseBody from "./ResponseBody";
import { CompactHeadersViewer } from "./HeadersViewer";
import type { UnifiedResponseViewerProps } from "./types";

type ResponseTab = "body" | "headers";

export default function UnifiedResponseViewer({
	response,
	request,
	className,
}: UnifiedResponseViewerProps) {
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");

	// Empty state
	if (!response?.body && !request) {
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
				<Button
					variant={activeTab === "headers" ? "default" : "ghost"}
					size="sm"
					onClick={() => setActiveTab("headers")}
					className="text-xs h-7"
				>
					Headers
				</Button>
			</div>

			{/* Content */}
			<div className="h-[500px] overflow-auto">
				{activeTab === "body" && response?.body && (
					<ResponseBody
						body={response.body}
						bodyRaw={response.bodyRaw}
						headers={response.headers || {}}
						compact
						showModeToggle
					/>
				)}
				{activeTab === "body" && !response?.body && (
					// `h-full` because this scroll container is not a flex column,
					// so the primitive's `flex-1` has nothing to grow against.
					<EmptyState icon={FileText} title="No response body" className="h-full" />
				)}
				{activeTab === "headers" && (
					<div className="p-4 space-y-4 overflow-auto h-full">
						{request?.headers && Object.keys(request.headers).length > 0 && (
							<CompactHeadersViewer
								headers={request.headers}
								title="Request Headers"
							/>
						)}
						{response?.headers && Object.keys(response.headers).length > 0 && (
							<CompactHeadersViewer
								headers={response.headers}
								title="Response Headers"
							/>
						)}
						{(!request?.headers || Object.keys(request.headers).length === 0) &&
							(!response?.headers || Object.keys(response.headers).length === 0) && (
								<EmptyState icon={FileText} title="No headers available" />
							)}
					</div>
				)}
			</div>
		</div>
	);
}
