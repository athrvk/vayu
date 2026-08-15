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
 * A sampled load-run stream's events, on the surfaces that show captured
 * samples (issue #657).
 *
 * The engine now parses a streamed sample's events back out of the body it
 * stored and serves them on `GET /runs/:id/samples`; before this, a load run's
 * stream was a wall of `data:` lines in the Body view and nothing else, while
 * the same exchange sent from the request builder got a readable timeline.
 *
 * Two properties are worth a test rather than a glance:
 *
 * - **The tab is gated on the node, not on the surface.** Almost every sampled
 *   row is not a stream, and an always-present Events tab reading "not an event
 *   stream" would be noise on all of them.
 * - **Truncation reaches the reader.** The list is a prefix whenever the capture
 *   was cut or the stored-events cap fired, and the sampled surfaces must show
 *   that the same way the request builder does - through the shared component,
 *   not through a second copy of the rule.
 */

import { describe, it, expect } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import UnifiedResponseViewer from "./UnifiedResponseViewer";
import SampleRequestCard from "@/modules/history/main/components/SampleRequestCard";
import type { RunSample } from "@/types/domain";
import type { SampleResult } from "@/modules/history/types";

type SampledEvents = NonNullable<RunSample["response"]["events"]>;

/**
 * Radix switches a tab on pointer-down, not on click - a `fireEvent.click`
 * leaves the panel where it was and every assertion after it reads the old one.
 */
function openEventsTab() {
	fireEvent.mouseDown(screen.getByRole("tab", { name: /events/i }));
}

const EVENTS: SampledEvents = {
	items: [
		{ event: "start", data: '{"n":1}' },
		{ event: "message", data: "second", sourceId: "42" },
	],
	totalEvents: 2,
	eventsTruncated: false,
};

const SAMPLE: SampleResult = {
	id: 7,
	timestamp: 1_700_000_000_000,
	statusCode: 200,
	statusText: "OK",
	latencyMs: 12,
};

function capture(events?: SampledEvents): RunSample {
	return {
		resultId: 7,
		response: {
			headers: { "content-type": "text/event-stream" },
			body: "data: second\n\n",
			bodyBytes: 14,
			contentType: "text/event-stream",
			events,
		},
	};
}

describe("UnifiedResponseViewer events tab", () => {
	it("shows the timeline for a sample that streamed", () => {
		render(
			<UnifiedResponseViewer
				response={{ body: "data: second\n\n", headers: {}, status: 200 }}
				events={EVENTS}
			/>
		);

		openEventsTab();
		expect(screen.getByText("2 events")).toBeInTheDocument();
		expect(screen.getByText("start")).toBeInTheDocument();
		expect(screen.getByText("id 42")).toBeInTheDocument();
		cleanup();
	});

	// The gate. Mutation-check: render the trigger unconditionally and this is
	// what reddens - every non-streaming sample in a run would grow a tab whose
	// only content is "not an event stream".
	it("has no events tab for a sample that did not stream", () => {
		render(
			<UnifiedResponseViewer response={{ body: '{"ok":true}', headers: {}, status: 200 }} />
		);

		expect(screen.queryByRole("tab", { name: /events/i })).not.toBeInTheDocument();
		expect(screen.getByRole("tab", { name: /response/i })).toBeInTheDocument();
		cleanup();
	});

	// A capture the byte budget cut, or a stream past `sseMaxStoredEvents`: the
	// engine sets `eventsTruncated`, and the reader has to be told rather than
	// left to compare two numbers.
	it("discloses a list that is only a prefix of the stream", () => {
		render(
			<UnifiedResponseViewer
				response={{ body: "data: one\n\n", headers: {}, status: 200 }}
				events={{ ...EVENTS, totalEvents: 400, eventsTruncated: true }}
			/>
		);

		openEventsTab();
		expect(screen.getByText("Events truncated for storage")).toBeInTheDocument();
		expect(screen.getByText(/400 events were received/)).toBeInTheDocument();
		cleanup();
	});

	it("renders a streamed sample that kept no body at all", () => {
		// Budget spent, headers kept - the events still came off the wire count
		// and the row must not fall through to "No response captured".
		render(<UnifiedResponseViewer response={null} events={EVENTS} />);

		expect(screen.queryByText("No response captured")).not.toBeInTheDocument();
		openEventsTab();
		expect(screen.getByText("start")).toBeInTheDocument();
		cleanup();
	});
});

describe("SampleRequestCard", () => {
	// The wiring itself. Mutation-check: drop the `events` prop in the card and
	// this fails while every other assertion in the file still passes - which is
	// precisely the "written but never read" shape, one layer out.
	it("hands a streamed capture's events to the viewer", () => {
		render(
			<SampleRequestCard
				sample={SAMPLE}
				index={0}
				isExpanded
				onToggle={() => {}}
				captured={capture(EVENTS)}
			/>
		);

		openEventsTab();
		expect(screen.getByText("start")).toBeInTheDocument();
		cleanup();
	});

	it("shows no events tab for a capture that did not stream", () => {
		render(
			<SampleRequestCard
				sample={SAMPLE}
				index={0}
				isExpanded
				onToggle={() => {}}
				captured={capture()}
			/>
		);

		expect(screen.queryByRole("tab", { name: /events/i })).not.toBeInTheDocument();
		cleanup();
	});
});
