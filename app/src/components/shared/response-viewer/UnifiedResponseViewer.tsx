/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * UnifiedResponseViewer Component
 *
 * The embedded exchange viewer: Load Test History's sampled responses
 * (`SampleRequestCard`, `ScenarioStepCard`) and an inbox capture
 * (`CaptureDetail`).
 *
 * Two shapes, told apart by whether `response` is present:
 * - With a `response`: the first tab is "Response" and holds the response body,
 *   in a fixed-height panel (the callers cap the card with `max-h-*`).
 * - Request only (a capture has no response): the first tab is "Body" and holds
 *   `request.body`, and the panels fill the card instead of a fixed height,
 *   because the caller sizes the card.
 *
 * Both list the request and response headers on the Headers tab, plus an Events
 * tab when the sample streamed.
 */

import { useState } from "react";
import { FileText, Radio } from "lucide-react";
import { Card, Tabs, TabsContent, TabsList, TabsTrigger, TabLabel } from "@/components/ui";
import { cn } from "@/lib/utils";
import { EmptyState } from "../EmptyState";
import ResponseBody from "./ResponseBody";
import ResponseEvents from "./ResponseEvents";
import { CompactHeadersViewer } from "./HeadersViewer";
import type { ResponseData, UnifiedResponseViewerProps } from "./types";

type ResponseTab = "body" | "headers" | "events";

type BodySource = Pick<ResponseData, "body" | "bodyRaw" | "rawBytes" | "headers">;

/**
 * What the first tab shows: the response's body, or - with no response - the
 * request's own.
 */
function bodySource({ response, request }: UnifiedResponseViewerProps): BodySource | null {
	if (response) return response;
	if (!request) return null;
	return { body: request.body ?? "", rawBytes: request.rawBytes, headers: request.headers ?? {} };
}

export default function UnifiedResponseViewer(props: UnifiedResponseViewerProps) {
	const { response, request, events, className } = props;
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");
	const requestOnly = !response && !!request;
	const source = bodySource(props);

	// Empty state. Headers count as content, not just a body: a load-run sample
	// whose body was binary or dropped for the run's capture budget (#174) has
	// real headers and no body, and calling that "no response captured" would
	// hide the only thing the run did keep.
	const hasHeaders = !!response?.headers && Object.keys(response.headers).length > 0;
	// A body with no text view (`rawBytes`, issue #2458) has an empty `body`
	// and is still a body.
	const hasBody = !!source?.body || !!source?.rawBytes;
	if (!hasBody && !hasHeaders && !request && !events) {
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

	// A sampled response sits in a card its caller caps (`max-h-*`), so its panels
	// carry their own height. A request-only card is sized by its caller, and the
	// panels fill it: `ResponseBody`'s `h-full` needs a sized parent.
	const panelClass = requestOnly
		? "flex min-h-0 flex-1 flex-col overflow-auto"
		: "h-[500px] overflow-auto";

	return (
		<Card className={cn("flex flex-col overflow-hidden", className)}>
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
				<TabsList variant="pane">
					<TabsTrigger value="body">
						<FileText className="size-icon-sm" />
						<TabLabel>{requestOnly ? "Body" : "Response"}</TabLabel>
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
							<Radio className="size-icon-sm" />
							<TabLabel>Events</TabLabel>
						</TabsTrigger>
					)}
				</TabsList>

				<TabsContent value="body" className={panelClass}>
					{source && hasBody ? (
						<ResponseBody
							body={source.body}
							bodyRaw={source.bodyRaw}
							rawBytes={source.rawBytes}
							headers={source.headers || {}}
							showModeToggle
						/>
					) : (
						// `h-full` because this scroll container is not a flex column,
						// so the primitive's `flex-1` has nothing to grow against.
						<EmptyState
							icon={FileText}
							title={requestOnly ? "No body" : "No response body"}
							className="h-full"
						/>
					)}
				</TabsContent>

				<TabsContent value="headers" className={panelClass}>
					<div className="p-4 space-y-4 overflow-auto h-full">
						{request?.headers && Object.keys(request.headers).length > 0 && (
							<CompactHeadersViewer
								headers={request.headers}
								title="Request headers"
							/>
						)}
						{response?.headers && Object.keys(response.headers).length > 0 && (
							<CompactHeadersViewer
								headers={response.headers}
								headerLines={response.headerLines}
								title="Response headers"
							/>
						)}
						{(!request?.headers || Object.keys(request.headers).length === 0) &&
							(!response?.headers || Object.keys(response.headers).length === 0) && (
								<EmptyState icon={FileText} title="No headers available" />
							)}
					</div>
				</TabsContent>
				{events && (
					<TabsContent value="events" className={panelClass}>
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
		</Card>
	);
}
