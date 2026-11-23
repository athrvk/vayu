/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The stream card's tooltips (issue #3234). The events tooltip used to say time
 * to first event "is the First byte row"; it is a figure of its own now, and a
 * sentence equating the two sends a reader to the wrong row. The pace rows'
 * tooltips (#3776) say what each figure is and what it is not.
 */

import { describe, it, expect } from "vitest";
import { TOOLTIPS } from "./tooltips";

describe("stream tooltips", () => {
	it("no longer tells the reader the first event is the First byte row", () => {
		expect(String(TOOLTIPS.streamEvents)).not.toMatch(/first byte/i);
	});

	it("says the first-event figure is not the First byte row, and why", () => {
		const tip = String(TOOLTIPS.streamFirstEvent);
		expect(tip).toContain("not the First byte row");
		expect(tip).toContain("response headers");
	});

	it("says the max-gap figure is per stream, the largest pause, and understated by a buffering proxy (issue #3776)", () => {
		const tip = String(TOOLTIPS.streamMaxEventGap);
		expect(tip).toMatch(/within one stream/);
		expect(tip).toMatch(/largest pause between two consecutive events/);
		expect(tip).toMatch(/buffers the stream/);
	});

	it("says the event-rate figure is per stream, unlike the whole-run events/sec, and that low values are the concern (issue #3776)", () => {
		const tip = String(TOOLTIPS.streamEventRate);
		expect(tip).toMatch(/each stream's own pace/);
		expect(tip).toMatch(/whole-run events\/sec/);
		expect(tip).toMatch(/low p50 means the typical stream was slow/);
	});

	it("says the live first-event tile is not the First byte row, and that open streams are not counted (issue #3236)", () => {
		const tip = String(TOOLTIPS.liveStreamFirstEvent);
		expect(tip).toContain("not the First byte row");
		expect(tip).toContain("response headers");
		expect(tip).toMatch(/still open is not counted/);
	});

	it("says a preamble event reads near zero on the first-event figure, so it is not time to first token (issue #3774)", () => {
		for (const key of ["streamFirstEvent", "liveStreamFirstEvent"] as const) {
			const tip = String(TOOLTIPS[key]);
			expect(tip).toMatch(/preamble event/);
			expect(tip).toMatch(/message_start/);
			expect(tip).toMatch(/role-only chunk/);
			expect(tip).toMatch(/reads near zero here/);
			expect(tip).toMatch(/not time to first token/);
		}
	});

	it("explains that the live card counts events as they arrive (issue #3236)", () => {
		expect(String(TOOLTIPS.liveStream)).toMatch(/as they arrive/);
		expect(String(TOOLTIPS.liveStream)).not.toMatch(/first byte/i);
	});
});
