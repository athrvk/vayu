/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./sse-client", () => ({
	sseClient: { connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock("@/stores", () => ({
	useDashboardStore: {
		getState: () => ({ setStreaming: vi.fn(), setError: vi.fn(), reset: vi.fn() }),
	},
}));

import { loadTestService } from "./load-test-service";
import { sseClient } from "./sse-client";

describe("LoadTestService.startMonitoring", () => {
	beforeEach(() => vi.clearAllMocks());

	it("connects to SSE synchronously (no setTimeout delay)", () => {
		loadTestService.startMonitoring("run_1");
		expect(sseClient.connect).toHaveBeenCalledTimes(1);
		expect(sseClient.connect).toHaveBeenCalledWith(
			"run_1",
			expect.any(Function),
			expect.any(Function),
			expect.any(Function)
		);
		loadTestService.stopMonitoring();
	});
});
