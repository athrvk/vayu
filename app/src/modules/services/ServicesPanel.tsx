/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Services drawer view (issue #502)
 *
 * Vayu runs *services* - listeners that keep going after you switch tabs - and
 * until this view each one arrived with its own ad-hoc entry point: the webhook
 * inbox through a single welcome tile, the OAuth mock issuer through curl and
 * nothing else. This is the one place that lists them, starts them, and hands
 * over the URLs they exist to give you.
 *
 * It is a drawer view rather than a tab because that is what the shell already
 * says navigation is - the Dock's left group switches drawer views, and a
 * service is a thing you consult while working in a request, not a document you
 * open. The inbox keeps its tab as the detail surface (a capture list needs the
 * width); an issuer has no detail surface, so its whole management fits a row
 * that expands plus one dialog, and no new TabType.
 *
 * Mock servers (#481) get a group here when they exist. There is deliberately
 * no placeholder for them: a group that lists nothing and can start nothing
 * teaches a reader less than its absence does.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, KeyRound, Plus, Square, Trash2 } from "lucide-react";
import {
	DrawerPanel,
	EmptyState,
	ErrorState,
	NonLoopbackBadge,
	TruncatedText,
} from "@/components/shared";
import {
	Badge,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	TooltipIconButton,
} from "@/components/ui";
import {
	useInboxesQuery,
	useMockIssuersQuery,
	useStartInboxMutation,
	useStopInboxMutation,
	useStopMockIssuerMutation,
	useUpdateMockIssuerMutation,
} from "@/queries";
import { useTabsStore, useToastStore } from "@/stores";
import { cn } from "@/lib/utils";
import type { Inbox, MockIssuer, MockIssuerFailureMode } from "@/types";
import { DeleteInboxDialog } from "@/modules/inbox/DeleteInboxDialog";
import { useInboxDeletion } from "@/modules/inbox/useInboxDeletion";
import { FAILURE_MODE_LABELS, failureModeSummary } from "./failure-modes";
import { NewIssuerDialog } from "./NewIssuerDialog";

/**
 * The running light, in the vocabulary the inbox header already uses.
 *
 * `success-text` rather than the bare status token for the same reason the
 * Dock's connection light uses it: as 12px text the indicator token misses AA,
 * and the dot inherits the accessible pair through `bg-current`.
 */
function StatusDot({ running }: { running: boolean }) {
	return (
		<span
			className={cn(
				"h-1.5 w-1.5 shrink-0 rounded-full bg-current",
				running ? "text-success-text" : "text-muted-foreground"
			)}
			aria-hidden="true"
		/>
	);
}

interface ServiceRowProps {
	/** What the row does when the row itself - or its activator - is clicked. */
	onActivate: () => void;
	/** Names the activator. Icon-only trailing controls carry their own. */
	activateLabel: string;
	running: boolean;
	children: React.ReactNode;
	/** Trailing controls: copy, stop, delete. */
	actions?: React.ReactNode;
	leading?: React.ReactNode;
}

/**
 * One service, as a drawer row.
 *
 * The row paints the hover fill and the activator stretches into it
 * (`self-stretch`), and the row delegates clicks that land on its own box -
 * both halves of the hit-area rule in `app/CLAUDE.md`. A row carrying trailing
 * buttons cannot be one big button, so without the pair the responsive area is
 * the label's own bounding box and the padding around it is dead.
 */
function ServiceRow({
	onActivate,
	activateLabel,
	running,
	children,
	actions,
	leading,
}: ServiceRowProps) {
	return (
		<div
			className="flex h-8 cursor-pointer items-center gap-1 px-3 hover:bg-muted/50"
			onClick={(e) => {
				if (e.target === e.currentTarget) onActivate();
			}}
		>
			{leading}
			<button
				type="button"
				onClick={onActivate}
				aria-label={activateLabel}
				className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left text-sm"
			>
				<StatusDot running={running} />
				{children}
			</button>
			{actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
		</div>
	);
}

interface ServiceGroupProps {
	title: string;
	/** The group's own create affordance - "New inbox", "New issuer…". */
	action?: React.ReactNode;
	children: React.ReactNode;
}

function ServiceGroup({ title, action, children }: ServiceGroupProps) {
	return (
		<section className="mb-4">
			<div className="flex items-center justify-between gap-1 px-3 py-1.5">
				<h3 className="text-xs tracking-wider text-muted-foreground">{title}</h3>
				{action}
			</div>
			{children}
		</section>
	);
}

/** `px-3 py-2 text-left`: a drawer group's line, not a centred pane. */
const GROUP_NOTE_CLASS = "px-3 py-2 text-left text-xs";

function useCopy() {
	const showToast = useToastStore((s) => s.showToast);
	return (value: string, what: string) => {
		void navigator.clipboard.writeText(value);
		showToast(`${what} copied`, "success");
	};
}

function InboxRow({ inbox }: { inbox: Inbox }) {
	const openTab = useTabsStore((s) => s.openTab);
	const showToast = useToastStore((s) => s.showToast);
	const copy = useCopy();
	const stopInbox = useStopInboxMutation();
	// No capture list on this surface, so the record's own count is all it knows.
	const deletion = useInboxDeletion(inbox);

	return (
		<>
			<ServiceRow
				running={inbox.running}
				// The tab is a singleton pointed at one inbox, so the row hands it the
				// id it names - without it the tab showed whichever inbox it had last
				// (in practice the first), and the row's label was a lie (issue #554).
				onActivate={() => openTab({ type: "inbox", entityId: inbox.inboxId })}
				activateLabel={`Open inbox on port ${inbox.port}`}
				actions={
					<>
						<TooltipIconButton
							label="Copy inbox URL"
							icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
							onClick={() => copy(inbox.url, "Inbox URL")}
						/>
						{inbox.running && (
							<TooltipIconButton
								label={`Stop inbox on port ${inbox.port}`}
								icon={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
								disabled={stopInbox.isPending}
								onClick={() =>
									stopInbox.mutate(inbox.inboxId, {
										onError: (error) =>
											showToast(
												error instanceof Error
													? error.message
													: "Could not stop the inbox",
												"error"
											),
									})
								}
							/>
						)}
						{/* On every row, running or not. A stopped inbox had no way off
						    this list at all before: it stayed until the engine process
						    exited, while the group's affordance minted more of them
						    (issue #553). Deleting a running one stops it on the way. */}
						<TooltipIconButton
							label={`Delete inbox on port ${inbox.port}`}
							icon={<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
							disabled={deletion.isDeleting}
							onClick={deletion.requestDelete}
						/>
					</>
				}
			>
				<TruncatedText className="font-mono text-xs">{inbox.url}</TruncatedText>
				{!inbox.loopback && <NonLoopbackBadge bind={inbox.bind} />}
				{!inbox.running && <span className="text-xs text-muted-foreground">Stopped</span>}
			</ServiceRow>
			<DeleteInboxDialog deletion={deletion} />
		</>
	);
}

/** One labelled URL inside an expanded issuer, with its copy control. */
function IssuerDetailRow({
	label,
	value,
	copyLabel,
	onCopy,
}: {
	label: string;
	value: string;
	copyLabel: string;
	onCopy: () => void;
}) {
	return (
		<div className="flex items-center gap-1 py-0.5">
			<span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
			<TruncatedText className="min-w-0 flex-1 font-mono text-xs">{value}</TruncatedText>
			<TooltipIconButton
				label={copyLabel}
				icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
				onClick={onCopy}
			/>
		</div>
	);
}

function IssuerRow({
	issuer,
	expanded,
	onToggle,
}: {
	issuer: MockIssuer;
	expanded: boolean;
	onToggle: () => void;
}) {
	const showToast = useToastStore((s) => s.showToast);
	const copy = useCopy();
	const stopIssuer = useStopMockIssuerMutation();
	const updateIssuer = useUpdateMockIssuerMutation();

	const setFailureMode = (failureMode: MockIssuerFailureMode) => {
		updateIssuer.mutate(
			{ issuerId: issuer.issuerId, update: { failureMode } },
			{
				onError: (error) =>
					showToast(
						error instanceof Error ? error.message : "Could not update the issuer",
						"error"
					),
			}
		);
	};

	return (
		<>
			<ServiceRow
				// Every listed issuer is running: stopping one drops it from the
				// engine's list rather than leaving a stopped record behind, which
				// is where this differs from an inbox.
				running
				onActivate={onToggle}
				activateLabel={`${expanded ? "Collapse" : "Expand"} issuer on port ${issuer.port}`}
				leading={
					expanded ? (
						<ChevronDown
							className="h-3 w-3 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					) : (
						<ChevronRight
							className="h-3 w-3 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					)
				}
				actions={
					<TooltipIconButton
						label={`Stop issuer on port ${issuer.port}`}
						icon={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
						disabled={stopIssuer.isPending}
						onClick={() =>
							stopIssuer.mutate(issuer.issuerId, {
								onError: (error) =>
									showToast(
										error instanceof Error
											? error.message
											: "Could not stop the issuer",
										"error"
									),
							})
						}
					/>
				}
			>
				<TruncatedText className="font-mono text-xs">{issuer.issuerUrl}</TruncatedText>
				{issuer.failureMode !== "none" && (
					<Badge variant="outline">{FAILURE_MODE_LABELS[issuer.failureMode]}</Badge>
				)}
			</ServiceRow>

			{expanded && (
				<div className="border-l-2 border-rule pl-2 ml-4 mr-1 mb-2">
					<IssuerDetailRow
						label="Token"
						value={issuer.tokenUrl}
						copyLabel="Copy token URL"
						onCopy={() => copy(issuer.tokenUrl, "Token URL")}
					/>
					<IssuerDetailRow
						label="Authorize"
						value={issuer.authorizeUrl}
						copyLabel="Copy authorize URL"
						onCopy={() => copy(issuer.authorizeUrl, "Authorize URL")}
					/>
					{/* The signing key is the whole point of the issuer being a mock:
					    it is the HS256 secret the service under test verifies the
					    minted tokens with. Copied, never displayed - a 32-character
					    secret in a 260px drawer is noise, and this one is offered as
					    a value to paste, not to read. */}
					<div className="flex items-center gap-1 py-0.5">
						<span className="w-16 shrink-0 text-xs text-muted-foreground">Key</span>
						<span className="min-w-0 flex-1 text-xs text-muted-foreground">
							HS256 shared secret
						</span>
						<TooltipIconButton
							label="Copy signing key"
							icon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
							onClick={() => copy(issuer.signingKey, "Signing key")}
						/>
					</div>

					<p className="py-1 text-xs text-muted-foreground">
						{failureModeSummary(issuer)}
					</p>

					{/* The one setting worth changing without a restart: flipping an
					    issuer into an error mode is how retry handling gets tested,
					    and the engine accepts it on a running listener. Expiry and
					    slowMs are also mutable but are configuration you decide when
					    you start one; this is the switch you throw mid-test. */}
					<label className="flex items-center gap-2 py-1">
						<span className="text-xs text-muted-foreground">Failure mode</span>
						<Select
							value={issuer.failureMode}
							onValueChange={(value) =>
								setFailureMode(value as MockIssuerFailureMode)
							}
							disabled={updateIssuer.isPending}
						>
							<SelectTrigger className="h-7 flex-1 text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(FAILURE_MODE_LABELS).map(([mode, label]) => (
									<SelectItem key={mode} value={mode}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</label>
				</div>
			)}
		</>
	);
}

export default function ServicesPanel() {
	const showToast = useToastStore((s) => s.showToast);
	const inboxesQuery = useInboxesQuery();
	const issuersQuery = useMockIssuersQuery();
	const startInbox = useStartInboxMutation();
	const [expandedIssuerId, setExpandedIssuerId] = useState<string | null>(null);
	const [newIssuerOpen, setNewIssuerOpen] = useState(false);

	const inboxes = inboxesQuery.data ?? [];
	const issuers = issuersQuery.data ?? [];

	/*
	 * Per group, and only while that group has nothing to show. Each list is its
	 * own query against its own engine routes, so one failing says nothing about
	 * the other - and TanStack keeps the last good data through a failed
	 * background refetch, which is worth more than an error replacing a list the
	 * user can still act on. Same rule the variables tree follows.
	 */
	const showInboxError = inboxesQuery.isError && inboxes.length === 0;
	const showIssuerError = issuersQuery.isError && issuers.length === 0;

	const start = () =>
		startInbox.mutate(
			{},
			{
				onError: (error) =>
					showToast(
						error instanceof Error ? error.message : "Could not start the inbox",
						"error"
					),
			}
		);

	return (
		<DrawerPanel title="Services">
			<div className="flex w-full flex-col py-2">
				<ServiceGroup
					title="Webhook inboxes"
					action={
						/* "New inbox", matching the issuer group's "New issuer", and a
						   Plus rather than a Play: this always mints a *new* listener,
						   and beside a stopped row a Play labelled "Start inbox" read
						   as "restart that one" (issue #553). Restart is deliberately
						   not a thing an inbox does - delete it and start another,
						   since the captures are what a restart would have to decide
						   about and this way the user decides instead. */
						<TooltipIconButton
							label="New inbox"
							icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
							disabled={startInbox.isPending}
							onClick={start}
						/>
					}
				>
					{showInboxError ? (
						<ErrorState
							variant="inline"
							title="Couldn't load the inboxes"
							className={cn("justify-start", GROUP_NOTE_CLASS)}
							onRetry={() => void inboxesQuery.refetch()}
						/>
					) : inboxes.length === 0 ? (
						<EmptyState
							variant="inline"
							className={GROUP_NOTE_CLASS}
							title="No inbox yet. Start one for a local URL that records every request sent to it - no tunnel, no third party."
						/>
					) : (
						inboxes.map((inbox) => <InboxRow key={inbox.inboxId} inbox={inbox} />)
					)}
				</ServiceGroup>

				<ServiceGroup
					title="OAuth issuers"
					action={
						<TooltipIconButton
							label="New issuer"
							icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
							onClick={() => setNewIssuerOpen(true)}
						/>
					}
				>
					{showIssuerError ? (
						<ErrorState
							variant="inline"
							title="Couldn't load the issuers"
							className={cn("justify-start", GROUP_NOTE_CLASS)}
							onRetry={() => void issuersQuery.refetch()}
						/>
					) : issuers.length === 0 ? (
						<EmptyState
							variant="inline"
							className={GROUP_NOTE_CLASS}
							title="No issuer running. Start one to mint your own OAuth 2.0 tokens locally, with the claims and failures you choose."
						/>
					) : (
						issuers.map((issuer) => (
							<IssuerRow
								key={issuer.issuerId}
								issuer={issuer}
								expanded={expandedIssuerId === issuer.issuerId}
								onToggle={() =>
									setExpandedIssuerId((current) =>
										current === issuer.issuerId ? null : issuer.issuerId
									)
								}
							/>
						))
					)}
				</ServiceGroup>
			</div>

			{newIssuerOpen && (
				<NewIssuerDialog onOpenChange={setNewIssuerOpen} onStarted={setExpandedIssuerId} />
			)}
		</DrawerPanel>
	);
}
