/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * ResponseViewer Component
 *
 * Displays HTTP response with:
 * - Status badges
 * - Response metadata (time, size)
 * - Tabbed view for body/headers/cookies
 * - Body formatting (JSON, HTML, XML, Text, Image, PDF, etc.)
 * - Collapsible headers sections
 * - Console logs separated by pre-scripts and tests
 *
 * Uses shared ResponseBody component for body display with Pretty/Raw/Preview modes.
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
	ResponseStatusBar,
	ResponseActions,
	ResponseHeadersPanel,
	ResponseEvents,
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
import { TabOverflowMenu } from "@/components/layout/TabOverflowMenu";
import { useFittedTabs } from "@/components/layout/useFittedTabs";
import { MARK_ALLOWANCE } from "@/components/layout/tab-fit";
import type { ResponseState, ResponseTab } from "../../types";
import { contentTypeOf, heldBodySize, receivedBody } from "../../utils/response-bytes";
import { exampleRefusal } from "./save-as-example";
import { resolveHeaderLines } from "@/lib/header-lines";

/**
 * The eight sub-tabs. One list per order: the fit measures these labels and the
 * strip draws these triggers, so a ninth tab cannot be drawn without being
 * measured.
 *
 * Always all eight, whatever the response carries (issue #59's constant tab
 * set) - a normal response gets an honest "not an event stream" rather than a
 * tab that comes and goes. Only the order moves: a stream has Events directly
 * after Body, because Events is the tab it opens on and the strip overflows
 * from the right, so Events in its ordinary seventh place would be the first
 * one into the "+N" menu (#3691).
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
 * The Tests tab's pass/fail chip, animated into a track that costs nothing at
 * rest.
 *
 * A result, not a count - it keeps its `Badge` rather than becoming a
 * `TabCount`, and it says nothing at all when nothing ran, because "0/0" reads
 * like a result. What it must *not* do is arrive by an instant jump: a mark on
 * a trigger is a flex item, the trigger is `shrink-0` inside this strip's
 * `flex-nowrap` list, so a chip appearing widens the Tests trigger by its own
 * width plus the trigger's `gap-1.5` and pushes every tab after Tests along with it (Events and Raw, or Raw alone for a stream) -
 * a response with tests and one without would draw the strip two different
 * ways, under a pointer on its way to one of those two tabs.
 *
 * This is the same defect `MARK_TRACK` in `tabs.tsx` fixes for `TabCount` and
 * `TabErrorDot`: a `grid-template-columns: 0fr -> 1fr` track that is
 * genuinely zero width - and cancels the trigger's own leading `gap-1.5`
 * alongside it, via `-ms-1.5`/`ms-0` - when there is nothing to show, and
 * animates open to the chip's intrinsic width when there is.
 *
 * **Unlike `TabCount`, the `Badge` does not stay mounted empty.** `TabCount`'s
 * live cell is bare text, so an empty one is genuinely invisible; `Badge`
 * always paints an opaque `bg-*` fill regardless of its content, the same
 * fact the width-reservation version of this component was written around
 * ("an emptied `Badge` still paints a coloured pill"). A track that has not
 * quite finished collapsing - or hits a rounding residual from the badge's
 * own padding - would otherwise leave a stray filled pixel or two showing as
 * a small solid mark next to "Tests" on every response that never ran one,
 * which is worse than the jump this whole mechanism exists to fix. So the
 * `Badge` itself mounts only when there is a result, the same true
 * mount/unmount `TabErrorDot` has, and needs the same `starting:` opacity for
 * its own fade-in independent of the track's width animation.
 *
 * **Unmounting it is held by one fade** (`useHeldValue`,
 * `TIMING.MARK_FADE_MS`), the mirror of that `starting:` fade-in and the same
 * fix `TabCount` and the Dock's save line take: the `Badge` used to be
 * removed in the commit that put the track back to `0fr`, so the track spent
 * 150ms collapsing around nothing and the chip itself was cut - which the
 * collapse made easy to miss. It still leaves the tree entirely once the fade
 * is over, so the stray-filled-pixel hazard above is unchanged: nothing is
 * mounted at rest.
 */
