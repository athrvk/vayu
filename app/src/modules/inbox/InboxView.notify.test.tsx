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
 * The inbox's own notification control (issue #1388).
 *
 * The toggle is here rather than in the Notifications settings panel because it
 * belongs to one listener, and the panel governs the events that happen once.
 * Two things are pinned: the control reads and writes the per-inbox store, and
 * the preferences of inboxes the engine has stopped listing do not accumulate -
 * an inbox id belongs to the engine process that minted it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useInboxNotifyStore } from "@/stores";
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

/** What the inbox list read answered, so a case can make it fail. */
const listing = { isSuccess: true, isError: false };

vi.mock("@/queries", () => ({
	useInboxesQuery: () => ({
		data: listing.isError ? undefined : [inbox],
		isError: listing.isError,
		isSuccess: listing.isSuccess,
		error: null,
		refetch: vi.fn(),
	}),
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

function toggle() {
	return screen.getByRole("switch", { name: "Notify on capture" });
}

beforeEach(() => {
	listing.isSuccess = true;
	listing.isError = false;
	useInboxNotifyStore.setState({ enabled: {} });
	vi.clearAllMocks();
});

describe("InboxView capture notifications", () => {
	it("offers the toggle off, and turns it on for this inbox alone", () => {
		render(<InboxView />);

		expect(toggle()).toHaveAttribute("aria-checked", "false");

		fireEvent.click(toggle());

		expect(useInboxNotifyStore.getState().enabled).toEqual({ inbox_a: true });
		expect(toggle()).toHaveAttribute("aria-checked", "true");
	});

	it("turns it back off", () => {
		useInboxNotifyStore.getState().setEnabled("inbox_a", true);
		render(<InboxView />);

		fireEvent.click(toggle());

		expect(useInboxNotifyStore.getState().enabled).toEqual({});
	});

	it("forgets the preference of an inbox the engine no longer lists", () => {
		// Mutation check: remove the `retainInboxes` effect and this entry - and
		// one for every inbox ever started - is persisted forever, unreachable,
		// because the engine mints a new id for every listener it opens.
		useInboxNotifyStore.setState({ enabled: { inbox_a: true, inbox_gone: true } });

		render(<InboxView />);

		expect(useInboxNotifyStore.getState().enabled).toEqual({ inbox_a: true });
	});

	it("keeps every preference when the list could not be read", () => {
		// "No inboxes" and "could not ask" are not the same answer, and only one
		// of them is evidence that an id is dead.
		listing.isSuccess = false;
		listing.isError = true;
		useInboxNotifyStore.setState({ enabled: { inbox_a: true, inbox_gone: true } });

		render(<InboxView />);

		expect(useInboxNotifyStore.getState().enabled).toEqual({
			inbox_a: true,
			inbox_gone: true,
		});
	});
});
