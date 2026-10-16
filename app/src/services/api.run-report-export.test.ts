/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `POST /export/run-report` at the payload level: the request goes out as
 * stated, and the envelope comes back untouched for the download.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiService } from "./api";
import { httpClient } from "./http-client";

vi.mock("./http-client", () => ({
	httpClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const post = vi.mocked(httpClient.post);

describe("run report export API", () => {
	beforeEach(() => vi.clearAllMocks());

	it("posts the request to /export/run-report and answers the envelope", async () => {
		const envelope = {
			text: '{"schema":"vayu.run-report"}',
			fileName: "Orders 2026-10-05 0810.run.json",
			mimeType: "application/json",
			notes: { urlCredentialsOmitted: 1 },
		};
		post.mockResolvedValue(envelope as never);

		await expect(
			apiService.exportRunReport({ runId: "run_1", baseRunId: "run_0", series: "none" })
		).resolves.toEqual(envelope);
		expect(post).toHaveBeenCalledWith("/export/run-report", {
			runId: "run_1",
			baseRunId: "run_0",
			series: "none",
		});
	});
});
