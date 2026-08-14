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

import { useMemo, useState } from "react";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	TabLabel,
	TabCount,
	TabErrorDot,
	Badge,
	Kbd,
} from "@/components/ui";
import { useRequestBuilderContext } from "../../context";
import { useExecutionEventsStore } from "@/stores";
import { modKey } from "@/lib/platform";
import {
	ResponseBody as SharedResponseBody,
	ResponseStatusBar,
	ResponseActions,
	ResponseHeadersPanel,
	formatSize,
} from "@/components/shared/response-viewer";
import { Callout, EmptyState } from "@/components/shared";
import ResponseCookies from "./ResponseCookies";
import ResponseEvents from "./ResponseEvents";
import ResponseTimingTab from "./ResponseTimingTab";
import ConsoleOutput from "./ConsoleOutput";
import TestResults from "./TestResults";
import RawRequestResponse from "./RawRequestResponse";
import ClientErrorView from "./ClientErrorView";
import type { ResponseState } from "../../types";

type ResponseTab =
	| "body"
	| "headers"
	| "cookies"
	| "timing"
	| "console"
	| "tests"
	| "events"
	| "raw-request";

export default function ResponseViewer() {
	const { request, response, isExecuting } = useRequestBuilderContext();
	const [activeTab, setActiveTab] = useState<ResponseTab>("body");

	/*
	 * The live stream, when it is this request's (issue #574).
	 *
	 * Selected against the request on screen for the same reason the provider
	 * does it: one builder serves every request tab, and rows from a stream
	 * started elsewhere must not appear under this one.
	 */
	const requestId = request.id ?? null;
	const streamIsMine = useExecutionEventsStore(
		(s) => !!s.requestId && !!requestId && s.requestId === requestId
	);
	const liveOpen = useExecutionEventsStore((s) => s.open);
	const liveEvents = useExecutionEventsStore((s) => s.events);
	const liveIsStreaming = useExecutionEventsStore((s) => s.isStreaming);
	const liveEndReason = useExecutionEventsStore((s) => s.endReason);
	const liveTotalEvents = useExecutionEventsStore((s) => s.totalEvents);
	const liveError = useExecutionEventsStore((s) => s.error);

	const isStreaming = streamIsMine && liveIsStreaming;

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
			body: "",
			bodyType: "text" as const,
			size: 0,
			time: 0,
		};
	}, [response, streamIsMine, liveOpen]);

	const shown = response ?? streamedResponse;

	// Loading state. A stream that has been accepted but whose headers have not
	// arrived belongs here too: the send is over - `isExecuting` was cleared
	// when the engine answered - but there is genuinely nothing to draw yet.
	if (isExecuting || (isStreaming && !shown)) {
		return (
			<div className="flex-1 flex items-center justify-center bg-panel">
				<div className="text-center space-y-4">
					<div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-[vayu-spin_0.7s_linear_infinite] mx-auto" />
					<p className="text-xs text-muted-foreground">
						{isStreaming ? "Opening the event stream…" : "Sending request…"}
					</p>
				</div>
			</div>
		);
	}

	// Empty state
	if (!shown) {
		return (
			<div className="flex-1 flex items-center justify-center bg-panel">
				<div className="flex flex-col items-center text-center">
					<svg
						width="64"
						height="64"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="text-primary mb-5"
					>
						<line x1="22" y1="2" x2="11" y2="13" />
						<polygon points="22 2 15 22 11 13 2 9 22 2" />
					</svg>

					<p className="text-md font-medium text-foreground mb-1.5">No response yet</p>
					<div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
						<span>Press</span>
						<Kbd>{modKey}</Kbd>
						<Kbd>↵</Kbd>
						<span>or click Send</span>
					</div>
				</div>
			</div>
		);
	}

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
	 * empty state in particular was deleted earlier in this same branch for being
	 * unreachable - this is what makes it reachable.
	 */
	const consoleLogCount = shown.consoleLogs?.length ?? 0;
	const hasScriptError = !!shown.preScriptError || !!shown.postScriptError;
	const testResults = shown.testResults ?? [];

	/*
	 * Two sources, one list (issue #574) - the handoff `ScenarioRunView` makes.
	 *
	 * The stored list wins the moment there is one: a finished run's trace is
	 * the record, and it is the only copy carrying the truthful `totalEvents` /
	 * `eventsTruncated` markers. `??`, not a length check: a stream that ended
	 * having received nothing stores `[]`, and that is an answer, not an absence
	 * to fall back from.
	 *
	 * `isStream` is what separates "not a stream" from "a stream with no events
	 * yet", and it is true for either source - a restored run whose trace has an
	 * `events` node, or a live one belonging to this request.
	 */
	const storedEvents = shown.events;
	const events = storedEvents ?? (streamIsMine ? liveEvents : []);
	const isStream = storedEvents !== undefined || streamIsMine;
	const totalEvents = storedEvents ? shown.totalEvents : (liveTotalEvents ?? undefined);
	const eventsTruncated = storedEvents ? shown.eventsTruncated : false;
	const endReason = storedEvents
		? shown.streamEndReason
		: (streamIsMine && liveEndReason) || undefined;

	// Client-side error state (status === 0 means no server response)
	const isClientError = shown.status === 0;

	// Show dedicated error view for client-side errors
	if (isClientError) {
		return (
			<div className="flex-1 flex flex-col surface-card overflow-hidden">
				<ResponseStatusBar
					status={shown.status}
					statusText={shown.statusText}
					time={shown.time}
					size={shown.size}
					receivedAt={shown.receivedAt}
					restoredFrom={shown.restoredFrom}
				/>
				<ClientErrorView errorCode={shown.errorCode} errorMessage={shown.errorMessage} />
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col surface-card overflow-hidden">
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
				status={shown.status}
				statusText={shown.statusText}
				time={shown.time}
				size={shown.size}
				httpVersion={shown.httpVersion}
				httpVersionDowngraded={shown.httpVersionDowngraded}
				receivedAt={shown.receivedAt}
				restoredFrom={shown.restoredFrom}
				// Only while it is actually live. A finished stream's band shows
				// the exchange it completed, and the Events tab is where its
				// count and its end reason live.
				streaming={isStreaming ? { events: events.length } : undefined}
			/>

			{/* Response Tabs */}
			<Tabs
				value={activeTab}
				onValueChange={(v) => setActiveTab(v as ResponseTab)}
				className="flex-1 flex flex-col overflow-hidden"
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
					    `min-w-0`, or the tabs cannot scroll. A flex item defaults to
					    `min-width: auto` and refuses to shrink below its content, so
					    `overflow-x-auto` never engages and the row overflows instead -
					    pushing the status and actions out of the pane. It mattered less
					    when the right-hand group was just the actions; it matters now
					    that the response's own facts live there.
					 */}
					<TabsList className="min-w-0 overflow-x-auto overflow-y-hidden flex-nowrap">
						<TabsTrigger value="body">
							<TabLabel>Body</TabLabel>
						</TabsTrigger>
						<TabsTrigger value="headers">
							<TabLabel>Headers</TabLabel>
							<TabCount value={Object.keys(shown.headers).length} />
						</TabsTrigger>
						<TabsTrigger value="cookies">
							<TabLabel>Cookies</TabLabel>
						</TabsTrigger>
						<TabsTrigger value="timing">
							<TabLabel>Timing</TabLabel>
						</TabsTrigger>
						{/*
						 * No icon. This was the only one across the fifteen triggers in
						 * the two strips - the response pane's seven and the request
						 * builder's eight - so it read as Console being a different
						 * *kind* of thing rather than as an aid to finding it. What
						 * actually distinguishes this tab when it matters is the error
						 * dot below, which the icon sat next to and competed with.
						 *
						 * It was also 20px on a strip that had just gained four
						 * permanent tabs, though that is the smaller reason.
						 */}
						<TabsTrigger value="console">
							<TabLabel>Console</TabLabel>
							{hasScriptError ? (
								// A script error that logged nothing must still be flagged
								// (issue #111). A dot rather than a count, so a future
								// `count="none"` cannot silently delete the only failure
								// signal - and it outranks the count, because the failure is
								// the thing you need to see.
								<TabErrorDot />
							) : (
								<TabCount value={consoleLogCount} />
							)}
						</TabsTrigger>
						<TabsTrigger value="tests">
							<TabLabel>Tests</TabLabel>
							{/* A result, not a count - it keeps its chip. No chip at all when
							    nothing ran, rather than a "0/0" that reads like a result. */}
							{testResults.length > 0 && (
								<Badge
									variant={
										testResults.every((t) => t.passed)
											? "default"
											: "destructive"
									}
									className="ml-0.5 h-4 px-1 text-[10px]"
								>
									{testResults.filter((t) => t.passed).length}/
									{testResults.length}
								</Badge>
							)}
						</TabsTrigger>
						{/*
						 * Always rendered, like the seven beside it (issue #59's
						 * constant tab set) - a normal response gets an honest
						 * "not an event stream" rather than a tab that comes and
						 * goes. The count is the *received* total, which is not
						 * the row count once a stored list has been capped.
						 */}
						<TabsTrigger value="events">
							<TabLabel>Events</TabLabel>
							<TabCount value={totalEvents ?? events.length} />
						</TabsTrigger>
						<TabsTrigger value="raw-request">
							<TabLabel>Raw</TabLabel>
						</TabsTrigger>
					</TabsList>
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
									Only the first {formatSize(shown.body.length)} of{" "}
									{formatSize(shown.bodyBytes ?? shown.body.length)} was kept.
									Re-send the request to view the full response.
								</Callout>
							</div>
						)}
						<div className="flex-1 min-h-0">
							<SharedResponseBody
								body={shown.body}
								bodyRaw={shown.bodyRaw}
								headers={shown.headers}
								showModeToggle
								/*
								 * Copy and download live *here*, not on the tab row.
								 *
								 * They act on the body - `content={shown.body}` - and
								 * always did, so on the tab row they sat above Headers,
								 * Timing and Raw claiming to act on whatever you were
								 * looking at while copying something else. Moving them
								 * beside the Pretty/Raw switch puts them with the thing
								 * they operate on, and gives the tab strip back the ~64px
								 * they were taking, which is what let all seven tabs
								 * render without the strip scrolling.
								 *
								 * `shown.bodyType` names the download; the history
								 * viewer has no such field and keeps `.txt`.
								 */
								actions={
									<ResponseActions
										content={shown.body}
										fileExtension={shown.bodyType}
									/>
								}
							/>
						</div>
					</div>
				</TabsContent>
				<TabsContent value="headers" className="mt-0 flex-1 overflow-hidden">
					<ResponseHeadersPanel
						requestHeaders={shown.requestHeaders}
						responseHeaders={shown.headers}
					/>
				</TabsContent>
				<TabsContent value="cookies" className="mt-0 flex-1 overflow-hidden">
					<ResponseCookies headers={shown.headers} />
				</TabsContent>
				<TabsContent value="timing" className="mt-0 flex-1 overflow-hidden">
					{shown.timing ? (
						<ResponseTimingTab timing={shown.timing} />
					) : (
						<EmptyState variant="inline" title="No timing recorded" />
					)}
				</TabsContent>
				<TabsContent value="console" className="mt-0 flex-1 overflow-hidden">
					<ConsoleOutput
						logs={shown.consoleLogs || []}
						errors={{
							pre: shown.preScriptError,
							post: shown.postScriptError,
						}}
					/>
				</TabsContent>
				<TabsContent value="tests" className="mt-0 flex-1 overflow-hidden">
					{testResults.length > 0 ? (
						<TestResults results={testResults} />
					) : (
						<EmptyState
							variant="inline"
							title="No tests ran"
							description="Assertions written in the request's Tests script show up here."
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
						error={streamIsMine ? liveError : null}
					/>
				</TabsContent>
				<TabsContent value="raw-request" className="mt-0 flex-1 overflow-hidden">
					<RawRequestResponse rawRequest={shown.rawRequest || ""} response={shown} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
