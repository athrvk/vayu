/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One captured request, rendered through the shared viewer family.
 *
 * A capture is an exchange with no response - `UnifiedResponseViewer` already
 * handles exactly that (it guards on request-or-response, not both), and
 * `buildRawRequest` already produces the raw HTTP text. Rendering an inbound
 * request with the same components as an outbound one is the point: a webhook
 * you received should read like a request you sent.
 */

import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui";
import { EmptyState, UnifiedResponseViewer } from "@/components/shared";
import { buildRawRequest } from "@/components/shared/response-viewer/utils";
import type { InboxCapture } from "@/types";
import { captureUrl } from "./utils";

interface CaptureDetailProps {
	capture: InboxCapture | null;
	inboxUrl: string;
}

export function CaptureDetail({ capture, inboxUrl }: CaptureDetailProps) {
	if (!capture) {
		return (
			<EmptyState
				icon={Inbox}
				title="No request selected"
				description="Pick a capture to see its headers and body."
			/>
		);
	}

	const url = captureUrl(capture, inboxUrl);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant="outline" className="font-mono">
					{capture.method}
				</Badge>
				<span className="font-mono text-xs text-muted-foreground break-all">{url}</span>
				{capture.remoteAddr && (
					<span className="text-xs text-muted-foreground">from {capture.remoteAddr}</span>
				)}
				{/*
				 * A truncated body says so where the body is read, not only in the
				 * row: the stored bytes are a valid prefix, and a reader who does
				 * not know that is reading a payload the sender never sent.
				 */}
				{capture.bodyTruncated && (
					<Badge
						variant="chip"
						className="bg-status-warning-fill text-primary-foreground"
					>
						Truncated - {capture.bodyBytes} bytes received
					</Badge>
				)}
			</div>

			<UnifiedResponseViewer
				className="min-h-0 flex-1"
				request={{
					method: capture.method,
					url,
					headers: capture.headers,
					body: capture.body,
				}}
			/>

			<div className="flex min-h-0 flex-col gap-1">
				<span className="text-xs font-medium text-muted-foreground">Raw</span>
				<pre className="max-h-48 overflow-auto surface-sunken border border-rule rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-all">
					{buildRawRequest(capture.method, url, capture.headers, capture.body)}
				</pre>
			</div>
		</div>
	);
}
