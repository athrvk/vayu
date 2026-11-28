/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The HTTP response: status band, metadata, and sub-tabs for body (through the shared ResponseBody,
 * Pretty/Raw/Preview), headers, cookies, timing, console, tests, events and the raw exchange.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { BookmarkPlus, Loader2, Send } from "lucide-react";
import { formatBytes } from "@/lib/format-number";
import { cn } from "@/lib/utils";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	TabLabel,
	TabCount,
	TabErrorDot,
	Badge,
	Button,
	DisabledHint,
	Kbd,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../context";
import { useExecutionEventsStore } from "@/stores";
import { useTabSelectionStore } from "@/stores/tab-selection-store";
import { chordKeys } from "@/lib/platform";
import { SEND_CHORD } from "@/constants/shortcuts";
import { TIMING } from "@/config/timing";
import { useHeldValue } from "@/hooks/useHeldValue";
import {
	ResponseBody as SharedResponseBody,
	McpResultView,
	ResponseStatusBar,
	ResponseActions,
	ResponseHeadersPanel,
	ResponseEvents,
	elapsedBetween,
} from "@/components/shared/response-viewer";
import { Callout, EmptyState, ExchangeWarnings } from "@/components/shared";
import ResponseCookies from "./ResponseCookies";
import ResponseTimingTab from "./ResponseTimingTab";
import ConsoleOutput from "./ConsoleOutput";
import { consoleRowCount } from "./console/console-rows";
import SchemaValidation from "./SchemaValidation";
import ElementOutcomes from "./ElementOutcomes";
import TestResults from "./TestResults";
import RawRequestResponse from "./RawRequestResponse";
import ClientErrorView from "./ClientErrorView";
import SaveAsExampleDialog from "./SaveAsExampleDialog";
import SendingWave from "./SendingWave";
import StepUpNotice from "./StepUpNotice";
import { TabOverflowMenu } from "@/components/layout/TabOverflowMenu";
import { useFittedTabs } from "@/components/layout/useFittedTabs";
import { MARK_ALLOWANCE } from "@/components/layout/tab-fit";
import type { ResponseState, ResponseTab } from "../../types";
import { streamPatch } from "../../utils/auto-header";
import {
	cappedReadExtent,
	contentTypeOf,
	heldBodySize,
	isEventStreamType,
	receivedBody,
} from "../../utils/response-bytes";
import { exampleRefusal } from "./save-as-example";
import { resolveHeaderLines } from "@/lib/header-lines";

/**
 * The eight sub-tabs. One list per order: the fit measures these labels and the strip draws these
 * triggers, so no tab is drawn unmeasured. Always all eight, whatever the response carries (#59's
 * constant set): a normal response gets an honest "not an event stream". Only the order moves: a
 * stream puts Events after Body, since it opens there and the strip overflows from the right, where
 * Events' usual seventh place would be first into the "+N" menu (#3691).
 */
const EVENTS_TAB = { id: "events", label: "Events" } as const;
const RESPONSE_TABS: readonly { id: ResponseTab; label: string }[] = [
	{ id: "body", label: "Body" },
	{ id: "headers", label: "Headers" },
	{ id: "cookies", label: "Cookies" },
	{ id: "timing", label: "Timing" },
	{ id: "console", label: "Console" },
	{ id: "tests", label: "Tests" },
	EVENTS_TAB,
	{ id: "raw-request", label: "Raw" },
];
const STREAM_RESPONSE_TABS = RESPONSE_TABS.flatMap((t) => {
	if (t === EVENTS_TAB) return [];
	return t.id === "body" ? [t, EVENTS_TAB] : [t];
});

/** The tabs in strip order, with the parallel lists the fit reads; one object per order so identities are stable. */
function tabSet(tabs: readonly { id: ResponseTab; label: string }[]) {
	return { tabs, ids: tabs.map((t) => t.id), labels: tabs.map((t) => t.label) };
}
const DEFAULT_TAB_SET = tabSet(RESPONSE_TABS);
const STREAM_TAB_SET = tabSet(STREAM_RESPONSE_TABS);
const responseTabSet = (streamView: boolean) => (streamView ? STREAM_TAB_SET : DEFAULT_TAB_SET);

