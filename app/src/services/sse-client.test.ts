/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect } from "vitest";
import { mapSseMetrics } from "./sse-client";

describe("mapSseMetrics", () => {
	it("maps bytes and the full status-code map", () => {
		const m = mapSseMetrics({
			timestamp: 1,
			elapsedSeconds: 1,
			totalRequests: 2,
			bytesSent: 50,
			bytesReceived: 500,
			statusCodes: { "200": 1, "404": 1 },
		});
		expect(m.bytes_sent).toBe(50);
		expect(m.bytes_received).toBe(500);
		expect(m.status_codes).toEqual({ "200": 1, "404": 1 });
	});

	it("defaults bytes to 0 and leaves status_codes undefined when absent", () => {
		const m = mapSseMetrics({ timestamp: 1, totalRequests: 0 });
		expect(m.bytes_sent).toBe(0);
		expect(m.bytes_received).toBe(0);
		expect(m.status_codes).toBeUndefined();
	});
});
