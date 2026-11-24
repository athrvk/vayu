/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The split between the request editor and the response viewer: beside or below, per the
 * `responsePosition` setting (#1711; `useResolvedResponsePosition` resolves `auto` from this
 * component's width). Also the send chords: Cmd/Ctrl+Enter, and Cmd/Ctrl+Shift+Enter for a load
 * test. The description is the first request tab (`RequestTabs/panels/InfoPanel`), not a band here.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useGroupRef } from "react-resizable-panels";
import {
	HeadingSection,
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui";
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
	 * Saves into the dragged arrangement's ratio. The arrangement is captured with the ratio, not
	 * read when the timer fires, so a flip inside the debounce cannot file a Beside drag under
	 * Below.
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

	// `defaultSize` is read once at mount, so a ratio change on a laid-out group goes through the
	// handle.
	const applyRatio = useCallback(
		(ratio: number) => {
			groupRef.current?.setLayout({ request: share(ratio), response: share(1 - ratio) });
		},
		[groupRef]
	);

	// Double-click on the divider: an even split, for this arrangement only.
	const resetSplit = useCallback(() => {
		setRequestSplitRatio(arrangement, DEFAULT_REQUEST_SPLIT_RATIO);
		applyRatio(DEFAULT_REQUEST_SPLIT_RATIO);
	}, [setRequestSplitRatio, arrangement, applyRatio]);

	/*
	 * A flip re-orients the group in place (the library re-lays out on an `orientation` change),
	 * and this effect applies the new arrangement's ratio: a layout effect, so it lands in the same
	 * frame, skipping the mount, where `defaultSize` did it. Not a `key` on the group: a remount
	 * rebuilds both panes, code editors and all, a visible flash on every Auto flip while the
	 * window resizes.
	 */
	const mountedArrangementRef = useRef(arrangement);
	useLayoutEffect(() => {
		if (mountedArrangementRef.current === arrangement) return;
		mountedArrangementRef.current = arrangement;
		const s = useLayoutStore.getState();
		applyRatio(arrangement === "beside" ? s.requestSplitRatioBeside : s.requestSplitRatioBelow);
	}, [arrangement, applyRatio]);

	/*
	 * Stacked minimums are pixels, side-by-side ones a share: 20% of a short window cannot show a
	 * status line and a body row, where 20% of a wide one is a usable column.
	 */
	const paneBounds =
		arrangement === "beside"
			? { minSize: "20%", maxSize: "80%" }
			: { minSize: STACKED_PANE_MIN_HEIGHT };

	/*
	 * Send and Load Test from the keyboard. Both chords are in `constants/shortcuts.ts`, so the
	 * buttons advertising them and this handler read one definition. `matchesChord` compares
	 * `shift` strictly: otherwise `mod+shift+Enter` also satisfies Send's `mod+Enter` and both
	 * fire.
	 *
	 * Both obey Send's editor exclusions: a plain input (the URL) sends, but a textarea, Monaco or
	 * a contenteditable owns Enter. They are `ownsEnterKey`, so the collection tree's guard reads
	 * the same list. A modal is what those cannot express: a dialog's name field is a plain input,
	 * so it passed the guard and sent the request behind the dialog (#935). `isModalOpen` is the
	 * one predicate both window handlers (this and the Shell's) consult.
	 */
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const isSend = matchesChord(event, SEND_CHORD);
			const isLoadTest = matchesChord(event, LOAD_TEST_CHORD);
			if (!isSend && !isLoadTest) return;

			if (ownsEnterKey(event.target as HTMLElement)) return;
			if (isModalOpen()) return;

			/*
			 * Not while a request is in flight or the URL is empty. The predicate is in
			 * `utils/send-gate.ts` because the palette's Send row (`SendRequestCommandSurface`)
			 * asks the same and must not drift (#1243); why `isStreaming` counts is written there.
			 */
			if (!canSendRequest({ url: request.url, isExecuting, isStreaming })) return;

			if (isSend) {
				event.preventDefault();
				executeRequest();
				return;
			}
			/*
			 * The Load Test button's gate. A detached past design run has no `onStartLoadTest`, so
			 * the button is hidden, and a shortcut that still fired would be an action with no
			 * affordance on the one screen where it is deliberately unavailable.
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
			 * Unconditional and outside the panels: the live region must exist before the response
			 * does and survive the pane's loading, error and content swaps.
			 */}
			<ResponseAnnouncer />

			{/*
			 * Where the request lives, then the URL bar. The crumb renders nothing for a request
			 * with no collection and no name, so the header grows no permanent empty line.
			 */}
			<TabBreadcrumb label="Request location" crumbs={crumbs} titlesPane />
			<HeadingSection>
				<UrlBar />

				{/*
				 * A field being edited that an external write (typically an MCP agent) changed
				 * (#1436).
				 */}
				<ExternalChangeNotice />

				{/*
				 * Only the user's own drag is persisted (`isUserInteraction`): the layout reported
				 * on mount, after a flip, or after a pixel minimum clamps a stacked pane is no
				 * one's preference.
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
						// react-resizable-panels v4 reads bare numbers as pixels; percentages must
						// be strings.
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
			</HeadingSection>
		</div>
	);
}
