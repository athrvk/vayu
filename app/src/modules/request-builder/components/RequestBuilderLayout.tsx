/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBuilderLayout Component
 *
 * Internal layout component that uses ResizablePanelGroup for the vertical split between
 * request editor (left) and response viewer (right).
 *
 * Also handles the send shortcuts (Cmd/Ctrl+Enter, and Cmd/Ctrl+Shift+Enter for
 * a load test).
 *
 * The description no longer has a band of its own between the URL bar and the
 * tabs - it is the first request tab now. See `RequestTabs/panels/InfoPanel`.
 */

import { useCallback, useEffect, useRef } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui";
import { useLayoutStore } from "@/stores";
import { useRequestBuilderContext } from "../context";
import { SEND_CHORD, LOAD_TEST_CHORD, matchesChord } from "@/constants/shortcuts";
import { ownsEnterKey } from "@/lib/keyboard";
import { isModalOpen } from "@/lib/modal";
import RequestBreadcrumb from "./RequestBreadcrumb";
import UrlBar from "./UrlBar";
import RequestTabs from "./RequestTabs";
import ResponseAnnouncer from "./ResponseAnnouncer";
import ResponseViewer from "./ResponseViewer";

export default function RequestBuilderLayout() {
	const { request, isExecuting, isStreaming, executeRequest, startLoadTest, canStartLoadTest } =
		useRequestBuilderContext();

	const { requestSplitRatio, setRequestSplitRatio } = useLayoutStore();

	const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const debouncedSetRatio = useCallback(
		(ratio: number) => {
			if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
			saveTimeoutRef.current = setTimeout(() => setRequestSplitRatio(ratio), 200);
		},
		[setRequestSplitRatio]
	);

	/*
	 * Send and Load Test from the keyboard.
	 *
	 * Both chords live in `constants/shortcuts.ts` so the buttons that advertise
	 * them and the handler that fires them read the same definition. `mod+Enter`
	 * sends; `mod+shift+Enter` starts a load test.
	 *
	 * `matchesChord` compares `shift` strictly rather than ignoring it. Without
	 * that, `mod+shift+Enter` also satisfies Send's `mod+Enter` and both fire -
	 * the one failure a modifier-distinguished pair must not have.
	 *
	 * The editor exclusions are Send's original ones, and they apply to both:
	 * a plain input (the URL) should still send, but a textarea, a Monaco editor
	 * or a contenteditable owns Enter for its own purposes. They live in
	 * `ownsEnterKey` so the collection tree's parallel guard reads the same list.
	 *
	 * A modal is the exclusion those three could not express: a dialog's name
	 * field is a plain input, so it passed the guard and sent the request behind
	 * the dialog (#935). `isModalOpen` is the one predicate both window handlers
	 * consult - this one and the Shell's.
	 */
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const isSend = matchesChord(event, SEND_CHORD);
			const isLoadTest = matchesChord(event, LOAD_TEST_CHORD);
			if (!isSend && !isLoadTest) return;

			if (ownsEnterKey(event.target as HTMLElement)) return;
			if (isModalOpen()) return;

			/*
			 * Don't trigger if the request is already in flight or URL is empty.
			 *
			 * `isStreaming` is the second half of "in flight": once the engine has
			 * answered and the socket is open, `isExecuting` goes false while the
			 * run is very much still running (`RequestBuilderProvider` clears it
			 * deliberately, so the Events tab is not hidden behind "Sending…").
			 * Send *is* Stop for the whole of that window (#574), and the chord now
			 * matches the button: it does nothing rather than silently replacing
			 * the open stream with a new one - the run being replaced being exactly
			 * the one the button in front of you would stop. Stopping is
			 * destructive, so it stays a deliberate click.
			 */
			if (isExecuting || isStreaming || request.url.trim().length === 0) return;

			if (isSend) {
				event.preventDefault();
				executeRequest();
				return;
			}
			/*
			 * The same gate the Load Test button honours. A detached copy of a
			 * past design run is mounted without an `onStartLoadTest` handler, so
			 * the button is hidden entirely - and a shortcut that still fired
			 * would be an action with no visible affordance, on the one screen
			 * where it is deliberately unavailable.
			 */
			if (!canStartLoadTest) return;
			event.preventDefault();
			startLoadTest();
		};

		window.addEventListener("keydown", handleKeyDown);

		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [request.url, isExecuting, isStreaming, executeRequest, startLoadTest, canStartLoadTest]);

	return (
		<div className="h-full flex flex-col">
			{/*
			 * Rendered unconditionally and outside the panels: the live region has
			 * to exist before the response does, and it must survive the response
			 * pane swapping between its loading, error and content states.
			 */}
			<ResponseAnnouncer />

			{/* Where this request lives, then the URL bar. The crumb renders
			    nothing at all for a request with no collection and no name, so
			    the header does not grow a permanent empty line - the mistake the
			    description band made here before it became the Info tab. */}
			<RequestBreadcrumb />
			<UrlBar />

			{/* Main content area with resizable panels */}
			<ResizablePanelGroup
				orientation="horizontal"
				className="flex-1"
				onLayoutChanged={(layout) => {
					const first = Object.values(layout)[0];
					if (first !== undefined) debouncedSetRatio(first / 100);
				}}
			>
				{/* Request Editor Panel */}
				<ResizablePanel
					// react-resizable-panels v4 treats bare numbers as pixels - percentages must be strings
					defaultSize={`${requestSplitRatio * 100}%`}
					minSize="20%"
					maxSize="80%"
					className="flex flex-col"
				>
					<RequestTabs />
				</ResizablePanel>

				<ResizableHandle withHandle />

				{/* Response Viewer Panel */}
				<ResizablePanel
					defaultSize={`${(1 - requestSplitRatio) * 100}%`}
					minSize="20%"
					maxSize="80%"
					className="flex flex-col"
				>
					<ResponseViewer />
				</ResizablePanel>
			</ResizablePanelGroup>
		</div>
	);
}
