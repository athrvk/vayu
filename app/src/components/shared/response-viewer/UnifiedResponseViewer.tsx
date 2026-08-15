/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UnifiedResponseViewer Component
 *
 * The compact, embedded response viewer used by Load Test History
 * (`SampleRequestCard`). It used to also have a full mode, selected by the
 * `compact` prop, for `DesignRunDetail`'s inline response pane - that caller
 * was deleted, so the full-mode branch had no reachable path left and was
 * removed along with the props that only steered it (`compact`, `showActions`,
 * `hiddenTabs`, `trace`). This component is the compact layout now; there is
 * no other mode to switch on.
 *
 * Features:
 * - Response body view
 * - Request and response headers
 */

import { useState } from "react";
import { FileText, Radio } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger, TabLabel } from "@/components/ui";
import { cn } from "@/lib/utils";
import { EmptyState } from "../EmptyState";
import ResponseBody from "./ResponseBody";
import ResponseEvents from "./ResponseEvents";
import { CompactHeadersViewer } from "./HeadersViewer";
import type { UnifiedResponseViewerProps } from "./types";

type ResponseTab = "body" | "headers" | "events";

export default function UnifiedResponseViewer({
	response,
	request,
	events,
	className,
}: UnifiedResponseViewerProps) {
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");

	// Empty state. Headers count as content, not just a body: a load-run sample
	// whose body was binary or dropped for the run's capture budget (#174) has
	// real headers and no body, and calling that "no response captured" would
	// hide the only thing the run did keep.
	const hasHeaders = !!response?.headers && Object.keys(response.headers).length > 0;
	if (!response?.body && !hasHeaders && !request && !events) {
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
			{/*
			 * The app's Tabs primitive, not two hand-rolled Buttons. The old pair
			 * were their own tab stops with no arrow-key model and no
			 * aria-controls, and they were a third tab look in an app that now
			 * has one. A TabsContent per trigger, not a single panel for the
			 * active value - Radix points each trigger's aria-controls at the
			 * panel for its own value (tabs-panels.test.tsx).
			 */}
			<Tabs
				value={activeTab}
				onValueChange={(v) => setActiveTab(v as ResponseTab)}
				className="flex min-h-0 flex-1 flex-col"
			>
				<TabsList className="px-3 py-1.5 border-b border-rule bg-muted/30">
					<TabsTrigger value="body">
						<FileText className="w-3 h-3" />
						<TabLabel>Response</TabLabel>
					</TabsTrigger>
					<TabsTrigger value="headers">
						<TabLabel>Headers</TabLabel>
					</TabsTrigger>
					{/* Only for a sample that streamed. The constant-tab-set rule
					    belongs to the request builder's strip, which always knows
					    whether a send was a stream; this viewer renders stored
					    samples of every shape, and a permanent "Events" tab over
					    "not an event stream" would be a tab that is empty for
					    almost every row it shows. */}
					{events && (
						<TabsTrigger value="events">
							<Radio className="w-3 h-3" />
							<TabLabel>Events</TabLabel>
						</TabsTrigger>
					)}
				</TabsList>

				<TabsContent value="body" className="h-[500px] overflow-auto">
					{response?.body ? (
						<ResponseBody
							body={response.body}
							bodyRaw={response.bodyRaw}
							headers={response.headers || {}}
							compact
							showModeToggle
						/>
					) : (
						// `h-full` because this scroll container is not a flex column,
						// so the primitive's `flex-1` has nothing to grow against.
						<EmptyState icon={FileText} title="No response body" className="h-full" />
					)}
				</TabsContent>

				<TabsContent value="headers" className="h-[500px] overflow-auto">
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
				</TabsContent>
				{events && (
					<TabsContent value="events" className="h-[500px] overflow-auto">
						{/* `isStream` is what the presence of the node already
						    means, and the stream has ended by the time a sample is
						    stored - so neither is a question this caller has to
						    answer twice. */}
						<ResponseEvents
							events={events.items}
							totalEvents={events.totalEvents}
							eventsTruncated={events.eventsTruncated}
							isStream
						/>
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}
