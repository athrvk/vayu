/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The abort budget the renderer arms for `POST /execute` (issue #2836).
 *
 * One call runs the pre-request script, the late OAuth 2.0 token fetch, the
 * transfer and the test script in sequence. A budget of the setting alone made
 * the UI report "Vayu's engine didn't respond" for a run the engine went on to
 * complete and record. Asserted on the `timeout` option handed to the HTTP
 * client, which is the only place the number is observable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient } from "./http-client";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/queries/keys";
import type { ExecuteRequestRequest, ResolvedElement } from "@/types";

vi.mock("./http-client", async () => {
	const actual = await vi.importActual<typeof import("./http-client")>("./http-client");
	return {
		ApiError: actual.ApiError,
		httpClient: { post: vi.fn(), stream: vi.fn() },
	};
});

const post = vi.mocked(httpClient.post);

function setConfig(entries: Array<{ key: string; value: string }>) {
	queryClient.setQueryData(queryKeys.config.all, { entries });
}

const script = (kind: string, enabled = true): ResolvedElement => ({
	id: `el_${kind}_${enabled}`,
	kind,
	enabled,
	config: { script: "1;" },
});

async function armedTimeout(payload: Partial<ExecuteRequestRequest>): Promise<number> {
	post.mockResolvedValue({});
	await apiService.executeRequest({
		method: "GET",
		url: "https://slow.example.com",
		...payload,
	});
	return (post.mock.calls[0][2] as { timeout: number }).timeout;
}

beforeEach(() => {
	vi.clearAllMocks();
	queryClient.clear();
});

describe("apiService.executeRequest abort budget", () => {
	beforeEach(() => {
		setConfig([
			{ key: "defaultTimeout", value: "120000" },
			{ key: "scriptTimeout", value: "7000" },
		]);
	});

	it("arms the setting plus grace for a payload with neither OAuth nor a script", async () => {
		await expect(
			armedTimeout({
				auth: { mode: "bearer", token: "t" },
				elements: [{ id: "el_a", kind: "assert.status", enabled: true, config: {} }],
			})
		).resolves.toBe(130_000);
	});

	it("adds the token fetch and a pre-request script for OAuth 2.0 auth", async () => {
		// setting + setting + scriptTimeout + 10s grace
		await expect(
			armedTimeout({ auth: { mode: "oauth2", config: {} }, elements: [script("script.pre")] })
		).resolves.toBe(257_000);
	});

	it("adds a script budget per enabled pre and test script, not for a disabled one", async () => {
		await expect(
			armedTimeout({
				elements: [
					script("script.pre"),
					script("script.post"),
					script("script.pre", false),
				],
			})
		).resolves.toBe(144_000);
	});

	it("uses the 60s script ceiling when scriptTimeout is not in the config cache", async () => {
		setConfig([{ key: "defaultTimeout", value: "120000" }]);
		await expect(armedTimeout({ elements: [script("script.post")] })).resolves.toBe(190_000);
	});

	it("uses the 300s ceiling for the transfer when the config cache is cold", async () => {
		queryClient.clear();
		await expect(armedTimeout({})).resolves.toBe(310_000);
	});
});
