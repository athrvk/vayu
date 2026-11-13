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
import { act, fireEvent, render as renderBare, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { TooltipProvider } from "@/components/ui";
import { useEngineStore } from "@/stores";
import type { Inbox } from "@/types";
import type { InboxLiveState } from "./useInboxLive";
import { asTab, expectOneTopHeading } from "@/test/heading-outline.testkit";

/**
 * The app mounts one `TooltipProvider` at its root (`main.tsx`), so a panel
 * rendered bare is in a state the app is never in - and since #1690 a gated
 * control inside one carries a real tooltip, which throws without it. Every
 * render in this file goes through the provider, the way the app does.
 */
function render(ui: ReactElement, options?: Parameters<typeof renderBare>[1]) {
	return renderBare(ui, { wrapper: TooltipProvider, ...options });
}

const inbox: Inbox = {
	inboxId: "inbox_a",
	url: "http://127.0.0.1:4100/",
	bind: "127.0.0.1",
	port: 4100,
	running: true,
	loopback: true,
	captureCount: 0,
	allowedOrigins: [],
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
	// The header reads running only while the engine is up (`useEngineServing`).
	useEngineStore.setState({
		engineStatus: "connected",
		engineCrash: null,
		engineCrashAheadOfPoll: false,
	});
});

// One top heading per tab (#3498): the address, prefixed with what it is the
// address of, and the capture pane's headings one level under it.
describe("InboxView headings", () => {
	it("titles the tab with the inbox's address as its one h1", () => {
		const { container } = render(asTab(<InboxView />));
		expect(expectOneTopHeading(container)).toBe(`Webhook inbox ${inbox.url}`);
		expect(
			screen.getByRole("heading", { level: 2, name: "No request selected" })
		).toBeVisible();
	});
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

/**
 * #3506. The cached record keeps `running: true` after the engine that held the
 * listener died, so the header, the Stop action and the canned-response editor
 * have to read the same gate the services drawer does (`useEngineServing`).
 *
 * Both kinds of evidence count: the poll's `unreachable`, and a crash the
 * sidecar pushed while the poll still reads `connected`.
 *
 * Mutation-check: read `inbox.running` alone in `index.tsx` and every case here
 * shows Live or Running with a Stop button again.
 */
describe("InboxView while Vayu's engine is down", () => {
	const CRASH = { code: null, signal: "SIGKILL", stderrTail: [], error: null };

	it.each([
		[
			"the poll reads it unreachable",
			() => useEngineStore.setState({ engineStatus: "unreachable" }),
		],
		[
			"the sidecar reported a crash the poll has not seen",
			() => useEngineStore.getState().setEngineCrash(CRASH),
		],
	])("reads Stopped, with no Stop action, when %s", (_, goDown) => {
		live.watching = true;
		render(<InboxView />);
		// Warm and live first, so the case proves the gate and not a slow render.
		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

		act(goDown);

		expect(screen.getByText("Stopped")).toBeInTheDocument();
		expect(screen.queryByText("Live")).not.toBeInTheDocument();
		expect(screen.queryByText("Running")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start new" })).toBeInTheDocument();
		// The canned-response editor is the stopped one: nothing is being served.
		expect(
			screen.getByText(/This inbox is stopped, so nothing is being served/)
		).toBeInTheDocument();
	});

	it("reads Running again once the poll answers after the crash", () => {
		useEngineStore.getState().setEngineCrash(CRASH);
		render(<InboxView />);
		expect(screen.getByText("Stopped")).toBeInTheDocument();

		// The poll is the only writer of `engineStatus`, and its verdict is the
		// newer word, `connected` from the restarted engine included.
		act(() => useEngineStore.getState().setEngineStatus("connected"));

		expect(screen.getByText("Running")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
	});
});
