/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Where the response pane goes (issue #1711): beside the request, below it,
 * or whichever the builder's own width calls for.
 *
 * Six combinations - three settings, two widths - each asserted on the
 * arrangement the panel group actually draws. Mutation check: hard-code
 * `orientation="horizontal"` back in `RequestBuilderLayout` and the Below
 * cases and the narrow Auto case fail.
 *
 * jsdom lays nothing out, so the width is what `getBoundingClientRect` is
 * made to say; the `ResizeObserver` is a recording stub so the test can push a
 * resize through the same path the browser would.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import RequestBuilderLayout from "./RequestBuilderLayout";
import { useLayoutStore, type ResponsePosition } from "@/stores";
import {
	AUTO_RESPONSE_BELOW_MAX_WIDTH,
	AUTO_RESPONSE_HYSTERESIS,
	DEFAULT_REQUEST_SPLIT_RATIO,
} from "@/constants/layout";

vi.mock("../context", () => ({
	useRequestBuilderContext: () => ({
		request: { url: "https://example.com" },
		isExecuting: false,
		isStreaming: false,
		executeRequest: vi.fn(),
		startLoadTest: vi.fn(),
		canStartLoadTest: true,
	}),
}));
vi.mock("./useRequestCrumbs", () => ({ useRequestCrumbs: () => [] }));
vi.mock("./UrlBar", () => ({ default: () => <div data-testid="url-bar" /> }));
vi.mock("./ExternalChangeNotice", () => ({ default: () => null }));
vi.mock("./RequestTabs", () => ({ default: () => <div data-testid="request-tabs" /> }));
vi.mock("./ResponseAnnouncer", () => ({ default: () => <div data-testid="announcer" /> }));
vi.mock("./ResponseViewer", () => ({ default: () => <div data-testid="response-viewer" /> }));

/**
 * `defaultSize` is read once, at mount, and jsdom gives the group no size to
 * apply it against - the library falls back to an even flex split whatever
 * the prop said - so the seeding is asserted on the prop each panel was
 * mounted with rather than on a style the DOM cannot show.
 */
const panelDefaultSizes: Record<string, unknown> = {};
vi.mock("react-resizable-panels", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react-resizable-panels")>();
	const Panel = (props: React.ComponentProps<typeof actual.Panel>) => {
		if (typeof props.id === "string") panelDefaultSizes[props.id] = props.defaultSize;
		return <actual.Panel {...props} />;
	};
	return { ...actual, Panel };
});

const WIDE = AUTO_RESPONSE_BELOW_MAX_WIDTH + 400;
const NARROW = AUTO_RESPONSE_BELOW_MAX_WIDTH - 200;

/** What every element reports as its width until the test says otherwise. */
let measuredWidth = WIDE;

/**
 * Every observer anything registered, with what it watches. The panel library
 * registers observers of its own on the group and its panels, so the hook's is
 * found by its target: the layout's root element.
 */
const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];

class RecordingResizeObserver {
	private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
	constructor(callback: ResizeObserverCallback) {
		this.entry = { callback, targets: [] };
		observers.push(this.entry);
	}
	observe(target: Element) {
		this.entry.targets.push(target);
	}
	unobserve() {}
	disconnect() {}
}

const observerOf = (root: Element | null) =>
	observers.find((entry) => root !== null && entry.targets.includes(root));

function renderAt(position: ResponsePosition, width: number) {
	measuredWidth = width;
	useLayoutStore.setState({ responsePosition: position, autoResponseArrangement: "beside" });
	const result = render(<RequestBuilderLayout />);
	const group = result.container.querySelector("[data-group]");
	if (!(group instanceof HTMLElement)) throw new Error("no panel group rendered");
	return { ...result, group };
}

const arrangementOf = (group: HTMLElement) => ({
	orientation: group.getAttribute("data-orientation"),
	position: group.getAttribute("data-response-position"),
});

beforeEach(() => {
	observers.length = 0;
	vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() =>
			({
				width: measuredWidth,
				height: 600,
				top: 0,
				left: 0,
				right: measuredWidth,
				bottom: 600,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			}) as DOMRect
	);
	useLayoutStore.setState({
		requestSplitRatioBeside: DEFAULT_REQUEST_SPLIT_RATIO,
		requestSplitRatioBelow: DEFAULT_REQUEST_SPLIT_RATIO,
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("RequestBuilderLayout response position", () => {
	it.each([
		["beside", WIDE, "horizontal", "beside"],
		["beside", NARROW, "horizontal", "beside"],
		["below", WIDE, "vertical", "below"],
		["below", NARROW, "vertical", "below"],
		["auto", WIDE, "horizontal", "beside"],
		["auto", NARROW, "vertical", "below"],
	] as const)("draws %s at %ipx as the %s group", (position, width, orientation, arrangement) => {
		const { group } = renderAt(position, width);
		expect(arrangementOf(group)).toEqual({ orientation, position: arrangement });
	});

	it("measures only while the setting is auto", () => {
		const beside = renderAt("beside", NARROW);
		expect(observerOf(beside.container.firstElementChild)).toBeUndefined();
		cleanup();
		const auto = renderAt("auto", NARROW);
		expect(observerOf(auto.container.firstElementChild)).toBeDefined();
	});

	it("re-arranges when the builder is resized across the threshold, with a band on the way back", () => {
		const { container } = renderAt("auto", WIDE);
		const observer = observerOf(container.firstElementChild);
		if (!observer) throw new Error("the layout is not observing its own width");
		const fire = () => act(() => observer.callback([], {} as ResizeObserver));
		const current = () =>
			container.querySelector("[data-group]")?.getAttribute("data-response-position");

		measuredWidth = AUTO_RESPONSE_BELOW_MAX_WIDTH - 1;
		fire();
		expect(current()).toBe("below");

		// Back over the threshold but inside the band: still stacked, so a drag
		// hovering at the edge does not flap.
		measuredWidth = AUTO_RESPONSE_BELOW_MAX_WIDTH + AUTO_RESPONSE_HYSTERESIS - 1;
		fire();
		expect(current()).toBe("below");

		measuredWidth = AUTO_RESPONSE_BELOW_MAX_WIDTH + AUTO_RESPONSE_HYSTERESIS;
		fire();
		expect(current()).toBe("beside");
	});

	it("writes auto's pick to the store, where the Dock button reads it", () => {
		renderAt("auto", NARROW);
		expect(useLayoutStore.getState().autoResponseArrangement).toBe("below");
	});

	it("seeds each arrangement from its own ratio", () => {
		useLayoutStore.setState({ requestSplitRatioBeside: 0.3, requestSplitRatioBelow: 0.7 });
		renderAt("beside", WIDE);
		expect(panelDefaultSizes).toEqual({ request: "30%", response: "70%" });
		cleanup();
		renderAt("below", WIDE);
		expect(panelDefaultSizes).toEqual({ request: "70%", response: "30%" });
	});

	it("double-clicking the divider resets this arrangement's ratio to even, and only this one", () => {
		useLayoutStore.setState({ requestSplitRatioBeside: 0.3, requestSplitRatioBelow: 0.7 });
		const { container } = renderAt("below", WIDE);
		const divider = container.querySelector('[role="separator"]');
		if (!divider) throw new Error("no divider rendered");
		fireEvent.doubleClick(divider);
		expect(useLayoutStore.getState().requestSplitRatioBelow).toBe(DEFAULT_REQUEST_SPLIT_RATIO);
		expect(useLayoutStore.getState().requestSplitRatioBeside).toBe(0.3);
	});
});
