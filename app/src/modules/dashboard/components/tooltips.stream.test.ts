/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The stream card's tooltips (issue #3234). The events tooltip used to say time
 * to first event "is the First byte row"; it is a figure of its own now, and a
 * sentence equating the two sends a reader to the wrong row.
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

	it("says the live first-event tile is not the First byte row, and that open streams are not counted (issue #3236)", () => {
		const tip = String(TOOLTIPS.liveStreamFirstEvent);
		expect(tip).toContain("not the First byte row");
		expect(tip).toContain("response headers");
		expect(tip).toMatch(/still open is not counted/);
	});

	it("explains that the live card counts events as they arrive (issue #3236)", () => {
		expect(String(TOOLTIPS.liveStream)).toMatch(/as they arrive/);
		expect(String(TOOLTIPS.liveStream)).not.toMatch(/first byte/i);
	});
});
