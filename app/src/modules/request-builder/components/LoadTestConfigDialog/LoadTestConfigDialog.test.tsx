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
 * Nothing rendered this dialog before, which is how a 450-line component grew a
 * field the engine ignores without anyone noticing. These pin the three things
 * a re-cut could plausibly break: which fields each profile shows, what the
 * payload contains, and that the profile picker is one keyboard control.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import LoadTestConfigDialog from "./index";
import type { LoadTestConfig } from "@/types";
import { STORAGE_KEYS } from "@/constants/storage-keys";
import { useClientSettingsStore } from "@/stores";
import { DEFAULT_LOAD_TEST_CEILINGS, LOAD_TEST_CEILING_BOUNDS } from "@/constants/load-test";
import { LOAD_TEST_MODES } from "@/constants/load-test-modes";

vi.mock("../OAuth2LoadTestGuard", () => ({
	default: () => null,
}));

/**
 * The dialog seeds its scrape cadence and metric cap from the engine's
 * `monitorIntervalMs` / `monitorMaxSeries` settings, so it reads the config
 * query. Mocked rather than wrapped in a provider, the convention the hook
 * tests use - and `configEntries` is mutable so a test can move a setting and
 * assert the dialog followed it.
 */
let configEntries: { key: string; value: string }[] = [];
vi.mock("@/queries", () => ({
	useConfigQuery: () => ({ data: { entries: configEntries } }),
}));

