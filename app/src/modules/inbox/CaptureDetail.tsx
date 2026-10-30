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
 * `CaptureRaw` prints the raw HTTP text. Rendering an inbound
 * request with the same components as an outbound one is the point: a webhook
 * you received should read like a request you sent.
 */

import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui";
import {
	CopyForAgentButton,
	EmptyState,
	MethodBadge,
	UnifiedResponseViewer,
} from "@/components/shared";
import { captureReference } from "@/lib/agent-reference";
import type { InboxCapture } from "@/types";
import { CaptureRaw } from "./CaptureRaw";
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
				<MethodBadge method={capture.method} variant="badge" size="md" />
				<span className="font-mono text-xs text-muted-foreground break-all">{url}</span>
				<CopyForAgentButton
					reference={captureReference(capture)}
					label="Copy capture for agent"
				/>
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

			<CaptureRaw capture={capture} url={url} />
		</div>
	);
}
