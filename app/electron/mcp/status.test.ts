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

import { MCP_PORT, mcpEndpointUrl } from "../constants.js";
import { McpListener } from "./listener.js";
import {
	buildMcpStatus,
	classifyStartError,
	connectWhileRunning,
	type McpListenerState,
	type McpPortState,
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
/** A fresh install: nothing configured, so the default is both saved and in force. */
const AT_DEFAULT: McpPortState = { configured: MCP_PORT, inForce: MCP_PORT, storedError: null };

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

	it("does not blame a port for a failure that came before there was one to bind", () => {
		expect(classifyStartError(errno("EADDRINUSE"), null).code).toBe("other");
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
			buildMcpStatus({
				listener: null,
				enabled: true,
				error: inUse,
				corruptCopy: null,
				port: AT_DEFAULT,
			})
		).toEqual({
			running: false,
			url: mcpEndpointUrl(MCP_PORT),
			port: MCP_PORT,
			restartRequired: false,
			enabled: true,
			starting: false,
			error: inUse,
		});
	});

	it("carries no error key once a later start succeeded and the error was cleared", () => {
		// A listening lifecycle reports no start error; this is the state it leaves.
		const status = buildMcpStatus({
			listener: listening(),
			enabled: true,
			error: null,
			corruptCopy: null,
			port: AT_DEFAULT,
		});
		expect(status).toEqual({
			running: true,
			url: "http://127.0.0.1:9877/mcp",
			enabled: true,
			port: MCP_PORT,
			restartRequired: false,
			starting: false,
		});
		expect("error" in status).toBe(false);
	});

	// Before launch reaches the first start, and again while the bind is in
	// flight, the lifecycle has no listener and no failure (#3579).
	it("is starting while enabled with neither a listener nor a failure", () => {
		const status = buildMcpStatus({
			listener: null,
			enabled: true,
			error: null,
			corruptCopy: null,
			port: AT_DEFAULT,
		});
		expect(status).toEqual({
			running: false,
			url: mcpEndpointUrl(MCP_PORT),
			port: MCP_PORT,
			restartRequired: false,
			enabled: true,
			starting: true,
		});
		expect("error" in status).toBe(false);
	});

	it("is not starting once the start failed, so the real reason shows (#2368)", () => {
		const status = buildMcpStatus({
			listener: null,
			enabled: true,
			error: inUse,
			corruptCopy: null,
			port: AT_DEFAULT,
		});
		expect(status.starting).toBe(false);
		expect(status.error).toEqual(inUse);
	});

	it("is not starting once listening, nor while the server is switched off", () => {
		expect(
			buildMcpStatus({
				listener: listening(),
				enabled: true,
				error: null,
				corruptCopy: null,
				port: AT_DEFAULT,
			}).starting
		).toBe(false);
		expect(
			buildMcpStatus({
				listener: null,
				enabled: false,
				error: null,
				corruptCopy: null,
				port: AT_DEFAULT,
			}).starting
		).toBe(false);
	});

	it("drops a stale error rather than report a running server as failed", () => {
		expect(
			buildMcpStatus({
				listener: listening(),
				enabled: true,
				error: inUse,
				corruptCopy: null,
				port: AT_DEFAULT,
			}).error
		).toBe(undefined);
	});

	it("reads running from the listener, not from its existence", () => {
		expect(
			buildMcpStatus({
				listener: closed,
				enabled: true,
				error: null,
				corruptCopy: null,
				port: AT_DEFAULT,
			}).running
		).toBe(false);
	});

	it("names the kept copy of an unreadable settings file, running or not (#2433)", () => {
		const corruptCopy = "C:/data/mcp-config.json.corrupt-1700000000000";
		const down = buildMcpStatus({
			listener: null,
			enabled: false,
			error: null,
			corruptCopy,
			port: AT_DEFAULT,
		});
		const up = buildMcpStatus({
			listener: listening(),
			enabled: true,
			error: null,
			corruptCopy,
			port: AT_DEFAULT,
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
			port: AT_DEFAULT,
		});
		expect("corruptCopy" in status).toBe(false);
	});

	it("passes the enabled flag through untouched", () => {
		expect(
			buildMcpStatus({
				listener: null,
				enabled: false,
				error: null,
				corruptCopy: null,
				port: AT_DEFAULT,
			}).enabled
		).toBe(false);
	});
});

/*
 * #3580: the port is configurable, and the engine learns it only at spawn. The
 * status carries the configured value for the field, and says when it is not
 * in force yet, so "restart needed" survives a renderer reload. Mutation check:
 * build the fallback URL from the configured port, or derive restartRequired
 * as false, and the cases below red.
 */
describe("buildMcpStatus and a configured port", () => {
	const SAVED = 19_877;
	const base = { enabled: true, error: null, corruptCopy: null } as const;

	it("names the port in force, not the saved one, while nothing listens", () => {
		const status = buildMcpStatus({
			...base,
			listener: null,
			port: { configured: SAVED, inForce: MCP_PORT, storedError: null },
		});

		expect(status.url).toBe(mcpEndpointUrl(MCP_PORT));
		expect(status.port).toBe(SAVED);
		expect(status.restartRequired).toBe(true);
	});

	it("follows the saved port once it is the one in force", () => {
		const status = buildMcpStatus({
			...base,
			listener: null,
			port: { configured: SAVED, inForce: SAVED, storedError: null },
		});

		expect(status.url).toBe(mcpEndpointUrl(SAVED));
		expect(status.restartRequired).toBe(false);
	});

	it("still asks for a restart while the server is switched off", () => {
		const status = buildMcpStatus({
			...base,
			enabled: false,
			listener: null,
			port: { configured: SAVED, inForce: MCP_PORT, storedError: null },
		});

		expect(status.restartRequired).toBe(true);
	});

	it("reports a stored port set aside for the default, and carries no key otherwise", () => {
		const storedError = "mcp-config.json sets the MCP port to 9885, which isn't usable.";
		const noted = buildMcpStatus({
			...base,
			listener: listening(),
			port: { configured: MCP_PORT, inForce: MCP_PORT, storedError },
		});

		expect(noted.storedPortError).toBe(storedError);
		expect(
			"storedPortError" in buildMcpStatus({ ...base, listener: null, port: AT_DEFAULT })
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