function TestsResultChip({ results }: { results: readonly { passed: boolean }[] }) {
	const passed = results.filter((t) => t.passed).length;
	const hasResults = results.length > 0;
	/*
	 * The chip's whole content in one string, because `useHeldValue` holds a
	 * primitive: `results` is a fresh `[]` on every render of a response that
	 * ran none, so an array could never settle. The track reads `hasResults`
	 * and collapses on time; the `Badge` reads `shown` and survives one fade
	 * past it.
	 */
	const { shown, fading } = useHeldValue(
		hasResults ? `${passed}/${results.length}` : null,
		TIMING.MARK_FADE_MS
	);
	// Tone from the held label, not from `results`: while the chip is on its
	// way out there are no live results left to read one from, and a green
	// chip must not turn red in the last frames of its life.
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
	const { request, response, isExecuting } = useRequestBuilderContext();
	const requestId = request.id ?? null;

	/*
	 * The sub-tab the user chose, kept per request id so it survives both
	 * `Shell.tsx` unmounting this pane when its workspace tab is not on
	 * screen, and switching between two open request tabs, which reuses this
	 * component without remounting it - `request.id` changes underneath the
	 * same `useState` either way. `null` is "no choice yet", and what the pane
	 * shows then is `activeTab` below.
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
	 * The `useState` initializer above only ever runs once, for whichever
	 * request this pane first rendered for - a later request shown without a
	 * remount (the tab-switch case above) needs this derived-during-render
	 * sync instead, the same shape `RequestBuilderProvider`'s per-request
	 * reset uses, so the previous request's tab never gets a frame to paint
	 * under the new one.
	 */
	const [tabSyncedFor, setTabSyncedFor] = useState(requestId);
	if (requestId !== tabSyncedFor) {
		setTabSyncedFor(requestId);
		setChosenTab(requestId ? getResponseTab(requestId) : null);
	}

	/*
	 * The live stream, when it is this request's (issue #574).
	 *
	 * Selected against the request on screen for the same reason the provider
	 * does it: one builder serves every request tab, and rows from a stream
	 * started elsewhere must not appear under this one.
	 */
	const streamIsMine = useExecutionEventsStore(
		(s) => !!s.requestId && !!requestId && s.requestId === requestId
	);
	const liveOpen = useExecutionEventsStore((s) => s.open);
	const liveLeftOut = useExecutionEventsStore((s) => s.leftOut);
	const liveEvents = useExecutionEventsStore((s) => s.events);
	// The stream's identity, for the Events tab's render window: its list grows
	// in place, so the window must reset when the stream changes and not when a
	// batch lands (issue #1158).
	const liveRunId = useExecutionEventsStore((s) => s.runId);
	const liveIsStreaming = useExecutionEventsStore((s) => s.isStreaming);
	const liveEndReason = useExecutionEventsStore((s) => s.endReason);
	const liveTotalEvents = useExecutionEventsStore((s) => s.totalEvents);
	const liveError = useExecutionEventsStore((s) => s.error);

	const isStreaming = streamIsMine && liveIsStreaming;

	/*
	 * `isStream` is what separates "not a stream" from "a stream with no events
	 * yet", and it is true for either source - a restored run whose trace has an
	 * `events` node, or a live one belonging to this request. It stays true once
	 * the stream is over, so it says what `ResponseEvents` should word its empty
	 * state as, and is not what picks the default tab (`streamView` below).
	 */
	const isStream = response?.events !== undefined || streamIsMine;

	/*
	 * Whether the pane is showing a stream, which decides the default tab and
	 * the strip's order (#3691). A response that has landed says so itself, by
	 * its `events` node. No response yet means the feed in the store is what is
	 * on screen - live, or just ended with its stored run still on the way - so
	 * it is a stream when the store holds this request's. It is not `isStream`
	 * alone because `streamIsMine` outlives the stream (the store keeps this
	 * request's id until another stream or a clear replaces it): an ordinary
	 * Send after a stream lands a response with no `events`, which must read as
	 * ordinary.
	 */
	const streamView = response ? response.events !== undefined : streamIsMine;

	/*
	 * A tab nobody chose opens on Events for a stream and on Body otherwise.
	 * Derived on every render and never written to the remembered-tab store,
	 * because it is a default and not the user's choice: a later ordinary
	 * response for the same request still opens on Body.
	 */
	const activeTab: ResponseTab = chosenTab ?? (streamView ? "events" : "body");
	const strip = responseTabSet(streamView);

	const [savingExample, setSavingExample] = useState(false);

	// Called ahead of the early returns below, which would skip it; the wrapper it
	// measures only exists once there is a response to draw. The labels and the
	// triggers below are the one `strip`.
	const { containerRef, visibleIds, overflowedIds } = useFittedTabs({
		ids: strip.ids,
		labels: strip.labels,
		activeId: activeTab,
		markAllowance: responseMarkAllowance,
	});

	/*
	 * A stream has no exchange to render until its response headers arrive, so
	 * the pane is given one built from the relay's `open` frame - the status,
	 * the status text and the headers, which is everything the engine knows at
	 * that point. Only when there is no stored response: once the stream ends
	 * the provider swaps in what the run stored, and that is the record.
	 *
	 * Not persisted anywhere, deliberately. It describes a stream that is still
	 * running, and the durable copy of a response is the one the finished run
	 * wrote.
	 */
	const streamedResponse = useMemo<ResponseState | null>(() => {
		if (response || !streamIsMine || !liveOpen) return null;
		return {
			status: liveOpen.statusCode,
			statusText: liveOpen.statusText,
			headers: liveOpen.headers,
			// No `headerLines`: the `open` frame carries the folded map alone, and
			// absence is what the tabs read as "show the map" (`resolveHeaderLines`).
			body: "",
			size: 0,
			time: 0,
			...(liveLeftOut.length > 0 ? { leftOutElements: liveLeftOut } : {}),
		};
	}, [response, streamIsMine, liveOpen, liveLeftOut]);

	const shown = response ?? streamedResponse;

	/*
	 * Another request's stream took this request's live feed over (#3352). The
	 * run it fed was not stopped, so the pane says where it went rather than
	 * falling back to "No response yet" as if nothing had been sent. Gone once
	 * the pane shows that run's own stored record.
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
	 * Loading state - **only when there is nothing on screen to keep**.
	 *
	 * It used to be `isExecuting || …`, which replaced the whole pane with a
	 * centred spinner on every send, the re-sends included: press Send on a
	 * request you already have a response for and the status, the headers and
	 * the body you were reading vanished until the new ones landed. That is the
	 * loading state destroying the context the user is working in - the defect
	 * stale-while-revalidate exists to fix, and what this pane's own rule in
	 * docs/design-system.md ("Loading") already said not to do: an in-place
	 * action on an existing control is an inline spinner on *that control*, and
	 * nothing else on the pane should move. Send already carries it, relabelling
	 * itself Sending. A re-send now keeps the previous exchange on screen and
	 * marks it stale (see `busy` below) instead.
	 *
	 * What is left here is the case where there is genuinely nothing to keep:
	 * the first send for this request, and a stream that has been accepted but
	 * whose headers have not arrived - the send is over there, `isExecuting` was
	 * cleared when the engine answered, but no exchange exists to draw yet.
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

	// Empty state
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
	 * A send is in flight over an exchange that is already on screen.
	 *
	 * The layout is still: the whole exchange recedes to 60% and nothing about
	 * its own content changes size or position, so everything stays readable
	 * and clickable while the new response is on its way. That is what the
	 * "Loading" rule in docs/design-system.md asks for (the control that was
	 * clicked shows the work; nothing else on the pane moves) and it is the
	 * treatment React Query's own paginated-queries guide reaches for when it
	 * hands back the previous page's data - dim what is stale, do not replace
	 * it. `SendingWave` is the one deliberate exception to "nothing moves": a
	 * faint band layered on top, low enough opacity to leave the dimmed text
	 * legible under it, because a dim with no motion at all read as inert
	 * rather than as a request actually in flight (see the doc's own
	 * paragraph for the reasoning). It is not itself a live region and adds
	 * nothing an assistive-tech user does not already get from `aria-busy`.
	 *
	 * It has to say *something* when the wave is off too, though, or a re-send
	 * whose response is byte-identical to the one already showing would look
	 * like a Send that never fired - the same trap `ResponseAnnouncer` bumps a
	 * key to get out of. The dim lifting as the new response lands is that
	 * signal.
	 *
	 * `aria-busy` rather than a live region: the pane is not one, and the
	 * announcement of both the send and its result is `ResponseAnnouncer`'s
	 * job. This only tells assistive tech that what it is reading here is
	 * mid-update.
	 *
	 * Not `isStreaming`: an open stream's pane is being written to, not held
	 * stale, and the status band already carries its live dot and its running
	 * event count.
	 */
	const busy = isExecuting;
	const staleClass = cn("transition-opacity duration-150", busy && "opacity-60");

	/*
	 * Every tab always renders.
	 *
	 * Four of them used to appear only when the response carried the data -
	 * `timing`, `console`, `tests`, `raw-request` - so the tab set shrank as you
	 * switched responses. That produced issue #59: `activeTab` is local state that
	 * survives a response change, so a tab clicked on one response could name a
	 * trigger the next response no longer drew, leaving the controlled Tabs root
	 * with nothing to select and a blank pane. It was handled by clamping the
	 * selection back to `body`.
	 *
	 * A constant tab set makes that unrepresentable rather than handled, and the
	 * clamp is gone with it. It also stops the strip twitching - tabs no longer
	 * appear and vanish under the pointer between sends - and it gives "did this
	 * run any tests?" an answer you can go and read, rather than an absence you
	 * have to notice.
	 *
	 * The cost is that four tabs can now be empty, so each says so. Console and
	 * Cookies already did; Timing, Tests and Raw did not. `RawRequestResponse`'s
	 * empty state is reachable only for a `status: 0` response with no recorded
	 * request.
	 */
	const consoleLogCount = consoleRowCount(shown.consoleLogs ?? [], shown.scriptRequests);
	const hasScriptError = !!shown.preScriptError || !!shown.postScriptError;
	const testResults = shown.testResults ?? [];
	// Non-script outcomes (issue #1512) - extractors, assertions and timers,
	// beside `testResults` above which stays the script kinds' own shape.
	const elementOutcomes = shown.elements ?? [];
	// Draft elements Send left out (#3066), shown as "Not run" beside the outcomes.
	const notRunElements = shown.leftOutElements ?? [];

	/*
	 * Two sources, one list (issue #574) - the handoff `ScenarioRunView` makes.
	 *
	 * The stored list wins the moment there is one: a finished run's trace is
	 * the record, and it is the only copy carrying the truthful `totalEvents` /
	 * `eventsTruncated` markers. `??`, not a length check: a stream that ended
	 * having received nothing stores `[]`, and that is an answer, not an absence
	 * to fall back from.
	 *
	 * `isStream` (above) is what separates "not a stream" from "a stream with no
	 * events yet".
	 */
	const storedEvents = shown.events;
	const events = storedEvents ?? (streamIsMine ? liveEvents : []);
	const totalEvents = storedEvents ? shown.totalEvents : (liveTotalEvents ?? undefined);
	const eventsTruncated = storedEvents ? shown.eventsTruncated : false;
	const endReason = storedEvents
		? shown.streamEndReason
		: (streamIsMine && liveEndReason) || undefined;

	// Client-side error (status 0 means no server response): the Body tab shows
	// `ClientErrorView`, and every other tab renders from `shown` as usual.
	const isClientError = shown.status === 0;

	/*
	 * "Save as example" (issue #588) - present only when there is something to
	 * attach it to and something finished to attach.
	 *
	 * Absent rather than disabled for an unsaved request. An example is owned by
	 * a stored request, so there is no id to nest one under until the request is
	 * saved, and the Examples tab beside this already says exactly that in a
	 * sentence - a permanently greyed button whose explanation only appears on
	 * hover would be a second, worse copy of it.
	 *
	 * Hidden while a stream is live for a different reason: `shown` is then the
	 * placeholder built from the relay's `open` frame, whose body is empty by
	 * construction. Saving it would store an example of a response that had not
	 * arrived. The button comes back when the stream ends and the run's stored
	 * response takes over.
	 *
	 * And for a client-side error: no server answered, so there is no exchange
	 * to keep as an example of one.
	 *
	 * A body that is not UTF-8 is the one case drawn disabled, with its reason:
	 * the response is real and finished, so an absent button would read as a
	 * missing feature rather than a refusal.
	 */
	const canSaveExample = !!requestId && !isStreaming && !isClientError;
	const saveRefusal = exampleRefusal(shown);
	const isShown = (id: ResponseTab) => visibleIds.includes(id);

	/*
	 * Each mark is one node, handed to its trigger when the tab is on the strip
	 * and to its "+N" menu item when it is not, so the two cannot disagree.
	 */
	const headersMark = (
		<TabCount value={resolveHeaderLines(shown.headers, shown.headerLines).length} />
	);
	const consoleMark = hasScriptError ? (
		// A script error that logged nothing must still be flagged (issue #111).
		// A dot rather than a count, so a future `count="none"` cannot silently
		// delete the only failure signal - and it outranks the count, because the
		// failure is the thing you need to see.
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
	 * One trigger per tab, drawn in `strip` order. Each is written out with a
	 * literal `value` because `tabs-panels.test.tsx` pairs a trigger with its
	 * panel by that text.
	 *
	 * No icon on any of them: Console was the only one across the fifteen
	 * triggers in the two strips - the response pane's seven and the request
	 * builder's eight - so it read as a different *kind* of thing rather than as
	 * an aid to finding it. What distinguishes a tab when it matters is its mark
	 * (Console's error dot above all).
	 *
	 * Events is always in the set, like the seven beside it (issue #59's
	 * constant tab set) - a normal response gets an honest "not an event
	 * stream" rather than a tab that comes and goes. Whether a tab is drawn
	 * here or in the menu is only the room. Events' count is the *received*
	 * total, which is not the row count once a stored list has been capped.
	 * A result chip arriving on Tests must not push the tabs after it
	 * sideways: see `TestsResultChip`, which holds the width open.
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
			 * Its own band, above the tabs.
			 *
			 * Folding it *into* the tab row was tried and is wrong: the status of a
			 * response is the first thing you look at, and a row it shares with
			 * eight tab triggers and the action buttons is not where a headline
			 * goes. It stays a band and got denser instead - 40px to 32px, see
			 * ResponseStatusBar.
			 */}
			<ResponseStatusBar
				className={staleClass}
				status={shown.status}
				statusText={shown.statusText}
				time={shown.time}
				// The placeholder built from the `open` frame has no byte count (the
				// relay carries no body), and `0 B` would read as an empty reply.
				size={shown === streamedResponse ? undefined : shown.size}
				headers={shown.headers}
				engineMs={shown.timing?.engineMs}
				httpVersion={shown.httpVersion}
				httpVersionDowngraded={shown.httpVersionDowngraded}
				clientCertificate={shown.clientCertificate}
				receivedAt={shown.receivedAt}
				restoredFrom={shown.restoredFrom}
				validation={shown.validation}
				// Only while it is actually live. A finished stream's band shows
				// the exchange it completed, and the Events tab is where its
				// count and its end reason live.
				streaming={isStreaming ? { events: events.length } : undefined}
			/>

			{/* Above the response it explains: an earlier run restored in its place. */}
			{feedNotice}

			{/*
			 * The engine's own sentence about what the auth block did on the wire:
			 * the request went out with no authentication because its auth mode
			 * is one Vayu does not execute (issue #2474) or its bearer token or
			 * API key name was empty (issue #3203), or its own Authorization
			 * header was sent and no OAuth 2.0 token was fetched (issue #3202).
			 * The title stays neutral for that reason. A band between the status and the tabs rather than
			 * inside the Body tab, unlike the two body notices: it explains the
			 * status (a 401 is the expected result), so it must show on every
			 * tab and on a `status: 0` failure, whose Body tab is
			 * `ClientErrorView`.
			 */}
			{shown.authNotice && (
				<div className={cn("px-4 pt-3 shrink-0", staleClass)}>
					<Callout severity="warning" title="Authentication note">
						{shown.authNotice}
					</Callout>
				</div>
			)}

			{/*
			 * What the engine did to the exchange that the response does not show
			 * (issue #3307), e.g. a jar cookie left off the `Cookie` line. A band
			 * for the same reason the notice above is: the sentence explains the
			 * outcome, so it shows on every tab and on a `status: 0` failure.
			 */}
			<ExchangeWarnings
				warnings={shown.warnings}
				className={cn("px-4 pt-3 shrink-0", staleClass)}
			/>

			{/* Response Tabs */}
			<Tabs
				value={activeTab}
				onValueChange={(v) => setActiveTab(v as ResponseTab)}
				className={cn("flex-1 flex flex-col overflow-hidden", staleClass)}
			>
				{/* `border-rule`, and the `surface-card` root above is what gives it a
				    value. Every divider in this pane says the same thing and the
				    surface decides what it resolves to - `--border` in light, where it
				    measures 1.304, and `--border-strong` in dark, where `--border`
				    would be 1.003 (the same colour as the card, which is why the tab
				    strip used to float free of the content). See index.css,
				    "Surfaces, and the rule colour that reads on each". */}
				<div className="flex items-center justify-between border-b border-rule px-4 gap-2">
					{/*
					    The fit measures this wrapper, not the list: the list shrinks to
					    whatever it draws, so measuring it reads back the previous fit
					    (`useFittedTabs`). `flex-1 min-w-0` makes the wrapper the room the
					    row leaves for tabs; the Save button keeps its own. Tabs that do
					    not fit are in the "+N" menu rather than scrolled out of sight,
					    which a hidden scrollbar gave no cue of.
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
					 * Here rather than beside Copy and Download, which sit in the body
					 * pane because that is what they act on. This acts on the whole
					 * exchange - status, headers and body together - so it belongs to
					 * the response, not to the tab you happen to be reading.
					 *
					 * `h-6`, like the actions it replaced on this row: at the button
					 * default of h-9 it, and not the 24px tab band, would set the
					 * row's height.
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
				 * TabsContent per tab, not a plain <div>. Radix derives an
				 * aria-controls id per trigger from its value, so rendering the
				 * content outside the Tabs tree left every trigger pointing at a
				 * panel id that never existed. The conditional panels mirror the
				 * conditions on their triggers above, so a tab and its panel are
				 * always rendered together.
				 */}
				<TabsContent value="body" className="mt-0 flex-1 overflow-hidden">
					{isClientError ? (
						/* `ClientErrorView` centres itself with `flex-1`, so it needs a
						   flex box of the pane's height to be centred in. */
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
							 * The engine caps a stored trace body at `maxTraceBodyBytes`,
							 * so a response restored from a run (cold start, or a design
							 * run opened from History) may hold only the stored slice.
							 * Say so, and how to get the whole thing back.
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
							 * A different fact from the one above, and deliberately not
							 * exclusive with it (issue #1157): that one is storage
							 * shortening a body the user already saw whole, which a
							 * re-send undoes. This one is the engine never having read
							 * past `maxDesignResponseBodyBytes`, which a re-send
							 * reproduces - so the remedy is the setting, not the button.
							 */}
							{shown.bodyCapped && (
								<div className="px-4 pt-3 shrink-0">
									<Callout severity="warning" title="Body capped while reading">
										Only the first{" "}
										{formatBytes(shown.size || heldBodySize(shown))} of this
										response was read - Vayu&apos;s engine stops a Send there,
										so re-sending reads the same amount. Raise Max Send response
										body in Settings to read more.
									</Callout>
								</div>
							)}
							<div className="flex-1 min-h-0">
								<SharedResponseBody
									body={shown.body}
									bodyRaw={shown.bodyRaw}
									rawBytes={shown.rawBytes}
									headers={shown.headers}
									showModeToggle
									/*
									 * Copy and download live *here*, not on the tab row.
									 *
									 * They act on the body - the text as received, not the
									 * indented copy Pretty shows (issue #2459) - and always
									 * did, so on the tab row they sat above Headers,
									 * Timing and Raw claiming to act on whatever you were
									 * looking at while copying something else. Moving them
									 * beside the Pretty/Raw switch puts them with the thing
									 * they operate on, and gives the tab strip back the ~64px
									 * they were taking, which is what let all seven tabs
									 * render without the strip scrolling.
									 *
									 * The response's Content-Type names the download,
									 * for a text body and a base64 one alike.
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
						<ResponseTimingTab timing={shown.timing} redirects={shown.redirects} />
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
					 * Two kinds of test result, one tab (issue #628): the
					 * assertions a script wrote, and the schema the spec wrote.
					 * A response can carry either, both or neither, and the
					 * empty state only appears when it carries neither - a
					 * collection with no spec bound sees exactly what it saw
					 * before.
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
						endReason={endReason}
						isStreaming={isStreaming}
						isStream={isStream}
						contentType={contentTypeOf(shown.headers)}
						error={streamIsMine ? liveError : null}
						// Only for the live list. A stored trace arrives whole, so the
						// row count is the identity the window wants there.
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
			 * Mounted only while open, so this pane - which redraws on every send -
			 * neither holds the dialog's state nor reaches the query layer until
			 * somebody asks to save. The mount is also the reset: a reopened dialog
			 * starts from this response rather than the last attempt.
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
