/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A taken MCP port used to be an app-log line while Settings kept handing out
 * the connect URL (#2368). These pin the three answers that close that: the
 * failure is classified from the real bind error, it rides on `mcp:status`
 * only while it is true, and a client is never registered against a listener
 * that is not up.
 */

import http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { MCP_ENDPOINT_URL } from "../constants.js";
import { McpListener } from "./listener.js";
import {
	buildMcpStatus,
	classifyStartError,
	connectWhileRunning,
	type McpListenerState,
	type McpStartError,
} from "./status.js";

const ENDPOINT = { host: "127.0.0.1", port: 9877 };

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`listen ${code} 127.0.0.1:9877`), { code });
}

const listening = (url = "http://127.0.0.1:9877/mcp"): McpListenerState => ({
	url,
	isRunning: () => true,
});
const closed: McpListenerState = { url: "http://127.0.0.1:9877/mcp", isRunning: () => false };

describe("classifyStartError", () => {
	it("names the port when another program holds it", () => {
		expect(classifyStartError(errno("EADDRINUSE"), ENDPOINT)).toEqual({
			code: "EADDRINUSE",
			message: "Another program holds 127.0.0.1:9877.",
		});
	});

	it("gives a refused bind its own code", () => {
		const result = classifyStartError(errno("EACCES"), ENDPOINT);
		expect(result.code).toBe("EACCES");
		expect(result.message).toContain("127.0.0.1:9877");
	});

	it.each([
		["a store or SDK failure", new Error("config unreadable")],
		["an errno of another kind", errno("EMFILE")],
		["a thrown string", "boom"],
		["a thrown null", null],
	])("does not blame the port for %s", (_label, err) => {
		const result = classifyStartError(err, ENDPOINT);
		expect(result.code).toBe("other");
		expect(result.message).not.toMatch(/another program/i);
	});

	it("carries the underlying text for an unclassified failure", () => {
		expect(classifyStartError(new Error("config unreadable"), ENDPOINT).message).toContain(
			"config unreadable"
		);
	});

	it("classifies the error a real bind on an occupied port rejects with", async () => {
		const squatter = http.createServer();
		await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
		const { port } = squatter.address() as { port: number };
		const listener = new McpListener({
			host: "127.0.0.1",
			port,
			loadHandler: async () => async () => {},
		});
		try {
			const failure = await listener.start().then(
				() => null,
				(err: unknown) => err
			);
			expect(failure).not.toBeNull();
			expect(classifyStartError(failure, { host: "127.0.0.1", port }).code).toBe(
				"EADDRINUSE"
			);
			expect(listener.isRunning()).toBe(false);
		} finally {
			await new Promise((resolve) => squatter.close(resolve));
		}
	});
});

describe("buildMcpStatus", () => {
	const inUse: McpStartError = { code: "EADDRINUSE", message: "Another program holds it." };

	it("reports the failure while the server is enabled and not listening", () => {
		expect(
			buildMcpStatus({ listener: null, enabled: true, error: inUse, corruptCopy: null })
		).toEqual({
			running: false,
			url: MCP_ENDPOINT_URL,
			enabled: true,
			error: inUse,
		});
	});

	it("carries no error key once a later start succeeded and the error was cleared", () => {
		// `startMcp` resets the error before it tries; this is the state it leaves.
		const status = buildMcpStatus({
			listener: listening(),
			enabled: true,
			error: null,
			corruptCopy: null,
		});
		expect(status).toEqual({ running: true, url: "http://127.0.0.1:9877/mcp", enabled: true });
		expect("error" in status).toBe(false);
	});

	it("drops a stale error rather than report a running server as failed", () => {
		expect(
			buildMcpStatus({
				listener: listening(),
				enabled: true,
				error: inUse,
				corruptCopy: null,
			}).error
		).toBe(undefined);
	});

	it("reads running from the listener, not from its existence", () => {
		expect(
			buildMcpStatus({ listener: closed, enabled: true, error: null, corruptCopy: null })
				.running
		).toBe(false);
	});

	it("names the kept copy of an unreadable settings file, running or not (#2433)", () => {
		const corruptCopy = "C:/data/mcp-config.json.corrupt-1700000000000";
		const down = buildMcpStatus({ listener: null, enabled: false, error: null, corruptCopy });
		const up = buildMcpStatus({
			listener: listening(),
			enabled: true,
			error: null,
			corruptCopy,
		});

		expect(down.corruptCopy).toBe(corruptCopy);
		expect(up.corruptCopy).toBe(corruptCopy);
	});

	it("carries no corruptCopy key when the file was readable", () => {
		const status = buildMcpStatus({
			listener: listening(),
			enabled: true,
			error: null,
			corruptCopy: null,
		});
		expect("corruptCopy" in status).toBe(false);
	});

	it("passes the enabled flag through untouched", () => {
		expect(
			buildMcpStatus({ listener: null, enabled: false, error: null, corruptCopy: null })
				.enabled
		).toBe(false);
	});
});

describe("connectWhileRunning", () => {
	it("registers the live listener's URL when it is up", async () => {
		const connect = vi.fn(async () => ({ ok: true }));
		const result = await connectWhileRunning(
			"claude",
			listening("http://127.0.0.1:9999/mcp"),
			connect
		);
		expect(result).toEqual({ ok: true });
		expect(connect).toHaveBeenCalledWith("claude", "http://127.0.0.1:9999/mcp");
	});

	it.each([
		["no listener", null],
		["a listener that is not listening", closed],
	])("refuses with not-running for %s and never reaches the CLI", async (_label, listener) => {
		const connect = vi.fn(async () => ({ ok: true }));
		const result = await connectWhileRunning("vscode", listener, connect);
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("not-running");
		expect(result.message).toBeTruthy();
		expect(connect).not.toHaveBeenCalled();
	});
});
