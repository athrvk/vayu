/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Nothing rendered this dialog before, which is how a 450-line component grew a
 * field the engine ignores without anyone noticing. These pin the three things
 * a re-cut could plausibly break: which fields each profile shows, what the
 * payload contains, and that the profile picker is one keyboard control.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import LoadTestConfigDialog from "./index";
import type { LoadTestConfig } from "@/types";

vi.mock("../OAuth2LoadTestGuard", () => ({
	default: () => null,
}));

function open(props: Partial<React.ComponentProps<typeof LoadTestConfigDialog>> = {}) {
	const onStart = vi.fn();
	render(
		<LoadTestConfigDialog
			onClose={vi.fn()}
			onStart={onStart}
			isStarting={false}
			hasPreRequestScript={false}
			{...props}
		/>
	);
	return { onStart };
}

const pickProfile = (name: string) =>
	fireEvent.click(screen.getByRole("radio", { name: new RegExp(name, "i") }));

const started = (onStart: ReturnType<typeof vi.fn>): LoadTestConfig => {
	fireEvent.click(screen.getByRole("button", { name: "Start" }));
	expect(onStart).toHaveBeenCalledTimes(1);
	return onStart.mock.calls[0][0] as LoadTestConfig;
};

beforeEach(() => {
	cleanup();
	localStorage.clear();
});

describe("load profile → fields", () => {
	it("shows rate and duration for Constant RPS, and no connection count", () => {
		open();
		expect(screen.getByLabelText(/target rate/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/^duration/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/^connections/i)).not.toBeInTheDocument();
	});

	it("shows connections and duration for Constant Concurrency", () => {
		open();
		pickProfile("Constant Concurrency");
		expect(screen.getByLabelText(/^connections/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/^duration/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/target rate/i)).not.toBeInTheDocument();
	});

	it("hides Duration entirely for Fixed Iterations", () => {
		// The defect this re-cut exists to fix. The engine stops on
		// `requests_sent < iterations` and never reads duration, so offering the
		// field invites tuning something inert — and it used to persist.
		open();
		pickProfile("Fixed Iterations");
		expect(screen.getByLabelText(/^requests/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/^connections/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/duration/i)).not.toBeInTheDocument();
	});

	it("shows target, total and ramp for Ramp-Up", () => {
		open();
		pickProfile("Ramp-Up");
		expect(screen.getByLabelText(/target connections/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/total duration/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/ramp duration/i)).toBeInTheDocument();
	});
});

describe("payload", () => {
	it("omits duration_seconds for Fixed Iterations", () => {
		const { onStart } = open();
		pickProfile("Fixed Iterations");
		const config = started(onStart);
		expect(config.mode).toBe("iterations");
		expect(config.iterations).toBeGreaterThan(0);
		expect(config).not.toHaveProperty("duration_seconds");
	});

	// `it.each`, not a loop with a manual teardown: the dialog renders through a
	// Radix portal, so removing its node by hand throws and leaves the next
	// iteration asserting against a half-torn-down DOM.
	it.each(["Constant RPS", "Constant Concurrency", "Ramp-Up"])(
		"sends duration_seconds for %s",
		(profile) => {
			const { onStart } = open();
			pickProfile(profile);
			expect(started(onStart).duration_seconds).toBeGreaterThan(0);
		}
	);

	it("keeps the recording options even though they are folded away", () => {
		const { onStart } = open();
		const config = started(onStart);
		expect(config.data_sample_rate).toBeTypeOf("number");
		expect(config.slow_threshold_ms).toBeTypeOf("number");
		expect(config.save_timing_breakdown).toBeTypeOf("boolean");
	});
});

describe("notices", () => {
	it("sorts blocking above advisory, since with a stack only order says which blocks", () => {
		open({ hasPreRequestScript: true });
		pickProfile("Ramp-Up");
		// Force the ramp longer than the total.
		fireEvent.change(screen.getByLabelText(/total duration/i), { target: { value: "1" } });

		const alerts = screen.getAllByText(
			/Ramp is longer than the run|Pre-request script will not run/
		);
		expect(alerts).toHaveLength(2);
		expect(alerts[0]).toHaveTextContent("Ramp is longer than the run");
	});

	it("disables Start while a blocking notice is live", () => {
		open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/total duration/i), { target: { value: "1" } });
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	});
});

describe("keyboard", () => {
	it("is a single Tab stop with arrow selection, not four stops", () => {
		open();
		const group = screen.getByRole("radiogroup", { name: /load profile/i });
		const radios = within(group).getAllByRole("radio");
		expect(radios).toHaveLength(4);
		expect(radios.filter((r) => r.getAttribute("tabindex") === "0")).toHaveLength(1);

		radios[0].focus();
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(radios[1]).toHaveAttribute("aria-checked", "true");
		expect(document.activeElement).toBe(radios[1]);
	});

	it("wraps at the ends", () => {
		open();
		const group = screen.getByRole("radiogroup", { name: /load profile/i });
		const radios = within(group).getAllByRole("radio");
		radios[0].focus();
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(radios[3]).toHaveAttribute("aria-checked", "true");
	});

	it("labels every field, so none is named by its placeholder alone", () => {
		open();
		fireEvent.click(screen.getByRole("button", { name: /recording/i }));
		for (const label of [
			/target rate/i,
			/^duration/i,
			/slow request threshold/i,
			/^comment/i,
		]) {
			expect(screen.getByLabelText(label)).toBeInTheDocument();
		}
	});
});

describe("ramp start concurrency", () => {
	it("offers a start field, so a ramp no longer always begins at 1", () => {
		// The engine reads `startConcurrency` and defaults it to 1. It was
		// plumbed through the payload, the store and the dashboard's derived
		// report — and nothing ever set it, so every ramp started from 1
		// whatever the user wanted.
		open();
		pickProfile("Ramp-Up");
		expect(screen.getByLabelText(/start from/i)).toBeInTheDocument();
	});

	it("sends it, and only for Ramp-Up", () => {
		const { onStart } = open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/start from/i), { target: { value: "4" } });
		expect(started(onStart).start_concurrency).toBe(4);
	});

	it("omits it for every other profile", () => {
		const { onStart } = open();
		expect(started(onStart)).not.toHaveProperty("start_concurrency");
	});

	it("blocks a start above the target, which would ramp downwards", () => {
		open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/start from/i), { target: { value: "999" } });

		expect(screen.getByText(/Ramp would run downwards/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	});

	it("says where the ramp begins in the summary", () => {
		open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/start from/i), { target: { value: "3" } });
		expect(screen.getByText(/Climbs from 3 to 10 connections/i)).toBeInTheDocument();
	});
});
