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
 * The inbox surface: a capture renders through the shared viewer, and a live
 * event appends to the same list the first fetch filled.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { mergeCapture } from "@/queries";
import type { InboxCapture, InboxCapturesResponse } from "@/types";
import { CaptureDetail } from "./CaptureDetail";
import { captureUrl } from "./utils";
import { parseCaptureEvent } from "./useInboxLive";

function capture(overrides: Partial<InboxCapture> = {}): InboxCapture {
	return {
		id: 1,
		inboxId: "inbox_a",
		receivedAt: 1700000000000,
		method: "POST",
		path: "/hooks/order",
		query: "attempt=2",
		headers: { "X-Signature": "sha256=abc" },
		body: '{"id":7}',
		bodyBytes: 8,
		bodyTruncated: false,
		remoteAddr: "127.0.0.1",
		...overrides,
	};
}

describe("captureUrl", () => {
	it("rebuilds the absolute URL the request arrived at", () => {
		expect(captureUrl(capture(), "http://127.0.0.1:4100/")).toBe(
			"http://127.0.0.1:4100/hooks/order?attempt=2"
		);
		// No query means no trailing "?" - it would be a different URL.
		expect(captureUrl(capture({ query: "" }), "http://127.0.0.1:4100")).toBe(
			"http://127.0.0.1:4100/hooks/order"
		);
	});
});

describe("CaptureDetail", () => {
	it("renders a capture as a request through the shared viewer", () => {
		render(<CaptureDetail capture={capture()} inboxUrl="http://127.0.0.1:4100/" />);

		expect(screen.getByText("POST")).toBeInTheDocument();
		expect(screen.getByText("http://127.0.0.1:4100/hooks/order?attempt=2")).toBeInTheDocument();
		// The raw HTTP text is built by the same helper outbound requests use.
		expect(screen.getByText(/POST \/hooks\/order\?attempt=2 HTTP\/1\.1/)).toBeInTheDocument();
		expect(screen.getByText(/X-Signature: sha256=abc/)).toBeInTheDocument();
	});

	it("says so when the stored body is only a prefix", () => {
		render(
			<CaptureDetail
				capture={capture({ bodyTruncated: true, bodyBytes: 100000 })}
				inboxUrl="http://127.0.0.1:4100/"
			/>
		);
		// Without this the pane shows a payload the sender never sent.
		expect(screen.getByText(/Truncated - 100000 bytes received/)).toBeInTheDocument();
	});

	it("asks for a selection rather than rendering an empty exchange", () => {
		render(<CaptureDetail capture={null} inboxUrl="http://127.0.0.1:4100/" />);
		expect(screen.getByText("No request selected")).toBeInTheDocument();
	});
});

describe("the live stream", () => {
	const page = (data: InboxCapture[]): InboxCapturesResponse => ({
		data,
		pagination: {
			total: data.length,
			limit: 50,
			offset: 0,
			hasMore: false,
			returned: data.length,
		},
	});

	it("prepends a streamed capture to the fetched page", () => {
		const merged = mergeCapture(page([capture({ id: 1 })]), capture({ id: 2 }));
		expect(merged.data.map((c) => c.id)).toEqual([2, 1]);
		expect(merged.pagination.total).toBe(2);
	});

	it("ignores a capture the page already holds", () => {
		// The first fetch and the stream overlap; a duplicate row is one the user
		// cannot tell from a second delivery of the same webhook.
		const merged = mergeCapture(page([capture({ id: 5 })]), capture({ id: 5 }));
		expect(merged.data).toHaveLength(1);
		expect(merged.pagination.total).toBe(1);
	});

	it("starts the list from an event when nothing was cached yet", () => {
		const merged = mergeCapture(undefined, capture({ id: 3 }));
		expect(merged.data.map((c) => c.id)).toEqual([3]);
		expect(merged.pagination.total).toBe(1);
	});

	it("drops a malformed event instead of inventing a row", () => {
		expect(parseCaptureEvent(null)).toBeNull();
		expect(parseCaptureEvent({ inboxId: "inbox_a", method: "POST", path: "/" })).toBeNull();
		expect(parseCaptureEvent({ id: 1, method: "POST", path: "/" })).toBeNull();

		const parsed = parseCaptureEvent({
			id: 4,
			inboxId: "inbox_a",
			method: "PUT",
			path: "/hook",
		});
		expect(parsed).not.toBeNull();
		// Absent optional fields take honest empties, not a guess.
		expect(parsed?.query).toBe("");
		expect(parsed?.bodyBytes).toBe(0);
		expect(parsed?.bodyTruncated).toBe(false);
	});
});
