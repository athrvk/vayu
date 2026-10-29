/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProfileFields } from "./ProfileFields";
import { MonitoringSection } from "./MonitoringSection";
import { RecordingSection } from "./RecordingSection";
import { SCENARIO_PROFILE_DEFAULTS } from "./scenarioProfile";
import { emptyMonitorDraft } from "./monitor";
import { LOAD_TEST_LIMITS } from "@/constants/load-test";

describe("clearing a number field in the load-test dialog", () => {
	it("ProfileFields does not commit 0", () => {
		const onChange = vi.fn();
		render(
			<ProfileFields
				profile={{ ...SCENARIO_PROFILE_DEFAULTS, mode: "constant_rps" }}
				onChange={onChange}
				limits={LOAD_TEST_LIMITS}
				isStreamingRequest={false}
			/>
		);
		const field = screen.getByLabelText("Target rate") as HTMLInputElement;
		fireEvent.change(field, { target: { value: "" } });
		expect(onChange).not.toHaveBeenCalled();
		expect(field.value).toBe("");
	});

	it("MonitoringSection does not commit 0", () => {
		const onMonitorChange = vi.fn();
		render(
			<MonitoringSection
				monitor={emptyMonitorDraft()}
				onMonitorChange={onMonitorChange}
				maxSeries={20}
			/>
		);
		fireEvent.click(screen.getByText("Server monitoring"));
		fireEvent.change(screen.getByLabelText("Scrape interval"), { target: { value: "" } });
		expect(onMonitorChange).not.toHaveBeenCalled();
	});

	it("RecordingSection does not commit 0", () => {
		const onSlowThresholdChange = vi.fn();
		render(
			<RecordingSection
				mode="constant_rps"
				limits={LOAD_TEST_LIMITS}
				sampleRate={0}
				onSampleRateChange={vi.fn()}
				slowThreshold={500}
				onSlowThresholdChange={onSlowThresholdChange}
				maxInFlight=""
				onMaxInFlightChange={vi.fn()}
				saveTimingBreakdown={false}
				onSaveTimingBreakdownChange={vi.fn()}
			/>
		);
		fireEvent.click(screen.getByText("Recording & limits"));
		fireEvent.change(screen.getByLabelText("Slow request threshold"), {
			target: { value: "" },
		});
		expect(onSlowThresholdChange).not.toHaveBeenCalled();
	});
});
