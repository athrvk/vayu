/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * RequestBuilderLayout Component
 *
 * Internal layout component that uses ResizablePanelGroup for the split between
 * the request editor and the response viewer - the response beside the request
 * or below it, per the `responsePosition` setting (issue #1711; `auto` is
 * resolved by `useResolvedResponsePosition` from this component's own width).
 *
 * Also handles the send shortcuts (Cmd/Ctrl+Enter, and Cmd/Ctrl+Shift+Enter for
 * a load test).
 *
 * The description no longer has a band of its own between the URL bar and the
 * tabs - it is the first request tab now. See `RequestTabs/panels/InfoPanel`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useGroupRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui";
import { useLayoutStore } from "@/stores";
import { useRequestBuilderContext } from "../context";
import { useResolvedResponsePosition } from "../hooks/useResolvedResponsePosition";
import { SEND_CHORD, LOAD_TEST_CHORD, matchesChord } from "@/constants/shortcuts";
import { DEFAULT_REQUEST_SPLIT_RATIO, STACKED_PANE_MIN_HEIGHT } from "@/constants/layout";
import { ownsEnterKey } from "@/lib/keyboard";
import { isModalOpen } from "@/lib/modal";
import { canSendRequest } from "../utils/send-gate";
import { TabBreadcrumb } from "@/components/shared";
import { useRequestCrumbs } from "./useRequestCrumbs";
import UrlBar from "./UrlBar";
import RequestTabs from "./RequestTabs";
import ResponseAnnouncer from "./ResponseAnnouncer";
import ResponseViewer from "./ResponseViewer";
import ExternalChangeNotice from "./ExternalChangeNotice";

/** A 0-1 share as a percentage number, without float noise. */
const share = (ratio: number) => Math.round(ratio * 10000) / 100;
/** The same share as the percentage string `defaultSize` wants. */
const percent = (ratio: number) => `${share(ratio)}%`;

export default function RequestBuilderLayout() {
	const { request, isExecuting, isStreaming, executeRequest, startLoadTest, canStartLoadTest } =
		useRequestBuilderContext();

	const containerRef = useRef<HTMLDivElement>(null);
	const arrangement = useResolvedResponsePosition(containerRef);
	const requestSplitRatio = useLayoutStore((s) =>
		arrangement === "beside" ? s.requestSplitRatioBeside : s.requestSplitRatioBelow
	);
	const setRequestSplitRatio = useLayoutStore((s) => s.setRequestSplitRatio);
	const groupRef = useGroupRef();

	// The collection chain plus this request's name - see `useRequestCrumbs`.
	const crumbs = useRequestCrumbs();

	/*
	 * Into the ratio for the arrangement that was dragged. The arrangement is
	 * captured with the ratio rather than read when the timer fires, so a flip
	 * inside the debounce window cannot file a Beside drag under Below.
	 */
	const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const debouncedSetRatio = useCallback(
		(ratio: number) => {
			if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
			saveTimeoutRef.current = setTimeout(
				() => setRequestSplitRatio(arrangement, ratio),
				200
			);
		},
		[setRequestSplitRatio, arrangement]
	);

	/*
	 * `defaultSize` is read once at mount, so a ratio that changes on a group
	 * that is already laid out has to go through the group's imperative handle.
	 */
	const applyRatio = useCallback(
		(ratio: number) => {
			groupRef.current?.setLayout({ request: share(ratio), response: share(1 - ratio) });
		},
		[groupRef]
	);

	/*
	 * Double-click on the divider: back to an even split, for this arrangement
	 * only.
	 */
	const resetSplit = useCallback(() => {
		setRequestSplitRatio(arrangement, DEFAULT_REQUEST_SPLIT_RATIO);
		applyRatio(DEFAULT_REQUEST_SPLIT_RATIO);
	}, [setRequestSplitRatio, arrangement, applyRatio]);

	/*
	 * A flip re-orients the group *in place* - the library re-lays out when its
	 * `orientation` prop changes - and this effect then applies the ratio the
	 * new arrangement owns. It is a layout effect so the new ratio is on screen
	 * in the same frame as the new orientation, and it skips the mount, where
	 * `defaultSize` has already done the job.
	 *
	 * Deliberately not a `key` on the group: a remount would tear down and
	 * rebuild the request editor and the response viewer, code editors and all,
	 * and that rebuild is a visible flash of the whole pane on every Auto flip
	 * while the window is being resized.
	 */
	const mountedArrangementRef = useRef(arrangement);
	useLayoutEffect(() => {
		if (mountedArrangementRef.current === arrangement) return;
		mountedArrangementRef.current = arrangement;
		const s = useLayoutStore.getState();
		applyRatio(arrangement === "beside" ? s.requestSplitRatioBeside : s.requestSplitRatioBelow);
	}, [arrangement, applyRatio]);

	/*
	 * Stacked minimums are pixels, side-by-side ones a share: 20% of a short
	 * window is a response pane that cannot show a status line and one row of
	 * body, where 20% of a wide window is still a usable column.
	 */
	const paneBounds =
		arrangement === "beside"
			? { minSize: "20%", maxSize: "80%" }
			: { minSize: STACKED_PANE_MIN_HEIGHT };

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
			 * Don't trigger if the request is already in flight or the URL is
			 * empty. The predicate lives in `utils/send-gate.ts` because the
			 * palette's Send row asks the same question through
			 * `SendRequestCommandSurface`, and the two must not drift (#1243); the
			 * reasoning behind it - in particular why `isStreaming` counts - is
			 * written there.
			 */
			if (!canSendRequest({ url: request.url, isExecuting, isStreaming })) return;

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
		<div ref={containerRef} className="h-full flex flex-col">
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
			<TabBreadcrumb label="Request location" crumbs={crumbs} />
			<UrlBar />

			{/* A field the user is editing that an external write (typically an
			    MCP agent) has changed to a different value (issue #1436). */}
			<ExternalChangeNotice />

			{/*
			 * Only a user's own drag is persisted (`isUserInteraction`) - the
			 * layout the library reports on mount, after a flip, or after a pixel
			 * minimum clamps a stacked pane, is not a preference anyone expressed.
			 */}
			<ResizablePanelGroup
				groupRef={groupRef}
				orientation={arrangement === "beside" ? "horizontal" : "vertical"}
				data-response-position={arrangement}
				className="flex-1"
				onLayoutChanged={(layout, meta) => {
					if (!meta.isUserInteraction) return;
					const first = layout.request;
					if (first !== undefined) debouncedSetRatio(first / 100);
				}}
			>
				{/* Request Editor Panel */}
				<ResizablePanel
					id="request"
					// react-resizable-panels v4 treats bare numbers as pixels - percentages must be strings
					defaultSize={percent(requestSplitRatio)}
					{...paneBounds}
					className="flex flex-col"
				>
					<RequestTabs />
				</ResizablePanel>

				<ResizableHandle withHandle onReset={resetSplit} />

				{/* Response Viewer Panel */}
				<ResizablePanel
					id="response"
					defaultSize={percent(1 - requestSplitRatio)}
					{...paneBounds}
					className="flex flex-col"
				>
					<ResponseViewer />
				</ResizablePanel>
			</ResizablePanelGroup>
		</div>
	);
}
