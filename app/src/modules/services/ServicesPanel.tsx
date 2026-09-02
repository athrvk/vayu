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
 * Mock servers (#481 phase 2) are the third group. Unlike the other two it has
 * no create affordance, and that is not an omission: a mock needs a collection
 * to serve, and this drawer has none selected. The collection header owns the
 * start (`CollectionDetail/MockServerControl`); this owns the list, so a mock
 * started from any collection - or from curl - can be found and stopped in the
 * one place every other running listener is.
 */

import { useEffect, useRef, useState } from "react";
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
	Input,
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
	useMockServerRoutesQuery,
	useMockServersQuery,
	useStartInboxMutation,
	useStopInboxMutation,
	useStopMockIssuerMutation,
	useStopMockServerMutation,
	useUpdateMockIssuerMutation,
} from "@/queries";
import { useTabsStore, useToastStore } from "@/stores";
import { useCopy } from "@/hooks";
import { TIMING } from "@/config/timing";
import { cn } from "@/lib/utils";
import type { Inbox, MockIssuer, MockIssuerFailureMode, MockServer } from "@/types";
import { DeleteInboxDialog } from "@/modules/inbox/DeleteInboxDialog";
import { useInboxDeletion } from "@/modules/inbox/useInboxDeletion";
import { FAILURE_MODE_LABELS, MAX_SLOW_MS, failureModeSummary } from "./failure-modes";
import { NewIssuerDialog } from "./NewIssuerDialog";

/**
 * The running light, in the vocabulary the inbox header already uses.
 *
 * `status-success-text` rather than the bare status token for the same reason
 * the Dock's connection light uses it: as 12px text the indicator token misses
 * AA, and the dot inherits the accessible pair through `bg-current`. A service
 * that is listening is a run state, so it takes the `--status-*` family; this
 * dot moves with the Dock's light, since it exists to say the same thing.
 */
function StatusDot({ running }: { running: boolean }) {
	return (
		<span
			className={cn(
				"h-1.5 w-1.5 shrink-0 rounded-full bg-current",
				running ? "text-status-success-text" : "text-muted-foreground"
			)}
			aria-hidden="true"
		/>
	);
}

interface ServiceRowProps {
	/** What the row does when the row itself - or its activator - is clicked. */
	onActivate: () => void;
	/** The verb, prefixed to the row's own content to name the activator. */
	actionLabel: string;
	running: boolean;
	children: React.ReactNode;
	/** Trailing controls: copy, stop, delete. */
	actions?: React.ReactNode;
	leading?: React.ReactNode;
	/** Highlights the row - a just-created service, so the eye can find it. */
	flashed?: boolean;
}

/**
 * One service, as a drawer row.
 *
 * The row paints the hover fill and the activator stretches into it
 * (`self-stretch`), and the row delegates clicks that land on its own box -
 * both halves of the hit-area rule in `app/CLAUDE.md`. A row carrying trailing
 * buttons cannot be one big button, so without the pair the responsive area is
 * the label's own bounding box and the padding around it is dead.
 *
 * **The verb is `sr-only` text, not an `aria-label`.** A label *replaces* the
 * element's content when the accessible name is computed, so "Open inbox on
 * port 41234" silenced everything the row actually says - the URL, "Stopped",
 * the reachable-beyond-this-machine badge, an issuer's failure mode. A screen
 * reader heard a row that could not be stopped and a row that could as the same
 * row. Prefixing instead composes the two: the verb, then the content, in the
 * order they are read on screen.
 */
