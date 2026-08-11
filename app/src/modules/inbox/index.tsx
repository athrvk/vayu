/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Webhook Inbox (issue #480)
 *
 * Vayu can send in every direction and, until this, receive in none - so
 * testing the receiving half of a webhook meant routing payloads through
 * webhook.site or an ngrok tunnel. This surface starts an engine-hosted
 * listener, hands over its URL, and shows what arrives, live.
 *
 * One tab, not one per inbox: an inbox is engine-process state with no id worth
 * restoring into a tab, and the engine allows a single live stream per inbox
 * (each holds a pool thread), so a surface that watched several at once would
 * be spending threads on lists nobody is reading.
 */

import { useState } from "react";
import { Copy, Inbox as InboxIcon, Play, Square, Trash2 } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { EmptyState, ErrorState } from "@/components/shared";
import {
	useClearInboxCapturesMutation,
	useInboxCapturesQuery,
	useInboxesQuery,
	useStartInboxMutation,
	useStopInboxMutation,
	useUpdateInboxResponseMutation,
} from "@/queries";
import { useToastStore } from "@/stores";
import { cn } from "@/lib/utils";
import type { Inbox, InboxCannedResponse, InboxCapture } from "@/types";
import { CannedResponseControls } from "./CannedResponseControls";
import { CaptureDetail } from "./CaptureDetail";
import { useInboxLive } from "./useInboxLive";

function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString();
}

interface CaptureRowProps {
	capture: InboxCapture;
	selected: boolean;
	onSelect: () => void;
}

function CaptureRow({ capture, selected, onSelect }: CaptureRowProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-current={selected}
			className={cn(
				"flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
				selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"
			)}
		>
			<span className="flex w-full items-center gap-2">
				<span className="font-mono text-xs font-semibold">{capture.method}</span>
				<span className="truncate font-mono text-xs">{capture.path}</span>
				<span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
					{formatTime(capture.receivedAt)}
				</span>
			</span>
			<span className="text-xs text-muted-foreground">
				{capture.bodyBytes} bytes{capture.query ? ` · ?${capture.query}` : ""}
			</span>
		</button>
	);
}

export default function InboxView() {
	const showToast = useToastStore((s) => s.showToast);
	const { data: inboxes = [], isError, error, refetch } = useInboxesQuery();
	const [selectedInboxId, setSelectedInboxId] = useState<string | null>(null);
	const [selectedCaptureId, setSelectedCaptureId] = useState<number | null>(null);

	const startInbox = useStartInboxMutation();
	const stopInbox = useStopInboxMutation();
	const updateResponse = useUpdateInboxResponseMutation();
	const clearCaptures = useClearInboxCapturesMutation();

	// Derived, not synced into state: the engine is the list of inboxes, and a
	// selection it no longer has falls back to the first one it does. An effect
	// writing the fallback back into `selectedInboxId` would say the same thing
	// one render later, and be wrong for that render.
	const inbox: Inbox | null =
		inboxes.find((i) => i.inboxId === selectedInboxId) ?? inboxes[0] ?? null;

	const capturesQuery = useInboxCapturesQuery(inbox?.inboxId ?? null);
	const captures = capturesQuery.data?.data ?? [];
	const watching = useInboxLive(inbox?.inboxId ?? null, inbox?.running === true);

	const selectedCapture = captures.find((c) => c.id === selectedCaptureId) ?? captures[0] ?? null;

	if (isError) {
		return (
			<ErrorState
				title="Couldn't load the inboxes"
				detail={error instanceof Error ? error.message : undefined}
				onRetry={() => void refetch()}
			/>
		);
	}

	const start = () => {
		startInbox.mutate(
			{},
			{
				onSuccess: (started) => setSelectedInboxId(started.inboxId),
				onError: (mutationError) =>
					showToast(
						mutationError instanceof Error
							? mutationError.message
							: "Could not start the inbox",
						"error"
					),
			}
		);
	};

	const applyResponse = (response: Partial<InboxCannedResponse>) => {
		if (!inbox) return;
		updateResponse.mutate(
			{ inboxId: inbox.inboxId, response },
			{
				onError: (mutationError) =>
					showToast(
						mutationError instanceof Error
							? mutationError.message
							: "Could not update the response",
						"error"
					),
			}
		);
	};

	if (!inbox) {
		return (
			<EmptyState
				icon={InboxIcon}
				title="No inbox running"
				description="Start one to get a local URL that records every request sent to it - no tunnel, no third party."
				action={
					<Button onClick={start} disabled={startInbox.isPending}>
						<Play className="mr-2 h-4 w-4" aria-hidden="true" />
						Start inbox
					</Button>
				}
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
				<InboxIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
				<code className="font-mono text-xs">{inbox.url}</code>
				<Button
					variant="ghost"
					size="sm"
					aria-label="Copy inbox URL"
					onClick={() => {
						void navigator.clipboard.writeText(inbox.url);
						showToast("Inbox URL copied", "success");
					}}
				>
					<Copy className="h-3.5 w-3.5" aria-hidden="true" />
				</Button>

				{/*
				 * An inbox reachable beyond this machine is badged wherever it is
				 * named. The engine already refused to bind wide without an
				 * explicit confirmation; this is the standing reminder that the
				 * confirmation was given.
				 */}
				{!inbox.loopback && (
					<Badge
						variant="chip"
						className="bg-status-warning-fill text-primary-foreground"
					>
						Reachable on {inbox.bind}
					</Badge>
				)}
				<Badge variant="outline">
					{inbox.running ? (watching ? "Live" : "Running") : "Stopped"}
				</Badge>

				<div className="ml-auto flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => clearCaptures.mutate(inbox.inboxId)}
						disabled={clearCaptures.isPending || captures.length === 0}
					>
						<Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
						Clear
					</Button>
					{inbox.running ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => stopInbox.mutate(inbox.inboxId)}
							disabled={stopInbox.isPending}
						>
							<Square className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
							Stop
						</Button>
					) : (
						<Button size="sm" onClick={start} disabled={startInbox.isPending}>
							<Play className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
							Start new
						</Button>
					)}
				</div>
			</header>

			{/* Keyed on what the engine is serving, so a change made elsewhere
			    re-seeds the drafts by remount rather than by an effect. */}
			<CannedResponseControls
				key={`${inbox.inboxId}:${inbox.response.status}:${inbox.response.delayMs}`}
				response={inbox.response}
				pending={updateResponse.isPending}
				onApply={applyResponse}
			/>

			<div className="flex min-h-0 flex-1">
				<aside className="flex w-72 min-h-0 shrink-0 flex-col border-r border-border">
					<div className="flex items-center justify-between px-3 py-2">
						<span className="text-xs font-medium text-muted-foreground">Captured</span>
						<Badge variant="outline">{capturesQuery.data?.pagination.total ?? 0}</Badge>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
						{captures.length === 0 ? (
							<EmptyState
								variant="inline"
								title="Nothing received yet. Point a webhook at the URL above."
							/>
						) : (
							captures.map((capture) => (
								<CaptureRow
									key={capture.id}
									capture={capture}
									selected={selectedCapture?.id === capture.id}
									onSelect={() => setSelectedCaptureId(capture.id)}
								/>
							))
						)}
					</div>
				</aside>

				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
					<CaptureDetail capture={selectedCapture} inboxUrl={inbox.url} />
				</div>
			</div>
		</div>
	);
}
