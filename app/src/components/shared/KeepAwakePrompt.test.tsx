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
 * When the app interrupts the user, and what the answer does (issue #1357).
 *
 * The failure modes here are both user-visible and opposite: a prompt that
 * appears for every short run trains people to dismiss it, and one that never
 * appears leaves the feature unreachable for anyone who does not go looking
 * through Settings. Each case below pins one edge of that.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import KeepAwakePrompt from "./KeepAwakePrompt";
import { useClientSettingsStore, useDashboardStore } from "@/stores";
import { LONG_RUN_SECONDS } from "@/modules/dashboard/utils/keepAwake";

const { mockHold } = vi.hoisted(() => ({ mockHold: vi.fn() }));
vi.mock("@/services/wake-lock", () => ({
	wakeLock: { hold: mockHold, release: vi.fn() },
	WAKE_LOCK_KEYS: { loadRun: "load-run", collectionRun: "collection-run" },
}));

/** Put the dashboard store in the state a streaming run of `seconds` leaves it. */
function streamRun(runId: string, seconds: number | null) {
	// Inside `act`: the store write is what the dialog's open state is derived
	// from, and React must be allowed to flush it before the case reads.
	act(() => {
		useDashboardStore.setState({
			currentRunId: runId,
			isStreaming: true,
			loadTestConfig: seconds === null ? { mode: "iterations" } : { duration: `${seconds}s` },
		});
	});
}

beforeEach(() => {
	cleanup();
	mockHold.mockClear();
	useClientSettingsStore.setState({ keepAwakeDuringRuns: false });
	useDashboardStore.setState({ currentRunId: null, isStreaming: false, loadTestConfig: null });
});

const dialog = () => screen.queryByRole("dialog");

describe("KeepAwakePrompt", () => {
	it("asks about a run long enough to be walked away from", () => {
		render(<KeepAwakePrompt />);
		streamRun("run_1", LONG_RUN_SECONDS);

		expect(dialog()).not.toBeNull();
		expect(screen.getByText(/5 minutes/)).toBeTruthy();
	});

	it("stays out of the way for a short run", () => {
		render(<KeepAwakePrompt />);
		streamRun("run_2", LONG_RUN_SECONDS - 1);

		expect(dialog()).toBeNull();
	});

	it("stays out of the way for a run that declares no length", () => {
		render(<KeepAwakePrompt />);
		streamRun("run_3", null);

		expect(dialog()).toBeNull();
	});

	it("does not ask when the user has already said yes to every run", () => {
		// The service took the lock at start; asking again would be asking a
		// question that is already answered.
		useClientSettingsStore.setState({ keepAwakeDuringRuns: true });
		render(<KeepAwakePrompt />);
		streamRun("run_4", LONG_RUN_SECONDS * 4);

		expect(dialog()).toBeNull();
	});

	it("takes the lock for this run when the user says yes", () => {
		render(<KeepAwakePrompt />);
		streamRun("run_5", LONG_RUN_SECONDS * 6);

		fireEvent.click(screen.getByRole("button", { name: "Keep awake" }));

		// The load-run key, which is the one the service releases on every
		// terminal path - so this grant ends with the run rather than outliving it.
		expect(mockHold).toHaveBeenCalledWith("load-run", expect.any(String));
		expect(dialog()).toBeNull();
	});

	it("takes no lock when the user would rather the machine slept", () => {
		render(<KeepAwakePrompt />);
		streamRun("run_6", LONG_RUN_SECONDS * 6);

		fireEvent.click(screen.getByRole("button", { name: "Allow sleep" }));

		expect(mockHold).not.toHaveBeenCalled();
		expect(dialog()).toBeNull();
	});

	it("does not ask twice about the same run", () => {
		render(<KeepAwakePrompt />);
		streamRun("run_7", LONG_RUN_SECONDS * 6);
		fireEvent.click(screen.getByRole("button", { name: "Allow sleep" }));

		// A run's stream can stop and start again under the same id - a dropped
		// SSE connection reconnecting, or the dashboard re-attaching when the
		// user navigates back to it. Without the record of what has been asked,
		// every one of those re-opens a question the user already answered.
		act(() => useDashboardStore.setState({ isStreaming: false }));
		act(() => useDashboardStore.setState({ isStreaming: true }));

		expect(dialog()).toBeNull();
	});

	it("asks again for the next long run", () => {
		render(<KeepAwakePrompt />);
		streamRun("run_8", LONG_RUN_SECONDS * 6);
		expect(dialog()).not.toBeNull();

		streamRun("run_9", LONG_RUN_SECONDS * 6);

		// A decision about one run is not a decision about the next: the answer
		// is per run until the user makes it standing in Settings.
		expect(dialog()).not.toBeNull();
	});
});