function ServiceRow({
	onActivate,
	actionLabel,
	running,
	children,
	actions,
	leading,
	flashed,
}: ServiceRowProps) {
	return (
		<div
			className={cn(
				"flex h-8 cursor-pointer items-center gap-1 px-3 hover:bg-muted/50",
				// Not a selection - the drawer has none - so a background tint
				// rather than the accent fill a selected row would carry.
				flashed && "bg-primary/10"
			)}
			onClick={(e) => {
				if (e.target === e.currentTarget) onActivate();
			}}
		>
			{leading}
			<button
				type="button"
				onClick={onActivate}
				className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left text-sm"
			>
				<span className="sr-only">{actionLabel}</span>
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

function InboxRow({ inbox, flashed }: { inbox: Inbox; flashed: boolean }) {
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
				flashed={flashed}
				// The tab is a singleton pointed at one inbox, so the row hands it the
				// id it names - without it the tab showed whichever inbox it had last
				// (in practice the first), and the row's label was a lie (issue #554).
				onActivate={() => openTab({ type: "inbox", entityId: inbox.inboxId })}
				actionLabel="Open inbox"
				actions={
					<>
						{/* The URL rides the tooltip rather than the name: the name is
						    what a screen reader reads on every row, and three inboxes
						    would be three near-identical 30-character strings. A
						    stopped inbox says so here too - the URL copies fine and
						    then refuses connections, a long way from the cause. */}
						<TooltipIconButton
							label="Copy inbox URL"
							tooltipHint={
								inbox.running ? inbox.url : `${inbox.url} - stopped, not listening`
							}
							icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
							onClick={() => void copy(inbox.url, "Inbox URL")}
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
				{/* The port is what distinguishes one inbox from another and the
				    only part of the URL that varies, so it leads. The URL stays
				    visible but demoted - it is the value you copy, not the one you
				    read a list by, and a column of `http://127.0.0.1:4123x/` in
				    mono was three rows that looked identical. */}
				<span className="shrink-0 text-xs">Port {inbox.port}</span>
				<TruncatedText className="font-mono text-xs text-muted-foreground">
					{inbox.url}
				</TruncatedText>
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

	const update = (patch: { failureMode?: MockIssuerFailureMode; slowMs?: number }) => {
		updateIssuer.mutate(
			{ issuerId: issuer.issuerId, update: patch },
			{
				onError: (error) =>
					showToast(
						error instanceof Error ? error.message : "Could not update the issuer",
						"error"
					),
			}
		);
	};

	const setFailureMode = (failureMode: MockIssuerFailureMode) => update({ failureMode });

	return (
		<>
			<ServiceRow
				// Every listed issuer is running: stopping one drops it from the
				// engine's list rather than leaving a stopped record behind, which
				// is where this differs from an inbox.
				running
				onActivate={onToggle}
				actionLabel={`${expanded ? "Collapse" : "Expand"} issuer on port ${issuer.port}`}
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

			{/* `surface-sunken`, not a bare `border-rule`: a rule inherits the
			    `--rule` its enclosing surface declares, and no drawer surface
			    declares one - so this fell back to the canvas default, which on
			    `--panel` in dark measures 1.07 and is simply not there. Sunken is
			    also what this is: the nested detail slab of the row above, the
			    same treatment the settings cookie rows and the console panes use. */}
			{expanded && (
				<div className="surface-sunken rounded-md border-l-2 border-rule pl-2 ml-4 mr-1 mb-2">
					<IssuerDetailRow
						label="Token"
						value={issuer.tokenUrl}
						copyLabel="Copy token URL"
						onCopy={() => void copy(issuer.tokenUrl, "Token URL")}
					/>
					<IssuerDetailRow
						label="Authorize"
						value={issuer.authorizeUrl}
						copyLabel="Copy authorize URL"
						onCopy={() => void copy(issuer.authorizeUrl, "Authorize URL")}
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
							onClick={() => void copy(issuer.signingKey, "Signing key")}
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

					{/* Slow is the one mode with a parameter, and the switch above
					    offered no way to see or set it: the issuer answered after
					    whatever `slowMs` it was *started* with, the summary line
					    reported that number, and the engine's `PUT` had accepted a
					    new one all along. Shown only in the mode that reads it -
					    outside `slow` the value is one the issuer never consults. */}
					{issuer.failureMode === "slow" && (
						<IssuerDelayControl
							// Keyed on what the engine is serving, so a value changed
							// elsewhere (an MCP tool, a curl) re-seeds the draft by
							// remount rather than by an effect - the same way
							// `CannedResponseControls` is keyed in the inbox tab.
							key={issuer.slowMs}
							issuerId={issuer.issuerId}
							slowMs={issuer.slowMs}
							pending={updateIssuer.isPending}
							onApply={(slowMs) => update({ slowMs })}
						/>
					)}
				</div>
			)}
		</>
	);
}

/**
 * The delay `slow` mode answers after.
 *
 * Committed on blur and on Enter rather than per keystroke: every character of
 * "2000" is a valid number, so a live-committing field would send 2, then 20,
 * then 200 - three `PUT`s reconfiguring a running listener on the way to the
 * one the user meant. An out-of-range value is refused here with the bound
 * named, because the engine answers it with a `400 mock_issuer_invalid_config`
 * that says nothing about which field.
 */
function IssuerDelayControl({
	issuerId,
	slowMs,
	pending,
	onApply,
}: {
	issuerId: string;
	slowMs: number;
	pending: boolean;
	onApply: (slowMs: number) => void;
}) {
	const [draft, setDraft] = useState(String(slowMs));
	const value = Number(draft);
	const valid = Number.isInteger(value) && value >= 0 && value <= MAX_SLOW_MS;
	const errorId = `issuer-${issuerId}-slow-error`;

	const commit = () => {
		if (!valid || value === slowMs) return;
		onApply(value);
	};

	return (
		<div className="py-1">
			<label className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground">Delay</span>
				<Input
					type="number"
					min={0}
					max={MAX_SLOW_MS}
					step={100}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === "Enter") commit();
					}}
					disabled={pending}
					aria-invalid={!valid}
					aria-describedby={valid ? undefined : errorId}
					className="h-7 flex-1 text-xs"
				/>
				<span className="text-xs text-muted-foreground">ms</span>
			</label>
			{!valid && (
				<p id={errorId} className="pt-1 text-xs text-destructive-text">
					{`A whole number of milliseconds, 0 to ${MAX_SLOW_MS}.`}
				</p>
			)}
		</div>
	);
}

