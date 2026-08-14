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
 * What the surface says when the live stream gives up (issue #506).
 *
 * The badge alone cannot carry this: a stream that died reads exactly like an
 * inbox nobody has sent anything to yet, and the state is permanent until the
 * tab is switched away and back. So a stream that is out of retries states
 * itself and offers the way back.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Inbox } from "@/types";
import type { InboxLiveState } from "./useInboxLive";

const inbox: Inbox = {
	inboxId: "inbox_a",
	url: "http://127.0.0.1:4100/",
	bind: "127.0.0.1",
	port: 4100,
	running: true,
	loopback: true,
	captureCount: 0,
	response: { status: 200, body: "", delayMs: 0, headers: {} },
};

const noop = { mutate: vi.fn(), isPending: false };

vi.mock("@/queries", () => ({
	useInboxesQuery: () => ({ data: [inbox], isError: false, error: null, refetch: vi.fn() }),
	useInboxCapturesQuery: () => ({
		data: {
			data: [],
			pagination: { total: 0, limit: 50, offset: 0, returned: 0, hasMore: false },
		},
	}),
	useLoadMoreInboxCapturesMutation: () => noop,
	useStartInboxMutation: () => noop,
	useStopInboxMutation: () => noop,
	useDeleteInboxMutation: () => noop,
	useUpdateInboxResponseMutation: () => noop,
	useClearInboxCapturesMutation: () => noop,
}));

const live: InboxLiveState = { watching: false, stopped: false, resume: vi.fn() };
vi.mock("./useInboxLive", () => ({ useInboxLive: () => live }));

const { default: InboxView } = await import("./index");

beforeEach(() => {
	live.watching = false;
	live.stopped = false;
	vi.clearAllMocks();
});

describe("InboxView live state", () => {
	it("says nothing while the stream is healthy", () => {
		live.watching = true;
		render(<InboxView />);

		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(screen.queryByText(/Live updates stopped/)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
	});

	it("states a stream that gave up, and resumes it on request", () => {
		live.stopped = true;
		render(<InboxView />);

		// The badge on its own would read "Running" - a listener with nothing
		// arriving - which is exactly the silent demotion this callout replaces.
		expect(screen.getByText("Running")).toBeInTheDocument();
		expect(screen.getByText(/Live updates stopped/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Resume" }));
		expect(live.resume).toHaveBeenCalledTimes(1);
	});
});