/** What each tab's mark may grow to, so a badge arriving after the fit still fits. */
const RESPONSE_MARK_ALLOWANCE: Partial<Record<ResponseTab, number>> = {
	headers: MARK_ALLOWANCE.count,
	console: MARK_ALLOWANCE.count,
	tests: MARK_ALLOWANCE.chip,
	events: MARK_ALLOWANCE.wideCount,
};
const responseMarkAllowance = (id: ResponseTab) =>
	RESPONSE_MARK_ALLOWANCE[id] ?? MARK_ALLOWANCE.none;

/**
 * The Tests tab's pass/fail chip, in a track that costs nothing at rest. A result, not a count: it
 * stays a `Badge`, not a `TabCount`, and says nothing when nothing ran ("0/0" reads as a result).
 * It must not arrive by a jump: the trigger is `shrink-0` in a `flex-nowrap` list, so a chip widens
 * it by its width plus `gap-1.5` and pushes the tabs after Tests (Events and Raw, or Raw for a
 * stream), drawing the strip two ways under a moving pointer.
 *
 * `MARK_TRACK`'s fix in `tabs.tsx` (for `TabCount`, `TabErrorDot`): a
 * `grid-template-columns: 0fr -> 1fr` track, truly zero wide when empty (cancelling the trigger's
 * leading `gap-1.5` via `-ms-1.5`/`ms-0`), animating open to the chip's width.
 *
 * **Unlike `TabCount`, the `Badge` does not stay mounted empty.** An empty `TabCount` cell is bare
 * text, invisible; a `Badge` always paints an opaque `bg-*` fill, so a track not quite collapsed
 * (or a rounding residual from its padding) would leave a solid speck by "Tests" on every response
 * without tests. So it mounts only with a result, as `TabErrorDot` does, with its own `starting:`
 * opacity fade-in. Unmounting is held by one fade (`useHeldValue`, `TIMING.MARK_FADE_MS`), the
 * mirror of that fade-in, as `TabCount` and the Dock's save line do; then it leaves the tree, so
 * nothing is mounted at rest.
 */
function TestsResultChip({ results }: { results: readonly { passed: boolean }[] }) {
	const passed = results.filter((t) => t.passed).length;
	const hasResults = results.length > 0;
	/*
	 * The chip's content as one string, since `useHeldValue` holds a primitive: `results` is a
	 * fresh `[]` each render of a test-less response, so an array never settles. The track reads
	 * `hasResults` and collapses on time; the `Badge` reads `shown` and survives one fade past it.
	 */
	const { shown, fading } = useHeldValue(
		hasResults ? `${passed}/${results.length}` : null,
		TIMING.MARK_FADE_MS
	);
	// Tone from the held label, not `results`: on the way out there are no results left, and a
	// green chip must not turn red in its last frames.
	const allPassed = shown !== null && shown.split("/")[0] === shown.split("/")[1];

	return (
		<span
			data-slot="tests-result-chip"
			className={cn(
				"grid overflow-hidden transition-[grid-template-columns,margin-inline-start] duration-150 ease-out",
				hasResults ? "grid-cols-[1fr] ms-0" : "grid-cols-[0fr] -ms-1.5"
			)}
		>
			{shown !== null && (
				<Badge
					variant={allPassed ? "default" : "destructive"}
					className={cn(
						"starting:opacity-0 transition-opacity duration-150 h-4 min-w-0 px-1 text-micro",
						fading ? "opacity-0" : "opacity-100"
					)}
				>
					{shown}
				</Badge>
			)}
		</span>
	);
}