/**
 * One running mock server, expanding to the table it is serving.
 *
 * The route table is the answer to the only question this surface gets asked -
 * "why did the mock 404 that?" - and it is a start-time snapshot, so it is
 * fetched once when the row is opened rather than polled. A row that carried
 * only a URL would leave the user sending requests to find out what the mock
 * knows about.
 */
function MockServerRow({
	mock,
	expanded,
	onToggle,
}: {
	mock: MockServer;
	expanded: boolean;
	onToggle: () => void;
}) {
	const showToast = useToastStore((s) => s.showToast);
	const copy = useCopy();
	const stopMock = useStopMockServerMutation();
	const routesQuery = useMockServerRoutesQuery(expanded ? mock.mockId : null);
	const routes = routesQuery.data ?? [];

	return (
		<>
			<ServiceRow
				// Every listed mock is running: stopping one drops it from the
				// engine's list rather than leaving a stopped record, since a mock
				// holds nothing that outlives its listener. Same as an issuer,
				// unlike an inbox and its captures.
				running
				onActivate={onToggle}
				actionLabel={`${expanded ? "Collapse" : "Expand"} mock server on port ${mock.port}`}
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
					<>
						<TooltipIconButton
							label="Copy mock server URL"
							tooltipHint={mock.url}
							icon={<Copy className="h-3.5 w-3.5" aria-hidden="true" />}
							onClick={() => void copy(mock.url, "Mock server URL")}
						/>
						<TooltipIconButton
							label={`Stop mock server on port ${mock.port}`}
							icon={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
							disabled={stopMock.isPending}
							onClick={() =>
								stopMock.mutate(mock.mockId, {
									onError: (error) =>
										showToast(
											error instanceof Error
												? error.message
												: "Could not stop the mock server",
											"error"
										),
								})
							}
						/>
					</>
				}
			>
				{/* The collection is what distinguishes one mock from another -
				    two mocks of one collection differ only by port, and a column
				    of near-identical loopback URLs is what the inbox rows learned
				    not to lead with. */}
				<TruncatedText className="text-xs">{mock.collectionName}</TruncatedText>
				<span className="shrink-0 text-xs text-muted-foreground">Port {mock.port}</span>
			</ServiceRow>

			{expanded && (
				<div className="surface-sunken rounded-md border-l-2 border-rule pl-2 ml-4 mr-1 mb-2">
					<IssuerDetailRow
						label="Base URL"
						value={mock.url}
						copyLabel="Copy mock server URL"
						onCopy={() => void copy(mock.url, "Mock server URL")}
					/>
					<p className="py-1 text-xs text-muted-foreground">
						{mock.latencyMs > 0 ? `${mock.latencyMs}ms latency` : "No added latency"}
						{mock.errorRatePct > 0 && `, ${mock.errorRatePct}% of answers fail`}
						{mock.routesWithoutExample > 0 &&
							`, ${mock.routesWithoutExample} of ${mock.routeCount} routes have no example`}
					</p>
					{routesQuery.isError ? (
						<ErrorState
							variant="inline"
							title="Couldn't load the routes"
							className={cn("justify-start", GROUP_NOTE_CLASS)}
							onRetry={() => void routesQuery.refetch()}
						/>
					) : (
						<ul className="max-h-48 overflow-y-auto py-1">
							{routes.map((route) => (
								<li
									key={`${route.method} ${route.path} ${route.requestId}`}
									className="flex items-center gap-1.5 py-0.5"
								>
									<span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">
										{route.method}
									</span>
									<TruncatedText className="min-w-0 flex-1 font-mono text-xs">
										{route.path}
									</TruncatedText>
									{/* A route with no example answers 501, so it is
									    marked rather than listed as if it served. */}
									<span className="shrink-0 text-[11px] text-muted-foreground">
										{route.hasExample ? route.status : "no example"}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</>
	);
}

/**
 * Which row was just created, for as long as it takes to notice it.
 *
 * Creating an inbox reported nothing at all: the mutation carried an `onError`
 * and no `onSuccess`, and the new row landed wherever its ephemeral port sorted
 * rather than at the end, so the only evidence a click had done anything was a
 * row count nobody was counting. The timer is cleared on unmount and restarted
 * per flash, so switching drawer views mid-flash leaves nothing running.
 */
function useRowFlash() {
	const [flashedId, setFlashedId] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

	const flash = (id: string) => {
		clearTimeout(timer.current ?? undefined);
		setFlashedId(id);
		timer.current = setTimeout(() => setFlashedId(null), TIMING.ROW_FLASH_MS);
	};

	return { flashedId, flash };
}

export default function ServicesPanel() {
	const showToast = useToastStore((s) => s.showToast);
	const inboxesQuery = useInboxesQuery();
	const issuersQuery = useMockIssuersQuery();
	const mocksQuery = useMockServersQuery();
	const startInbox = useStartInboxMutation();
	const [expandedIssuerId, setExpandedIssuerId] = useState<string | null>(null);
	const [expandedMockId, setExpandedMockId] = useState<string | null>(null);
	const [newIssuerOpen, setNewIssuerOpen] = useState(false);
	const { flashedId: flashedInboxId, flash: flashInbox } = useRowFlash();

	const inboxes = inboxesQuery.data ?? [];
	const issuers = issuersQuery.data ?? [];
	const mocks = mocksQuery.data ?? [];

	/*
	 * Per group, and only while that group has nothing to show. Each list is its
	 * own query against its own engine routes, so one failing says nothing about
	 * the other - and TanStack keeps the last good data through a failed
	 * background refetch, which is worth more than an error replacing a list the
	 * user can still act on. Same rule the variables tree follows.
	 */
	const showInboxError = inboxesQuery.isError && inboxes.length === 0;
	const showIssuerError = issuersQuery.isError && issuers.length === 0;
	const showMockError = mocksQuery.isError && mocks.length === 0;

	/*
	 * By port. The engine lists inboxes in map order, which is not stable across
	 * polls, so a row could move while being read and a new one arrived
	 * anywhere. The record carries no creation stamp - checked, and #555's
	 * decision is that it does not gain one (see the module doc) - and port is
	 * the stable key it does have. Same ordering the inbox tab's switcher uses,
	 * so the two lists cannot disagree about what order inboxes are in.
	 */
	const orderedInboxes = [...inboxes].sort((a, b) => a.port - b.port);
	// Same rule, same reason: the engine lists mocks in map order too, and
	// `createdAt` would reorder the list every time one is restarted.
	const orderedMocks = [...mocks].sort((a, b) => a.port - b.port);

	const start = () =>
		startInbox.mutate(
			{},
			{
				onSuccess: (started) => {
					showToast(`Inbox started on port ${started.port}`, "success");
					flashInbox(started.inboxId);
				},
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
						orderedInboxes.map((inbox) => (
							<InboxRow
								key={inbox.inboxId}
								inbox={inbox}
								flashed={inbox.inboxId === flashedInboxId}
							/>
						))
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

				{/* No create affordance: a mock needs a collection to serve, and
				    this drawer has none selected. The collection header starts
				    one; this is where every running mock can be found. */}
				<ServiceGroup title="Mock servers">
					{showMockError ? (
						<ErrorState
							variant="inline"
							title="Couldn't load the mock servers"
							className={cn("justify-start", GROUP_NOTE_CLASS)}
							onRetry={() => void mocksQuery.refetch()}
						/>
					) : mocks.length === 0 ? (
						<EmptyState
							variant="inline"
							className={GROUP_NOTE_CLASS}
							title="No mock running. Open a collection and start one to serve its saved example responses on a local URL - a free upstream to build or load-test against."
						/>
					) : (
						orderedMocks.map((mock) => (
							<MockServerRow
								key={mock.mockId}
								mock={mock}
								expanded={expandedMockId === mock.mockId}
								onToggle={() =>
									setExpandedMockId((current) =>
										current === mock.mockId ? null : mock.mockId
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
