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
 *
 * One tab still has to be able to name *which* inbox it shows (issue #554).
 * That address is the tab's own `entityId`, written by whoever opens the tab -
 * a drawer row, or the switcher in this header - and never mirrored into local
 * state: two records of one selection is how the drawer came to open a tab
 * showing a different inbox than the row it was clicked on.
 */

import { useId, useState } from "react";
import { Copy, Eraser, Inbox as InboxIcon, Play, RotateCw, Square, Trash2 } from "lucide-react";
import {
	Badge,
	Button,
	Label,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
} from "@/components/ui";
import { Callout, EmptyState, ErrorState, NonLoopbackBadge } from "@/components/shared";
import {
	useClearInboxCapturesMutation,
	useInboxCapturesQuery,
	useInboxesQuery,
	useLoadMoreInboxCapturesMutation,
	useStartInboxMutation,
	useStopInboxMutation,
	useUpdateInboxResponseMutation,
} from "@/queries";
import { useInboxNotifyStore, useTabsStore, useToastStore } from "@/stores";
import { useCopy } from "@/hooks";
import { cn } from "@/lib/utils";
import type { Inbox, InboxCannedResponse, InboxCapture } from "@/types";
import { CannedResponseControls } from "./CannedResponseControls";
import { CaptureDetail } from "./CaptureDetail";
import { DeleteInboxDialog } from "./DeleteInboxDialog";
import { useInboxDeletion } from "./useInboxDeletion";
import { useInboxLive } from "./useInboxLive";
import { cannedResponseKey } from "./utils";

function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString();
}

/**
 * The per-inbox half of capture notifications (issue #1388).
 *
 * Here rather than in the Notifications settings panel because it is a property
 * of one inbox, the way its canned response is: the panel's opt-in governs the
 * events that happen once, and this governs whether *this* listener may speak
 * for them. Both have to be on, which is why the hint names the other one - a
 * toggle that does nothing because of a setting on another screen is worse than
 * no toggle at all.
 */
function NotifyOnCaptureToggle({ inboxId }: { inboxId: string }) {
	const switchId = useId();
	const enabled = useInboxNotifyStore((s) => s.enabled[inboxId] === true);
	const setEnabled = useInboxNotifyStore((s) => s.setEnabled);
	return (
		<div className="flex items-center gap-2">
			<Label htmlFor={switchId} className="text-xs text-muted-foreground">
				Notify
			</Label>
			{/* `Switch` and `Label` composed directly, as `OAuth2Form` and
			    `RunCollectionDialog` do for a control that sits in a line of
			    other controls. `ToggleRow` is the settings *row* - a full-width
			    `justify-between` box with a description slot and the settings
			    search's `data-setting-row` marker - and none of that belongs in
			    a header strip.

			    Radix renders a button, which the visible label associates with
			    but does not name, so the switch carries its own name - the same
			    reason `ToggleRow` carries both. */}
			<Switch
				id={switchId}
				checked={enabled}
				onCheckedChange={(on) => setEnabled(inboxId, on)}
				aria-label="Notify on capture"
				title="Notify through the system when this inbox captures a request while Vayu is in the background. Needs system notifications on in Settings."
				className="shrink-0"
			/>
		</div>
	);
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
			{/* The truncation marker belongs here as well as in the detail pane:
			    scanning the list for the payload that broke something, a row
			    reading "8 MB" is a row whose body is a prefix, and nothing said
			    so until it was opened (issue #556). */}
			<span className="text-xs text-muted-foreground">
				{capture.bodyBytes} bytes{capture.bodyTruncated ? " (truncated)" : ""}
				{capture.query ? ` · ?${capture.query}` : ""}
			</span>
		</button>
	);
}

/**
 * The tab's half of inbox deletion (issue #553).
 *
 * Its own component so the hook is never called for an inbox that does not
 * exist - `InboxView` returns its empty state before there is one to delete.
 * It passes the capture total it already has, which the record's polled count
 * can lag behind by up to a services poll.
 */
function DeleteInboxButton({ inbox, listedTotal }: { inbox: Inbox; listedTotal: number }) {
	const deletion = useInboxDeletion(inbox, listedTotal);
	return (
		<>
			<Button
				variant="outline"
				size="sm"
				onClick={deletion.requestDelete}
				disabled={deletion.isDeleting}
			>
				<Trash2 className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
				Delete
			</Button>
			<DeleteInboxDialog deletion={deletion} />
		</>
	);
}

