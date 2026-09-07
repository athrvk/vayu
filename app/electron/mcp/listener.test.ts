/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import http from "node:http";
import net from "node:net";
import { describe, it, expect, afterEach, vi } from "vitest";
import { McpListener, type McpRequestHandler } from "./listener.js";
import { MCP_PATH } from "../constants.js";

/** A port nothing holds right now, so the fixed MCP port stays out of the tests. */
function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as net.AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

interface Answer {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

function request(port: number, method: string, path: string, body = ""): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				method,
				path,
				headers: { "Content-Type": "application/json" },
			},
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => (text += chunk));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
				);
			}
		);
		req.on("error", reject);
		req.end(body);
	});
}

const okHandler: McpRequestHandler = async (_req, res) => {
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ served: true }));
};

describe("McpListener", () => {
	let listener: McpListener | null = null;
	afterEach(async () => {
		await listener?.stop();
		listener = null;
	});

	it("binds the port without loading the handler", async () => {
		const port = await freePort();
		const loadHandler = vi.fn(async () => okHandler);
		listener = new McpListener({ host: "127.0.0.1", port, loadHandler });
		await listener.start();

		expect(listener.isRunning()).toBe(true);
		expect(listener.url).toBe(`http://127.0.0.1:${port}${MCP_PATH}`);
		expect(loadHandler).not.toHaveBeenCalled();
	});

	it("refuses the wrong path and the wrong method before loading anything", async () => {
		const port = await freePort();
		const loadHandler = vi.fn(async () => okHandler);
		listener = new McpListener({ host: "127.0.0.1", port, loadHandler });
		await listener.start();

		const probe = await request(port, "GET", "/");
		expect(probe.status).toBe(404);
		expect(JSON.parse(probe.body)).toEqual({
			error: "Not found. The MCP endpoint is at /mcp.",
		});

		const get = await request(port, "GET", MCP_PATH);
		expect(get.status).toBe(405);
		expect(get.headers.allow).toBe("POST");
		expect(JSON.parse(get.body)).toEqual({
			jsonrpc: "2.0",
			error: { code: -32000, message: "Method not allowed. This endpoint is POST-only." },
			id: null,
		});

		expect(loadHandler).not.toHaveBeenCalled();
	});

	it("loads on the first POST, once, and concurrent first requests share the load", async () => {
		const port = await freePort();
		let release: (handler: McpRequestHandler) => void = () => {};
		const loadHandler = vi.fn(
			() => new Promise<McpRequestHandler>((resolve) => (release = resolve))
		);
		listener = new McpListener({ host: "127.0.0.1", port, loadHandler });
		await listener.start();

		const first = request(port, "POST", MCP_PATH, "{}");
		const second = request(port, "POST", MCP_PATH, "{}");
		// Both are in flight against one load: let it finish.
		await vi.waitFor(() => expect(loadHandler).toHaveBeenCalledTimes(1));
		release(okHandler);

		const answers = await Promise.all([first, second]);
		expect(answers.map((a) => a.status)).toEqual([200, 200]);
		expect(answers.map((a) => JSON.parse(a.body))).toEqual([
			{ served: true },
			{ served: true },
		]);

		const third = await request(port, "POST", MCP_PATH, "{}");
		expect(third.status).toBe(200);
		expect(loadHandler).toHaveBeenCalledTimes(1);
	});

	it("answers a failed load with the 500 shape and asks again on the next request", async () => {
		const port = await freePort();
		const loadHandler = vi
			.fn<() => Promise<McpRequestHandler>>()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue(okHandler);
		listener = new McpListener({ host: "127.0.0.1", port, loadHandler });
		await listener.start();

		const failed = await request(port, "POST", MCP_PATH, "{}");
		expect(failed.status).toBe(500);
		expect(JSON.parse(failed.body)).toEqual({
			jsonrpc: "2.0",
			error: { code: -32603, message: "Internal error: Error: boom" },
			id: null,
		});

		const served = await request(port, "POST", MCP_PATH, "{}");
		expect(served.status).toBe(200);
		expect(loadHandler).toHaveBeenCalledTimes(2);
	});

	it("answers a handler that throws with the 500 shape", async () => {
		const port = await freePort();
		listener = new McpListener({
			host: "127.0.0.1",
			port,
			loadHandler: async () => async () => {
				throw new Error("handler fell over");
			},
		});
		await listener.start();

		const answer = await request(port, "POST", MCP_PATH, "{}");
		expect(answer.status).toBe(500);
		expect(JSON.parse(answer.body).error.code).toBe(-32603);
	});

	it("stop closes the port", async () => {
		const port = await freePort();
		listener = new McpListener({ host: "127.0.0.1", port, loadHandler: async () => okHandler });
		await listener.start();
		await listener.stop();

		expect(listener.isRunning()).toBe(false);
		await expect(request(port, "POST", MCP_PATH, "{}")).rejects.toMatchObject({
			code: "ECONNREFUSED",
		});
	});
});