export default function ResponseViewer() {
	const { request, response, isExecuting, setRequest } = useRequestBuilderContext();
	const requestId = request.id ?? null;

	/*
	 * The chosen sub-tab, kept per request id so it survives `Shell.tsx` unmounting this pane when
	 * its workspace tab is hidden, and switching request tabs, which reuses this component
	 * (`request.id` changes under one `useState`). `null` is "no choice yet"; `activeTab` below is
	 * shown then.
	 */
	const getResponseTab = useTabSelectionStore((s) => s.getResponseTab);
	const setResponseTab = useTabSelectionStore((s) => s.setResponseTab);
	const [chosenTab, setChosenTab] = useState<ResponseTab | null>(() =>
		requestId ? getResponseTab(requestId) : null
	);
	const setActiveTab = useCallback(
		(tab: ResponseTab) => {
			setChosenTab(tab);
			if (requestId) setResponseTab(requestId, tab);
		},
		[requestId, setResponseTab]
	);
	/*
	 * The `useState` initializer runs once, for the first request rendered; a later one shown
	 * without a remount needs this render-time sync (as `RequestBuilderProvider`'s per-request
	 * reset does), so the previous request's tab never paints under the new one.
	 */
	const [tabSyncedFor, setTabSyncedFor] = useState(requestId);
	if (requestId !== tabSyncedFor) {
		setTabSyncedFor(requestId);
		setChosenTab(requestId ? getResponseTab(requestId) : null);
	}

	/*
	 * The live stream, when it is this request's (#574), selected against the request on screen as
	 * the provider does: one builder serves every request tab, so another's stream must not show
	 * here.
	 */
	const streamIsMine = useExecutionEventsStore(
		(s) => !!s.requestId && !!requestId && s.requestId === requestId
	);
	const liveOpen = useExecutionEventsStore((s) => s.open);
	const liveLeftOut = useExecutionEventsStore((s) => s.leftOut);
	const liveSentAt = useExecutionEventsStore((s) => s.sentAt);
	const liveEvents = useExecutionEventsStore((s) => s.events);
	const liveStreamText = useExecutionEventsStore((s) => s.streamText);
	const liveErrorCount = useExecutionEventsStore((s) => s.errorCount);
	// The stream's identity, for the Events window: the list grows in place, so the window resets
	// when the stream changes, not when a batch lands (#1158).
	const liveRunId = useExecutionEventsStore((s) => s.runId);
	const liveIsStreaming = useExecutionEventsStore((s) => s.isStreaming);
	const liveEndReason = useExecutionEventsStore((s) => s.endReason);
	const liveTotalEvents = useExecutionEventsStore((s) => s.totalEvents);
	const liveError = useExecutionEventsStore((s) => s.error);

	const isStreaming = streamIsMine && liveIsStreaming;

	/*
	 * Separates "not a stream" from "a stream with no events yet", true for either source (a
	 * restored trace with an `events` node, or this request's live feed). It stays true after the
	 * stream ends, so it words `ResponseEvents`' empty state; it does not pick the default tab
	 * (`streamView`).
	 */
	const isStream = response?.events !== undefined || streamIsMine;

	/*
	 * Whether the pane shows a stream, deciding the default tab and strip order (#3691). A landed
	 * response says so by its `events` node; with none yet, the store's feed is on screen (live, or
	 * ended with its run on the way), so it is a stream if the store holds this request's. Not
	 * `isStream`: `streamIsMine` outlives the stream (the store keeps the id until replaced), and
	 * an ordinary Send after a stream lands a response without `events`, which must read as
	 * ordinary.
	 */
	const streamView = response ? response.events !== undefined : streamIsMine;

	/*
	 * An unchosen tab opens on Events for a stream, Body otherwise. Derived each render, never
	 * stored: it is a default, not a choice, so a later ordinary response still opens on Body.
	 */
	const activeTab: ResponseTab = chosenTab ?? (streamView ? "events" : "body");
	const strip = responseTabSet(streamView);

	const [savingExample, setSavingExample] = useState(false);

	// Called before the early returns, which would skip it; the wrapper it measures exists once
	// there is a response. Labels and triggers are the one `strip`.
	const { containerRef, visibleIds, overflowedIds } = useFittedTabs({
		ids: strip.ids,
		labels: strip.labels,
		activeId: activeTab,
		markAllowance: responseMarkAllowance,
	});

	/*
	 * A stream has no exchange until its headers arrive, so the pane gets one built from the
	 * relay's `open` frame (status, status text, headers: all the engine knows then), only without
	 * a stored response: when the stream ends the provider swaps in the run's record. Never
	 * persisted: it describes a running stream, and the durable copy is the finished run's.
	 */
	const streamedResponse = useMemo<ResponseState | null>(() => {
		if (response || !streamIsMine || !liveOpen) return null;
		return {
			status: liveOpen.statusCode,
			statusText: liveOpen.statusText,
			headers: liveOpen.headers,
			// No `headerLines`: the `open` frame carries the folded map alone, and absence is what
			// the tabs read as "show the map" (`resolveHeaderLines`).
			body: "",
			size: 0,
			time: 0,
			...(liveSentAt !== null ? { sentAt: liveSentAt } : {}),
			...(liveLeftOut.length > 0 ? { leftOutElements: liveLeftOut } : {}),
		};
	}, [response, streamIsMine, liveOpen, liveSentAt, liveLeftOut]);

	const shown = response ?? streamedResponse;

	/*
	 * Another request's stream took this one's live feed (#3352). Its run was not stopped, so the
	 * pane says where it went instead of "No response yet"; gone once the pane shows that run's
	 * record.
	 */
	const replacedRunId = useExecutionEventsStore((s) =>
		requestId ? s.replacedFeeds[requestId]?.runId : undefined
	);
	const feedNotice = !!replacedRunId && shown?.restoredFrom?.runId !== replacedRunId && (
		<div className="px-4 pt-3 shrink-0">
			<Callout severity="info" title="Live feed taken over">
				Another request&apos;s stream took over the live feed. This request&apos;s stream
				kept running in Vayu&apos;s engine, and History shows its events once it ends.
			</Callout>
		</div>
	);

	/*
	 * The loading state, **only with nothing on screen to keep**: replacing the pane on every send
	 * erased the status, headers and body the user was reading until the new ones landed. The
	 * "Loading" rule (docs/design-system/component-patterns.md) puts an in-place action's spinner
	 * on *that control* (Send relabels itself Sending), and a re-send keeps the previous exchange,
	 * marked stale (`busy` below). Left here: the first send for a request, and a stream accepted
	 * but without headers yet (the send is over, `isExecuting` cleared, no exchange to draw).
	 */
	if (!shown && (isExecuting || isStreaming)) {
		return (
			<div className="flex-1 flex items-center justify-center bg-panel">
				<div className="text-center space-y-4">
					<Loader2 className="size-icon animate-spin mx-auto text-primary" />
					<p className="text-xs text-muted-foreground">
						{isStreaming ? "Opening the event stream…" : "Sending request…"}
					</p>
				</div>
			</div>
		);
	}

	if (!shown) {
		const empty = (
			<EmptyState
				className="bg-panel"
				icon={Send}
				title="No response yet"
				description={
					<span className="inline-flex items-center justify-center gap-1.5">
						<span>Press</span>
						{chordKeys(SEND_CHORD).map((cap) => (
							<Kbd key={cap}>{cap}</Kbd>
						))}
						<span>or click Send.</span>
					</span>
				}
			/>
		);
		if (!feedNotice) return empty;
		return (
			<div className="flex-1 flex flex-col min-h-0 bg-panel">
				{feedNotice}
				{empty}
			</div>
		);
	}

	/*
	 * A send in flight over an exchange already on screen. The layout holds: the exchange recedes
	 * to 60% and nothing changes size or position, so all stays readable and clickable, per the
	 * "Loading" rule (docs/design-system/component-patterns.md) and React Query's
	 * dim-the-previous-page pattern. `SendingWave` is the deliberate exception, a faint band over
	 * it, because a still dim read as inert (the doc explains); it is no live region. Without the
	 * wave, the dim lifting is the signal, so a byte-identical re-send does not look unfired (the
	 * trap `ResponseAnnouncer` bumps a key for). `aria-busy`, not a live region: announcing send
	 * and result is `ResponseAnnouncer`'s job; this marks the content mid-update. Not
	 * `isStreaming`: an open stream's pane is being written to, and the band carries its live dot
	 * and event count.
	 */
	const busy = isExecuting;
	const staleClass = cn("transition-opacity duration-150", busy && "opacity-60");

	/*
	 * Every tab always renders: a tab set that shrank by response let a tab chosen on one response
	 * name a trigger the next did not draw, blanking the controlled Tabs root (#59). A constant set
	 * makes that unrepresentable, stops the strip twitching between sends, and makes "did this run
	 * tests?" a tab to read. So each tab can be empty and says so; `RawRequestResponse`'s empty
	 * state is reachable only for a `status: 0` response with no recorded request.
	 */
	const consoleLogCount = consoleRowCount(shown.consoleLogs ?? [], shown.scriptRequests);
	const hasScriptError = !!shown.preScriptError || !!shown.postScriptError;
	const testResults = shown.testResults ?? [];
	// Non-script outcomes (#1512): extractors, assertions, timers, beside `testResults`, the script
	// kinds'.
	const elementOutcomes = shown.elements ?? [];
	// Draft elements Send left out (#3066), shown as "Not run" beside the outcomes.
	const notRunElements = shown.leftOutElements ?? [];

	/*
	 * Two sources, one list (#574), the handoff `ScenarioRunView` makes. The stored list wins once
	 * there is one: a finished trace is the record and the only copy with truthful `totalEvents` /
	 * `eventsTruncated`. `??`, not a length check: a stream that received nothing stores `[]`, an
	 * answer, not an absence. `isStream` separates "not a stream" from "no events yet".
	 */
	const storedEvents = shown.events;
	const events = storedEvents ?? (streamIsMine ? liveEvents : []);
	const totalEvents = storedEvents ? shown.totalEvents : (liveTotalEvents ?? undefined);
	const eventsTruncated = storedEvents ? shown.eventsTruncated : false;
	// The stored string wins as the stored list does, and outlives the stored-items cap. Live, `""`
	// is "nothing matched yet", reading as no path declared until an event with text.
	const streamText = storedEvents ? shown.streamText : liveStreamText || undefined;
	// Live: the store's running count, but only for this request's own feed. Otherwise left to the
	// list to count over the events it holds.
	const errorCount = !storedEvents && streamIsMine ? liveErrorCount : undefined;
	const endReason = storedEvents
		? shown.streamEndReason
		: (streamIsMine && liveEndReason) || undefined;

	// Status 0 means no server response: Body shows `ClientErrorView`; other tabs render from
	// `shown`.
	const isClientError = shown.status === 0;

	/*
	 * A buffered `text/event-stream` reply: Event stream is declared on the request, never
	 * detected, so Send waited for the end. `events === undefined` without this request's live feed
	 * tells it from a stream that ran. A status 0 never reaches the Body branch rendering it.
	 */
	const offerEventStream =
		!request.stream &&
		shown.events === undefined &&
		!streamIsMine &&
		isEventStreamType(contentTypeOf(shown.headers));

	/*
	 * "Save as example" (#588), only with something to attach it to and something finished to
	 * attach. Absent, not disabled, for an unsaved request: an example nests under a stored
	 * request, and the Examples tab already says so, where a greyed button explained on hover would
	 * be a worse copy. Hidden while a stream is live: `shown` is the `open`-frame placeholder with
	 * an empty body, and saving it would store a response that had not arrived. Hidden on a client
	 * error: no server answered. A non-UTF-8 body is the one case drawn disabled with its reason:
	 * the response is real and finished, so absence would read as a missing feature, not a refusal.
	 */
	const canSaveExample = !!requestId && !isStreaming && !isClientError;
	const saveRefusal = exampleRefusal(shown);
	const isShown = (id: ResponseTab) => visibleIds.includes(id);

	// Each mark is one node, handed to its trigger on the strip and to its "+N" item otherwise, so
	// they agree.
	const headersMark = (
		<TabCount value={resolveHeaderLines(shown.headers, shown.headerLines).length} />
	);
	const consoleMark = hasScriptError ? (
		// A script error that logged nothing must still be flagged (#111): a dot, not a count, so a
		// future `count="none"` cannot delete the only failure signal, and it outranks the count.
		<TabErrorDot />
	) : (
		<TabCount value={consoleLogCount} />
	);
	const testsMark = <TestsResultChip results={testResults} />;
	const eventsMark = <TabCount value={totalEvents ?? events.length} />;
	const marks: Partial<Record<ResponseTab, ReactNode>> = {
		headers: headersMark,
		console: consoleMark,
		tests: testsMark,
		events: eventsMark,
	};
	// The failures a hidden tab must not swallow: the "+N" trigger flags them.
	const attention: Partial<Record<ResponseTab, boolean>> = {
		console: hasScriptError,
		tests: testResults.some((t) => !t.passed),
	};

	/*
	 * One trigger per tab, in `strip` order, each with a literal `value`, since
	 * `tabs-panels.test.tsx` pairs trigger and panel by that text. No icon on any: one tab with an
	 * icon reads as another kind of thing; a tab's mark (Console's error dot above all) is what
	 * distinguishes it. Events is always in the set (#59); whether a tab is on the strip or in the
	 * menu is only room. Events' count is the *received* total, not the row count once a stored
	 * list is capped. A chip arriving on Tests must not push later tabs: `TestsResultChip` holds
	 * the width open.
	 */
	const triggers: Record<ResponseTab, ReactNode> = {
		body: (
			<TabsTrigger key="body" value="body">
				<TabLabel>Body</TabLabel>
			</TabsTrigger>
		),
		headers: (
			<TabsTrigger key="headers" value="headers">
				<TabLabel>Headers</TabLabel>
				{headersMark}
			</TabsTrigger>
		),
		cookies: (
			<TabsTrigger key="cookies" value="cookies">
				<TabLabel>Cookies</TabLabel>
			</TabsTrigger>
		),
		timing: (
			<TabsTrigger key="timing" value="timing">
				<TabLabel>Timing</TabLabel>
			</TabsTrigger>
		),
		console: (
			<TabsTrigger key="console" value="console">
				<TabLabel>Console</TabLabel>
				{consoleMark}
			</TabsTrigger>
		),
		tests: (
			<TabsTrigger key="tests" value="tests">
				<TabLabel>Tests</TabLabel>
				{testsMark}
			</TabsTrigger>
		),
		events: (
			<TabsTrigger key="events" value="events">
				<TabLabel>Events</TabLabel>
				{eventsMark}
			</TabsTrigger>
		),
		"raw-request": (
			<TabsTrigger key="raw-request" value="raw-request">
				<TabLabel>Raw</TabLabel>
			</TabsTrigger>
		),
	};

	return (
		<div
			className="relative flex-1 flex flex-col surface-card overflow-hidden"
			aria-busy={busy}
		>
			{busy && <SendingWave />}
			{/*
			 * Its own band above the tabs: a response's status is the first thing looked at, and a
			 * row shared with eight triggers and the actions is no place for a headline. Dense
			 * instead: 32px (ResponseStatusBar).
			 */}
			<ResponseStatusBar
				className={staleClass}
				status={shown.status}
				statusText={shown.statusText}
				time={shown.time}
				// The `open`-frame placeholder has no byte count (the relay carries no body), and
				// `0 B` would read as an empty reply.
				size={shown === streamedResponse ? undefined : shown.size}
				headers={shown.headers}
				engineMs={shown.timing?.engineMs}
				scriptMs={shown.timing?.scriptMs}
				wireMs={shown.timing?.wireMs}
				httpVersion={shown.httpVersion}
				httpVersionDowngraded={shown.httpVersionDowngraded}
				clientCertificate={shown.clientCertificate}
				receivedAt={shown.receivedAt}
				restoredFrom={shown.restoredFrom}
				validation={shown.validation}
				// Only while live: a finished stream's band shows the exchange it completed, and
				// its count and end reason live in Events.
				streaming={
					isStreaming ? { events: events.length, sentAt: shown.sentAt } : undefined
				}
			/>

			{/* Above the response it explains: an earlier run restored in its place. */}
			{feedNotice}

			{/*
			 * The engine's sentence on what the auth block did on the wire: no authentication
			 * because the mode is one Vayu does not execute (#2474) or the bearer token or API key
			 * name was empty (#3203), or the request's own Authorization header went and no OAuth
			 * 2.0 token was fetched (#3202); hence a neutral title. A band between status and tabs,
			 * unlike the two body notices: it explains the status (a 401 is expected), so it shows
			 * on every tab and on a `status: 0` failure, whose Body is `ClientErrorView`.
			 */}
			{shown.authNotice && (
				<div className={cn("px-4 pt-3 shrink-0", staleClass)}>
					<Callout severity="warning" title="Authentication note">
						{shown.authNotice}
					</Callout>
				</div>
			)}

			{/* Beside the auth note for the same reason: it explains a 403. */}
			{shown !== streamedResponse && (
				<StepUpNotice response={shown} className={cn("px-4 pt-3 shrink-0", staleClass)} />
			)}

			{/*
			 * What the engine did to the exchange that the response does not show (#3307), e.g. a
			 * jar cookie left off `Cookie`. A band as above: it explains the outcome, on every tab
			 * and on a `status: 0`.
			 */}
			<ExchangeWarnings
				warnings={shown.warnings}
				className={cn("px-4 pt-3 shrink-0", staleClass)}
			/>

			<Tabs
				value={activeTab}
				onValueChange={(v) => setActiveTab(v as ResponseTab)}
				className={cn("flex-1 flex flex-col overflow-hidden", staleClass)}
			>
				{/*
				 * `border-rule`, valued by the `surface-card` root: every divider here says the
				 * same, and the surface resolves it (`--border` in light, 1.304; `--border-strong`
				 * in dark, where `--border` is 1.003, the card's own colour). See index.css,
				 * "Surfaces, and the rule colour that reads on each".
				 */}
				<div className="flex items-center justify-between border-b border-rule px-4 gap-2">
					{/*
					 * The fit measures this wrapper, not the list, which shrinks to what it draws
					 * (`useFittedTabs`). `flex-1 min-w-0` makes it the room the row leaves for
					 * tabs; Save keeps its own. Overflowing tabs go in the "+N" menu, not scrolled
					 * out of sight behind a cueless hidden scrollbar.
					 */}
					<div ref={containerRef} className="flex min-w-0 flex-1 items-stretch">
						<TabsList variant="bare" className="overflow-hidden flex-nowrap">
							{/* Drawn in `strip` order, which is why a stream's Events sits beside Body. */}
							{strip.ids.filter(isShown).map((id) => triggers[id])}
						</TabsList>
						<TabOverflowMenu
							tabs={strip.tabs
								.filter((t) => overflowedIds.includes(t.id))
								.map((t) => ({
									...t,
									mark: marks[t.id],
									attention: attention[t.id],
								}))}
							onSelect={setActiveTab}
						/>
					</div>

					{/*
					 * Here, not beside Copy and Download in the body pane (which act on the body):
					 * this acts on the whole exchange, so it belongs to the response. `h-6`: the
					 * default h-9 would set the row's height instead of the 24px tab band.
					 */}
					{canSaveExample && (
						<DisabledHint reason={saveRefusal}>
							<Button
								size="sm"
								variant="ghost"
								disabled={saveRefusal !== undefined}
								onClick={() => setSavingExample(true)}
								className="h-control-sm shrink-0 px-2 text-xs"
							>
								<BookmarkPlus className="size-icon-sm" />
								Save as example
							</Button>
						</DisabledHint>
					)}
				</div>

				{/*
				 * TabsContent per tab, not a plain <div>: Radix derives each trigger's
				 * aria-controls id from its value, so content outside the Tabs tree left every
				 * trigger pointing at a missing panel. Conditional panels mirror their triggers'
				 * conditions, so a tab and its panel render together.
				 */}
				<TabsContent value="body" className="mt-0 flex-1 overflow-hidden">
					{isClientError ? (
						/*
						 * `ClientErrorView` centres itself with `flex-1`, so it needs a pane-height
						 * flex box.
						 */
						<div className="flex h-full min-h-0 overflow-auto">
							<ClientErrorView
								errorCode={shown.errorCode}
								errorMessage={shown.errorMessage}
								requestUrl={shown.sentRequest?.url}
							/>
						</div>
					) : (
						<div className="flex flex-col h-full">
							{/*
							 * The engine caps a stored trace body at `maxTraceBodyBytes`, so a
							 * response restored from a run (cold start, or a design run opened from
							 * History) may be only the stored slice: say so, and how to get it
							 * whole.
							 */}
							{shown.bodyTruncated && (
								<div className="px-4 pt-3 shrink-0">
									<Callout severity="warning" title="Body truncated for storage">
										Only the first {formatBytes(heldBodySize(shown))} of{" "}
										{formatBytes(shown.bodyBytes ?? heldBodySize(shown))} was
										kept. Re-send the request to view the full response.
									</Callout>
								</div>
							)}
							{/*
							 * A different fact, deliberately not exclusive (#1157): above, storage
							 * shortened a body the user saw whole, which a re-send undoes; here the
							 * engine never read past `maxDesignResponseBodyBytes`, which a re-send
							 * reproduces, so the remedy is the setting.
							 */}
							{shown.bodyCapped && (
								<div className="px-4 pt-3 shrink-0">
									<Callout severity="warning" title="Body capped while reading">
										Only {cappedReadExtent(shown)} of this response was read -
										Vayu&apos;s engine stops a Send there, so re-sending reads
										the same amount. Raise Max Send response body in Settings to
										read more.
									</Callout>
								</div>
							)}
							{offerEventStream && (
								<div className="px-4 pt-3 shrink-0">
									<Callout
										severity="info"
										title="Event stream is off"
										action={
											<Button
												variant="outline"
												size="sm"
												onClick={() =>
													setRequest(streamPatch(request, true))
												}
											>
												Enable event stream
											</Button>
										}
									>
										The server answered text/event-stream, so Send waited for
										the whole reply. With Event stream on, events arrive live
										from the next Send.
									</Callout>
								</div>
							)}
							{/*
							 * An MCP tool result above the raw reply, which keeps the rest of the
							 * height. Only the builder knows the request is MCP (`bodyMode`);
							 * History and the Console mount the body pane without it.
							 */}
							{request.bodyMode === "mcp" && (
								<McpResultView
									body={shown.body}
									bodyRaw={shown.bodyRaw}
									rawBytes={shown.rawBytes}
									incomplete={shown.bodyCapped || shown.bodyTruncated}
								/>
							)}
							<div className="flex-1 min-h-0">
								<SharedResponseBody
									body={shown.body}
									bodyRaw={shown.bodyRaw}
									rawBytes={shown.rawBytes}
									headers={shown.headers}
									showModeToggle
									/*
									 * Copy and download live *here*, beside the Pretty/Raw switch:
									 * they act on the body as received, not Pretty's indented copy
									 * (#2459), and on the tab row they claimed to act on whatever
									 * tab was shown. The response's Content-Type names the
									 * download, for a text body and a base64 one alike.
									 */
									actions={
										<ResponseActions
											content={receivedBody(shown)}
											rawBytes={shown.rawBytes}
											contentType={contentTypeOf(shown.headers)}
										/>
									}
								/>
							</div>
						</div>
					)}
				</TabsContent>
				<TabsContent value="headers" className="mt-0 flex-1 overflow-hidden">
					<ResponseHeadersPanel
						requestHeaders={shown.requestHeaders}
						requestHeaderLines={shown.requestHeaderLines}
						wireRequestHeaders={shown.wireRequestHeaders}
						responseHeaders={shown.headers}
						responseHeaderLines={shown.headerLines}
					/>
				</TabsContent>
				<TabsContent value="cookies" className="mt-0 flex-1 overflow-hidden">
					<ResponseCookies
						headers={shown.headers}
						headerLines={shown.headerLines}
						redirects={shown.redirects}
					/>
				</TabsContent>
				<TabsContent value="timing" className="mt-0 flex-1 overflow-hidden">
					{shown.timing ? (
						<ResponseTimingTab
							timing={shown.timing}
							redirects={shown.redirects}
							firstEventMs={elapsedBetween(shown.sentAt, events[0]?.receivedAt)}
						/>
					) : (
						<EmptyState variant="inline" title="No timing recorded" />
					)}
				</TabsContent>
				<TabsContent value="console" className="mt-0 flex-1 overflow-hidden">
					<ConsoleOutput
						logs={shown.consoleLogs || []}
						scriptRequests={shown.scriptRequests}
						errors={{
							pre: shown.preScriptError,
							post: shown.postScriptError,
						}}
					/>
				</TabsContent>
				<TabsContent value="tests" className="mt-0 flex-1 overflow-hidden">
					{/*
					 * Two kinds of test result, one tab (#628): a script's assertions and the
					 * spec's schema. Either, both or neither; the empty state shows only for
					 * neither, so a collection with no spec sees no change.
					 */}
					{testResults.length > 0 ||
					shown.validation ||
					elementOutcomes.length > 0 ||
					notRunElements.length > 0 ? (
						<div className="h-full overflow-auto p-4 space-y-4">
							{shown.validation && <SchemaValidation validation={shown.validation} />}
							{testResults.length > 0 && (
								<TestResults results={testResults} inset={false} />
							)}
							<ElementOutcomes
								outcomes={elementOutcomes}
								notRun={notRunElements}
								inset={false}
							/>
						</div>
					) : (
						<EmptyState
							variant="inline"
							title="No tests ran. Add a post-request script or an assert in the Elements tab."
						/>
					)}
				</TabsContent>
				<TabsContent value="events" className="mt-0 flex-1 overflow-hidden">
					<ResponseEvents
						events={events}
						totalEvents={totalEvents}
						eventsTruncated={eventsTruncated}
						streamText={streamText}
						errorCount={errorCount}
						endReason={endReason}
						isStreaming={isStreaming}
						isStream={isStream}
						contentType={contentTypeOf(shown.headers)}
						sentAt={shown.sentAt}
						error={streamIsMine ? liveError : null}
						// Only for the live list; a stored trace arrives whole, so its row count is
						// the identity wanted.
						listKey={
							!storedEvents && streamIsMine ? (liveRunId ?? undefined) : undefined
						}
					/>
				</TabsContent>
				<TabsContent value="raw-request" className="mt-0 flex-1 overflow-hidden">
					<RawRequestResponse rawRequest={shown.rawRequest || ""} response={shown} />
				</TabsContent>
			</Tabs>

			{/*
			 * Mounted only while open, so this pane, which redraws every send, holds no dialog
			 * state and reaches no query layer until a save is asked; the mount is the reset, so it
			 * starts from this response.
			 */}
			{savingExample && requestId && (
				<SaveAsExampleDialog
					requestId={requestId}
					response={shown}
					onClose={() => setSavingExample(false)}
				/>
			)}
		</div>
	);
}