export default function InboxView() {
	const showToast = useToastStore((s) => s.showToast);
	const copy = useCopy();
	const { openTabs, activeTabId, openTab } = useTabsStore();
	const { data: inboxes = [], isError, error, refetch } = useInboxesQuery();
	// Which capture, and of which inbox: ids are per-inbox, so a bare number
	// carried across a switch can select a row in the inbox switched *to*.
	const [selection, setSelection] = useState<{ inboxId: string; captureId: number } | null>(null);

	// The notify map is pruned against the engine's list by `useInboxWatchers`,
	// at the app level: an id is dead once the engine that minted it exits, and
	// pruning here meant pruning only while this tab was open (#1400).

	const startInbox = useStartInboxMutation();
	const stopInbox = useStopInboxMutation();
	const updateResponse = useUpdateInboxResponseMutation();
	const clearCaptures = useClearInboxCapturesMutation();

	// The tab is the address (see the file comment): this reads it, and `show`
	// below is the only writer, so the drawer and the switcher change the same
	// thing.
	const activeTab = openTabs.find((t) => t.id === activeTabId);
	const addressedInboxId = activeTab?.type === "inbox" ? activeTab.entityId : null;
	const show = (inboxId: string) => openTab({ type: "inbox", entityId: inboxId });

	// The engine lists inboxes in map order, which is not stable across polls -
	// so both the switcher's entries and the fallback below order by port. An
	// inbox record carries no creation stamp and does not gain one - #555
	// answered that - and port is the stable key the record has.
	const ordered = [...inboxes].sort((a, b) => a.port - b.port);

	// Derived, not synced into state: the engine is the list of inboxes, and an
	// address it no longer has falls back to the first one it does. An effect
	// writing that fallback back into the tab would say the same thing one
	// render later, and be wrong for that render.
	const inbox: Inbox | null =
		inboxes.find((i) => i.inboxId === addressedInboxId) ?? ordered[0] ?? null;

	const capturesQuery = useInboxCapturesQuery(inbox?.inboxId ?? null);
	const captures = capturesQuery.data?.data ?? [];
	const capturesTotal = capturesQuery.data?.pagination.total ?? 0;
	const hasMoreCaptures = capturesQuery.data?.pagination.hasMore === true;
	const loadMore = useLoadMoreInboxCapturesMutation();
	const live = useInboxLive(inbox?.inboxId ?? null, inbox?.running === true);

	const selectedCaptureId =
		selection !== null && selection.inboxId === inbox?.inboxId ? selection.captureId : null;
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

	/**
	 * One error discipline for the whole inbox lifecycle (issue #555, item 7).
	 *
	 * Start, update, delete and the drawer's own stop all toasted their failure;
	 * this tab's Stop and Clear passed no `onError` at all, so a refused stop
	 * left a button that had visibly done nothing and no reason anywhere. Taken
	 * here rather than in #556's tab pass, which both issues name as the shared
	 * brush - whichever landed second was to skip it.
	 */
	const reportFailure = (fallback: string) => (mutationError: unknown) =>
		showToast(mutationError instanceof Error ? mutationError.message : fallback, "error");

	const start = () => {
		startInbox.mutate(
			{},
			{
				onSuccess: (started) => show(started.inboxId),
				onError: reportFailure("Could not start the inbox"),
			}
		);
	};

	const loadMoreCaptures = () => {
		if (!inbox) return;
		loadMore.mutate(
			// The offset is what is on screen: the stream has prepended everything
			// recorded since the last fetch, so the next unseen capture sits at
			// exactly this index (see the mutation's own note).
			{ inboxId: inbox.inboxId, offset: captures.length },
			{ onError: reportFailure("Could not load more captures") }
		);
	};

	const applyResponse = (response: Partial<InboxCannedResponse>) => {
		if (!inbox) return;
		updateResponse.mutate(
			{ inboxId: inbox.inboxId, response },
			{ onError: reportFailure("Could not update the response") }
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
					onClick={() => void copy(inbox.url, "Inbox URL")}
				>
					<Copy className="h-3.5 w-3.5" aria-hidden="true" />
				</Button>

				{!inbox.loopback && <NonLoopbackBadge bind={inbox.bind} />}
				<Badge variant="outline">
					{inbox.running ? (live.watching ? "Live" : "Running") : "Stopped"}
				</Badge>
				<NotifyOnCaptureToggle inboxId={inbox.inboxId} />

				{/* The tab's multi-inbox story, which it never had: with several
				    listeners running, this is the only way to reach one of them
				    without going back through the drawer. Absent for a single
				    inbox, where a switcher with one entry is just a control that
				    does nothing. */}
				{inboxes.length > 1 && (
					<Select value={inbox.inboxId} onValueChange={show}>
						<SelectTrigger className="h-7 w-auto gap-1 text-xs" aria-label="Inbox">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{ordered.map((option) => (
								<SelectItem key={option.inboxId} value={option.inboxId}>
									{`Port ${option.port}${option.running ? "" : " (stopped)"}`}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}

				<div className="ml-auto flex items-center gap-2">
					{/* Eraser, not the bin: Delete sits beside it and takes the
					    whole inbox, and two adjacent destructive controls sharing one
					    icon is how a listener gets deleted by someone meaning to empty
					    the list. */}
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							clearCaptures.mutate(inbox.inboxId, {
								onError: reportFailure("Could not clear the captures"),
							})
						}
						disabled={clearCaptures.isPending || captures.length === 0}
					>
						<Eraser className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
						Clear
					</Button>
					{inbox.running ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								stopInbox.mutate(inbox.inboxId, {
									onError: reportFailure("Could not stop the inbox"),
								})
							}
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
					{/* Last, and the only control here that ends the record rather than
					    the listener. Before it, a stopped inbox could only be left
					    behind (issue #553). */}
					<DeleteInboxButton inbox={inbox} listedTotal={capturesTotal} />
				</div>
			</header>

			{/* Keyed on what the engine is serving, so a change made elsewhere
			    re-seeds the drafts by remount rather than by an effect. */}
			<CannedResponseControls
				key={cannedResponseKey(inbox.inboxId, inbox.response)}
				response={inbox.response}
				pending={updateResponse.isPending}
				stopped={!inbox.running}
				onApply={applyResponse}
			/>

			{/*
			 * The stream stopped, not the listener - the inbox is still
			 * recording, this list has only stopped hearing about it. Saying so
			 * is the whole point: the badge alone would read "Running" forever
			 * and look like an inbox nothing is sending to (issue #506).
			 */}
			{live.stopped && (
				<div className="px-3 pt-2">
					<Callout
						severity="warning"
						title="Live updates stopped"
						action={
							<Button variant="outline" size="sm" onClick={live.resume}>
								<RotateCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
								Resume
							</Button>
						}
					>
						the reconnects were refused. Captures are still being recorded and this list
						will catch up on the ones it missed.
					</Callout>
				</div>
			)}

			<div className="flex min-h-0 flex-1">
				<aside className="flex w-72 min-h-0 shrink-0 flex-col border-r border-border">
					<div className="flex items-center justify-between px-3 py-2">
						<span className="text-xs font-medium text-muted-foreground">Captured</span>
						<Badge variant="outline">{capturesTotal}</Badge>
					</div>
					{/* What the list is showing against what the inbox holds. The
					    surface fetched one page and said nothing about the rest, so
					    an inbox at its retention ceiling showed the newest 50 and
					    read as an inbox that had received 50 (issue #556). */}
					{captures.length < capturesTotal && (
						<p className="px-3 pb-1 text-xs text-muted-foreground">
							Showing {captures.length} of {capturesTotal}
						</p>
					)}
					<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
						{captures.length === 0 ? (
							<EmptyState
								variant="inline"
								title="Nothing received yet. Point a webhook at the URL above."
							/>
						) : (
							<>
								{captures.map((capture) => (
									<CaptureRow
										key={capture.id}
										capture={capture}
										selected={selectedCapture?.id === capture.id}
										onSelect={() =>
											setSelection({
												inboxId: inbox.inboxId,
												captureId: capture.id,
											})
										}
									/>
								))}
								{hasMoreCaptures && (
									<Button
										variant="ghost"
										size="sm"
										className="mt-1 w-full"
										onClick={loadMoreCaptures}
										disabled={loadMore.isPending}
									>
										{loadMore.isPending ? "Loading…" : "Load more"}
									</Button>
								)}
							</>
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