function open(props: Partial<React.ComponentProps<typeof LoadTestConfigDialog>> = {}) {
	const onStart = vi.fn();
	render(
		<LoadTestConfigDialog
			onClose={vi.fn()}
			onStart={onStart}
			isStarting={false}
			hasPreRequestScript={false}
			hasDynamicVariables={false}
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
	configEntries = [];
	// The ceilings store is module-level and persists across tests in this
	// file; clearing localStorage does not roll it back.
	useClientSettingsStore.getState().setLoadTestCeilings(DEFAULT_LOAD_TEST_CEILINGS);
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
		// field invites tuning something inert - and it used to persist.
		open();
		pickProfile("Fixed Iterations");
		expect(screen.getByLabelText(/^requests/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/^connections/i)).toBeInTheDocument();
		expect(screen.queryByLabelText(/duration/i)).not.toBeInTheDocument();
	});

	it("shows the budget, the step and both bounds for Capacity Discovery", () => {
		open();
		pickProfile("Capacity Discovery");
		expect(screen.getByLabelText(/latency budget/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/hold each level for/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/start from/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/stop climbing at/i)).toBeInTheDocument();
		expect(screen.getByLabelText(/give up after/i)).toBeInTheDocument();
		// The ramp's own field belongs to the ramp; a search has no ramp curve.
		expect(screen.queryByLabelText(/ramp duration/i)).not.toBeInTheDocument();
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
	it.each(["Constant RPS", "Constant Concurrency", "Ramp-Up", "Capacity Discovery"])(
		"sends duration_seconds for %s",
		(profile) => {
			const { onStart } = open();
			pickProfile(profile);
			expect(started(onStart).duration_seconds).toBeGreaterThan(0);
		}
	);

	it("sends the search bounds and budget for Capacity Discovery", () => {
		const { onStart } = open();
		pickProfile("Capacity Discovery");
		// The default start (1) is below the default ceiling (10), so the
		// picked profile starts valid; anything else and Start is disabled and
		// `started` would fail on the call count rather than on the payload.
		const config = started(onStart);
		expect(config.mode).toBe("capacity");
		// `concurrency` is the ceiling and `start_concurrency` the first level -
		// the ramp's two fields reused, so one Settings cap bounds both modes.
		expect(config.concurrency).toBeGreaterThan(0);
		expect(config.start_concurrency).toBeGreaterThan(0);
		expect(config.slo_ms).toBeGreaterThan(0);
		expect(config.step_duration_seconds).toBeGreaterThan(0);
		// `duration` is the search's deadline in this mode, not a run length.
		expect(config.duration_seconds).toBeGreaterThan(0);
	});

	it("sends no capacity fields for any other profile", () => {
		// The mirror of the test above, and the one that would catch the
		// fields being set unconditionally: a ramp carrying an sloMs would make
		// its stored config claim a search it never ran.
		const { onStart } = open();
		pickProfile("Ramp-Up");
		const config = started(onStart);
		expect(config).not.toHaveProperty("slo_ms");
		expect(config).not.toHaveProperty("step_duration_seconds");
	});

	it("keeps the recording options even though they are folded away", () => {
		const { onStart } = open();
		const config = started(onStart);
		expect(config.success_sample_period).toBeTypeOf("number");
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

	/*
	 * Interpolation happens once, app-side, before the run payload is sent, so a
	 * `{{$guid}}` is the *same* id on every iteration. That is the least visible
	 * way to get a load test wrong - the run succeeds and the data is quietly
	 * degenerate - so the dialog has to say it out loud.
	 */
	it("warns that a run generates a dynamic variable only once", () => {
		open({ hasDynamicVariables: true });
		expect(screen.getByText(/Dynamic variables are generated once/)).toBeInTheDocument();
	});

	it("says nothing when the request has no dynamic variable", () => {
		open();
		expect(screen.queryByText(/Dynamic variables are generated once/)).toBeNull();
	});

	it("keeps the warning advisory - it does not gate Start", () => {
		open({ hasDynamicVariables: true });
		expect(screen.getByRole("button", { name: "Start" })).not.toBeDisabled();
	});

	it("disables Start while a blocking notice is live", () => {
		open();
		pickProfile("Ramp-Up");
		fireEvent.change(screen.getByLabelText(/total duration/i), { target: { value: "1" } });
		expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
	});
});

describe("recording & limits is one surface", () => {
	/**
	 * The card used to be worn by the header alone - `bg-card` sat on the
	 * trigger - so opening the disclosure dropped the sample rate, the slow
	 * threshold, the timing switch and the comment onto the bare dialog
	 * background, reading as fields unrelated to the row that revealed them.
	 *
	 * This is keyed on the surface class, not on ancestry, and that is the whole
	 * point: `CollapsibleContent` has always been a child of the `Collapsible`
	 * root, so `trigger.parentElement` contained the fields even while the
	 * layout was broken. Only "the nearest painted surface around the header
	 * also holds the fields" tells the two apart.
	 */
	it("renders the disclosure fields inside the same card as its header", () => {
		open();
		const trigger = screen.getByRole("button", { name: /recording/i });
		fireEvent.click(trigger);

		// `.surface-card`, which declares the card background *and* the `--rule`
		// its inner divider resolves against. It was `.bg-card` before that
		// contract existed; the assertion is unchanged - header and fields share
		// one surface.
		const surface = trigger.closest(".surface-card");
		expect(surface).not.toBeNull();

		for (const label of [
			/success sample rate/i,
			/slow request threshold/i,
			/save timing breakdown/i,
			/^comment/i,
		]) {
			expect(surface).toContainElement(screen.getByLabelText(label));
		}

		// `closest` is ancestor-or-self, and pre-fix it resolved to the trigger,
		// whose siblings the fields were. Stated separately so the loop above is
		// what reports the defect.
		expect(surface).not.toBe(trigger);
	});

	it("keeps the header above its fields in document, and so in tab, order", () => {
		open();
		const trigger = screen.getByRole("button", { name: /recording/i });
		fireEvent.click(trigger);

		const first = screen.getByLabelText(/success sample rate/i);
		const last = screen.getByLabelText(/^comment/i);
		expect(
			trigger.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("leaves the toggle a real button, so Tab reaches it and Enter/Space fire it", () => {
		open();
		const trigger = screen.getByRole("button", { name: /recording/i });
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger).not.toHaveAttribute("tabindex", "-1");
		expect(trigger).toHaveAttribute("aria-expanded", "false");

		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		fireEvent.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
	});
});

describe("keyboard", () => {
	it("is a single Tab stop with arrow selection, not four stops", () => {
		open();
		const group = screen.getByRole("radiogroup", { name: /load profile/i });
		const radios = within(group).getAllByRole("radio");
		// One card per entry in LOAD_TEST_MODES - the picker renders from that
		// list, so hardcoding a count here would fail on every mode added.
		expect(radios).toHaveLength(LOAD_TEST_MODES.length);
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
		expect(radios[radios.length - 1]).toHaveAttribute("aria-checked", "true");
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
		// report - and nothing ever set it, so every ramp started from 1
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

/**
 * The slider is a percentage and the engine's field is a sampling period (keep
 * 1 in N, `counter % N`). Nothing converted between them, so the two ends of
 * the control meant the opposite of what they said: "100% - everything" sent a
 * period of 100 and kept 1%, while the left stop kept every single response.
 * Only the default of 10 was right, 1-in-10 being 10%.
 *
 * Asserted through the payload rather than on `successSamplePeriod` alone,
 * because the unit conversion existing is not the point - it being applied on
 * the way out of this dialog is.
 */
describe("success sample rate reaches the engine in the engine's unit", () => {
	const rateSlider = () => screen.getByLabelText(/success sample rate/i) as HTMLInputElement;
	const openRecording = () => fireEvent.click(screen.getByRole("button", { name: /recording/i }));

	it("sends a period of 1 - every response - at the 100% stop", () => {
		const { onStart } = open();
		openRecording();
		fireEvent.change(rateSlider(), { target: { value: "100" } });
		expect(started(onStart).success_sample_period).toBe(1);
	});

	it("sends a period of 100 - one in a hundred - at the 1% stop", () => {
		const { onStart } = open();
		openRecording();
		fireEvent.change(rateSlider(), { target: { value: "1" } });
		expect(started(onStart).success_sample_period).toBe(100);
	});

	it("leaves the default alone, which is the one value that was already right", () => {
		const { onStart } = open();
		expect(started(onStart).success_sample_period).toBe(10);
	});

	it("never offers, or sends, the divide-by-zero value", () => {
		// The floor used to be 0, and `saved.sampleRate ?? DEFAULT` keeps a
		// stored 0 because 0 is present. A 0 on the wire is `% 0` engine-side.
		localStorage.setItem(STORAGE_KEYS.LAST_LOAD_TEST_CONFIG, JSON.stringify({ sampleRate: 0 }));
		const { onStart } = open();
		openRecording();
		expect(Number(rateSlider().min)).toBeGreaterThanOrEqual(1);
		expect(started(onStart).success_sample_period).toBeGreaterThanOrEqual(1);
	});
});

/**
 * The dialog's ceilings are a user setting, not a constant. Nothing else in the
 * app reads `loadTestCeilings`, so if this dialog stopped resolving them the
 * setting would be written and never read - which is the defect class this
 * codebase repeats most.
 */
describe("ceilings from Settings", () => {
	const connections = () => screen.getByLabelText(/^connections/i) as HTMLInputElement;

	it("offers the raised ceiling on the field it governs", () => {
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 5000 });
		open();
		pickProfile("Constant Concurrency");
		expect(Number(connections().max)).toBe(5000);
	});

	it("applies a connection ceiling to the ramp's start too, not just its target", () => {
		// Same physical quantity. A ramp that may only start below 1000 cannot
		// climb to a target of 5000 from anywhere sensible.
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 5000 });
		open();
		pickProfile("Ramp-Up");
		expect(Number((screen.getByLabelText(/start from/i) as HTMLInputElement).max)).toBe(5000);
	});

	it("pulls a restored value back under a ceiling lowered since it was saved", () => {
		localStorage.setItem(
			STORAGE_KEYS.LAST_LOAD_TEST_CONFIG,
			JSON.stringify({ mode: "constant_concurrency", concurrency: 800 })
		);
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 100 });
		const { onStart } = open();
		expect(connections().value).toBe("100");
		expect(started(onStart).concurrency).toBe(100);
	});

	it("cannot be set past what the engine accepts", () => {
		// The bound is the engine's crash guard, so this clamp is what makes
		// "no setting on that screen can compose a rejected run" true.
		useClientSettingsStore.getState().setLoadTestCeilings({ concurrency: 999_999 });
		open();
		pickProfile("Constant Concurrency");
		expect(Number(connections().max)).toBe(LOAD_TEST_CEILING_BOUNDS.concurrency.MAX);
	});
});

/**
 * Budgets are the dialog's only control whose *absence* is meaningful: a run
 * with none is measured and not judged, exactly as every run was before them.
 * These pin both directions, plus the one place the feature reuses a setting
 * the user already has rather than adding a second notion of "too slow".
 */
describe("pass/fail budgets", () => {
	const openBudgets = () => fireEvent.click(screen.getByRole("button", { name: /budgets/i }));
	const p99 = () => screen.getByLabelText(/p99 latency/i) as HTMLInputElement;

	it("prefills the p99 budget from the capacity SLO rather than inventing a default", () => {
		// `sloThresholdMs` existed as a chart annotation and never reached the
		// engine. If this stopped reading it the setting would be written and
		// never read - the defect class this codebase repeats most.
		useClientSettingsStore.getState().setSloThresholdMs(345);
		const { onStart } = open();
		openBudgets();
		expect(p99().value).toBe("345");
		expect(started(onStart).thresholds).toEqual({ latencyP99Ms: 345 });
	});

	it("sends no thresholds at all once every budget is cleared", () => {
		const { onStart } = open();
		openBudgets();
		fireEvent.change(p99(), { target: { value: "" } });
		// Not `{}`: POST /runs rejects an empty object rather than starting a
		// run nothing will judge, so the key has to be absent.
		expect(started(onStart).thresholds).toBeUndefined();
	});

	it("sends every declared budget under the engine's own key", () => {
		const { onStart } = open();
		openBudgets();
		fireEvent.change(p99(), { target: { value: "50" } });
		fireEvent.change(screen.getByLabelText(/error rate/i), { target: { value: "0.1" } });
		fireEvent.change(screen.getByLabelText(/throughput/i), { target: { value: "1000" } });
		expect(started(onStart).thresholds).toEqual({
			latencyP99Ms: 50,
			maxErrorRatePct: 0.1,
			minThroughputRps: 1000,
		});
	});

	it("blocks Start on an out-of-range budget instead of dropping the field", () => {
		const { onStart } = open();
		openBudgets();
		fireEvent.change(screen.getByLabelText(/error rate/i), { target: { value: "150" } });
		fireEvent.click(screen.getByRole("button", { name: "Start" }));
		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText(/budget is out of range/i)).toBeInTheDocument();
	});

	it("keeps a cleared budget cleared across dialog opens", () => {
		// The prefill seeds a first run only. Re-seeding from the setting every
		// time would undo the user's decision to run without a latency budget,
		// silently, on the next run.
		useClientSettingsStore.getState().setSloThresholdMs(200);
		const first = open();
		openBudgets();
		fireEvent.change(p99(), { target: { value: "" } });
		expect(started(first.onStart).thresholds).toBeUndefined();

		cleanup();
		const second = open();
		openBudgets();
		expect(p99().value).toBe("");
		expect(started(second.onStart).thresholds).toBeUndefined();
	});
});

/**
 * Server monitoring: the run's optional second data source. The rules live in
 * `monitor.ts` and are tested there; these pin the wiring - that what the user
 * types reaches the payload, that an incomplete block stops the run here rather
 * than at the engine's 400, and that a run without one is unchanged.
 */
describe("server monitoring", () => {
	const openMonitoring = () =>
		fireEvent.click(screen.getByRole("button", { name: /server monitoring/i }));
	const url = () => screen.getByLabelText(/metrics endpoint/i) as HTMLInputElement;
	const metrics = () => screen.getByLabelText(/metrics to chart/i) as HTMLTextAreaElement;

	it("sends nothing when no endpoint is given", () => {
		const { onStart } = open();
		expect(started(onStart).monitor).toBeUndefined();
	});

	it("sends the block the user typed", () => {
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), {
			target: { value: "node_cpu_seconds_total\nprocess_resident_memory_bytes" },
		});

		expect(started(onStart).monitor).toEqual({
			url: "http://localhost:9100/metrics",
			intervalMs: 1000,
			format: "prometheus",
			series: ["node_cpu_seconds_total", "process_resident_memory_bytes"],
		});
	});

	it("blocks Start on an endpoint with no metrics instead of dropping the block", () => {
		// The engine rejects `series: []`, so a silently dropped block would be a
		// run the user believes is monitored and a chart that never appears.
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.click(screen.getByRole("button", { name: "Start" }));

		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText(/server monitoring is incomplete/i)).toBeInTheDocument();
	});

	it("seeds the interval from the engine setting rather than its own number", () => {
		// `monitorIntervalMs` would otherwise be a setting with no reader on this
		// path: the dialog always sends an explicit interval, so a hardcoded
		// default here means the engine's copy never applies to a run started
		// from the app.
		configEntries = [{ key: "monitorIntervalMs", value: "5000" }];
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), { target: { value: "up" } });

		expect(started(onStart).monitor?.intervalMs).toBe(5000);
	});

	it("accepts as many metrics as the engine setting allows", () => {
		// The cap is `monitorMaxSeries`; a dialog holding its own 8 would refuse a
		// list the engine was just configured to accept.
		configEntries = [{ key: "monitorMaxSeries", value: "12" }];
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), {
			target: { value: Array.from({ length: 10 }, (_, i) => `m${i}`).join("\n") },
		});

		expect(started(onStart).monitor?.series).toHaveLength(10);
	});

	it("blocks Start past the configured cap", () => {
		configEntries = [{ key: "monitorMaxSeries", value: "2" }];
		const { onStart } = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), { target: { value: "a\nb\nc" } });
		fireEvent.click(screen.getByRole("button", { name: "Start" }));

		expect(onStart).not.toHaveBeenCalled();
		expect(screen.getByText(/at most 2 metrics/i)).toBeInTheDocument();
	});

	it("remembers the endpoint across dialog opens - it is a property of the target", () => {
		const first = open();
		openMonitoring();
		fireEvent.change(url(), { target: { value: "http://localhost:9100/metrics" } });
		fireEvent.change(metrics(), { target: { value: "up" } });
		expect(started(first.onStart).monitor?.series).toEqual(["up"]);

		cleanup();
		open();
		openMonitoring();
		expect(url().value).toBe("http://localhost:9100/metrics");
		expect(metrics().value).toBe("up");
	});
});
