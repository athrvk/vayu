/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The embedded exchange viewer: Load Test History's sampled responses (`SampleRequestCard`,
 * `ScenarioStepCard`) and an inbox capture (`CaptureDetail`). Two shapes, by whether `response` is
 * present:
 * - With a `response`: the first tab, "Response", holds its body in a fixed-height panel (callers
 *   cap the card with `max-h-*`).
 * - Request only (a capture has no response): the first tab, "Body", holds `request.body`, and the
 *   panels fill the card, which the caller sizes.
 *
 * Both list request and response headers on the Headers tab, with an Events tab when the sample
 * streamed. Beside a response, a request carrying a body gets a Request tab (the session Console's
 * rows, #3634).
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

type ResponseTab = "body" | "request" | "headers" | "events";

type BodySource = Pick<ResponseData, "body" | "bodyRaw" | "rawBytes" | "headers">;

/** What the first tab shows: the response's body, or without a response the request's own. */
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
	const sentBody = !requestOnly && (!!request?.body || !!request?.rawBytes);

	// Empty state, counting headers as content: a load-run sample whose body was binary or dropped
	// for the capture budget (#174) has real headers, and "no response captured" would hide what
	// was kept.
	const hasHeaders = !!response?.headers && Object.keys(response.headers).length > 0;
	// A body without a text view (`rawBytes`, #2458) has an empty `body` and is still a body.
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

	// A sampled response's card is capped by its caller, so its panels carry their height; a
	// request-only card is caller-sized and the panels fill it (`ResponseBody`'s `h-full` needs a
	// sized parent).
	const panelClass = requestOnly
		? "flex min-h-0 flex-1 flex-col overflow-auto"
		: "h-[500px] overflow-auto";

	return (
		<Card className={cn("flex flex-col overflow-hidden", className)}>
			{/*
			 * The app's Tabs primitive, for its arrow-key model and `aria-controls`, the one tab
			 * look. A TabsContent per trigger, not one panel for the active value: Radix points
			 * each trigger's `aria-controls` at its own value's panel (tabs-panels.test.tsx).
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
					{sentBody && (
						<TabsTrigger value="request">
							<TabLabel>Request</TabLabel>
						</TabsTrigger>
					)}
					<TabsTrigger value="headers">
						<TabLabel>Headers</TabLabel>
					</TabsTrigger>
					{/*
					 * Only for a sample that streamed: the constant-tab-set rule is the request
					 * builder's, whose strip knows whether a send streamed; this viewer shows
					 * stored samples of every shape, and a permanent "Events" over "not an event
					 * stream" would be empty on most rows.
					 */}
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
						// `h-full`, as this scroll container is not a flex column and the
						// primitive's `flex-1` has nothing to grow against.
						<EmptyState
							icon={FileText}
							title={requestOnly ? "No body" : "No response body"}
							className="h-full"
						/>
					)}
				</TabsContent>

				{sentBody && request && (
					<TabsContent value="request" className={panelClass}>
						<ResponseBody
							body={request.body ?? ""}
							rawBytes={request.rawBytes}
							headers={request.headers ?? {}}
							showModeToggle
						/>
					</TabsContent>
				)}

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
						{/*
						 * `isStream` is what the node's presence already means, and a stored
						 * sample's stream has ended, so this caller answers neither twice.
						 */}
						<ResponseEvents
							events={events.items}
							totalEvents={events.totalEvents}
							eventsTruncated={events.eventsTruncated}
							streamText={events.streamText}
							isStream
						/>
					</TabsContent>
				)}
			</Tabs>
		</Card>
	);
}
