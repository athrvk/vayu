/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's opt-in to `pm.sendRequest` (issue #302).
 *
 * The engine denies script-issued requests unless the payload carries
 * `allowScriptRequests`, because Vayu's MCP target allowlist is checked in the
 * MCP server *before* the engine is called - a request sent from inside a
 * script never passes that gate. The renderer is the surface whose scripts the
 * user wrote, so it asks; the MCP server never does (asserted in
 * `electron/mcp/tools.test.ts`).
 *
 * Asserted on the captured body rather than on behaviour, for the same reason
 * `api.write-verbs.test.ts` is: nothing about a Send changes shape when this
 * regresses. The field would simply stop being sent and `pm.sendRequest` would
 * start throwing at runtime with every other test still green - so the payload
 * is the only layer that can catch it.
 *
 * Set inside the service rather than at each call site, so this also pins that
 * a caller does not have to know about it: the callers below pass no such
 * field.
 *
 * The streaming send is asserted beside the buffered one because the two are
 * the same button (issue #653). While they disagreed, a `pm.sendRequest` was
 * allowed with the stream toggle off and refused with it on - and nothing but
 * the payload can see that, which is what makes them one test file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiService } from "./api";
import { httpClient } from "./http-client";

vi.mock("./http-client", () => ({
	httpClient: {
		get: vi.fn(),
		post: vi.fn(),
		put: vi.fn(),
		delete: vi.fn(),
	},
}));

const post = vi.mocked(httpClient.post);

describe("the renderer opts its own executions into pm.sendRequest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		post.mockResolvedValue({} as never);
	});

	it("sends allowScriptRequests on execute, without the caller passing it", async () => {
		await apiService.executeRequest({ method: "GET", url: "https://example.com" });

		expect(post).toHaveBeenCalledTimes(1);
		const [, body] = post.mock.calls[0];
		expect(body).toMatchObject({
			url: "https://example.com",
			allowScriptRequests: true,
		});
	});

	it("sends allowScriptRequests on a streaming send too - one Send, one answer", async () => {
		// The engine reads the flag before it branches on `stream`, so this is
		// the only layer that decides whether a stream's scripts may send.
		post.mockResolvedValue({ runId: "run_1", eventsUrl: "/runs/run_1/events" } as never);

		await apiService.executeStreamRequest({ method: "GET", url: "https://example.com" });

		expect(post).toHaveBeenCalledTimes(1);
		const [, body] = post.mock.calls[0];
		expect(body).toMatchObject({ stream: true, allowScriptRequests: true });
	});

	it("sends allowScriptRequests on a load run - one Tests script, one behaviour", async () => {
		await apiService.startLoadTest({ method: "GET", url: "https://example.com" } as never);

		expect(post).toHaveBeenCalledTimes(1);
		const [, body] = post.mock.calls[0];
		expect(body).toMatchObject({ allowScriptRequests: true });
	});

	it("does not disturb the fields the caller did send", async () => {
		await apiService.executeRequest({
			method: "POST",
			url: "https://example.com",
			headers: { "X-A": "1" },
			httpVersion: "http2",
		});

		const [, body] = post.mock.calls[0];
		expect(body).toMatchObject({
			method: "POST",
			headers: { "X-A": "1" },
			httpVersion: "http2",
			allowScriptRequests: true,
		});
	});
});

/**
 * Every run the renderer starts says so (issue #1817). An unstamped run reads
 * as `other` in History, so the four calls are asserted one by one: a fifth
 * path that forgot the field would look exactly like a script's run.
 */
describe("the renderer stamps its own runs as origin app", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		post.mockResolvedValue({ runId: "run_1", eventsUrl: "/runs/run_1/events" } as never);
	});

	const app = { kind: "app" };

	it("on execute", async () => {
		await apiService.executeRequest({ method: "GET", url: "https://example.com" });
		expect(post.mock.calls[0][1]).toMatchObject({ origin: app });
	});

	it("on a streaming send", async () => {
		await apiService.executeStreamRequest({ method: "GET", url: "https://example.com" });
		expect(post.mock.calls[0][1]).toMatchObject({ origin: app });
	});

	it("on a load run", async () => {
		await apiService.startLoadTest({ method: "GET", url: "https://example.com" } as never);
		expect(post.mock.calls[0][1]).toMatchObject({ origin: app });
	});

	it("on a collection run", async () => {
		await apiService.startScenarioRun({ scenario: { collectionId: "col_1" } } as never);
		expect(post.mock.calls[0][1]).toMatchObject({ origin: app });
	});

	it("over whatever the payload claimed", async () => {
		// `ComposedRequest` carries an open record, so a spread payload could hold
		// an `origin` of its own.
		await apiService.executeRequest({
			method: "GET",
			url: "https://example.com",
			origin: { kind: "mcp", client: "spoof" },
		});
		expect(post.mock.calls[0][1]).toMatchObject({ origin: app });
		expect(post.mock.calls[0][1]).not.toHaveProperty("origin.client");
	});
});
