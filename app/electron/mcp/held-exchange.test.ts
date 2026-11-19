/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
	CALL_CANCELLED,
	CUT_ERROR_CODE,
	HeldExchange,
	SERVER_STOPPED,
	errorFrame,
} from "./held-exchange.js";

const res = {} as http.ServerResponse;
const call = (id: string | number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {} });
const result = (id: string | number) =>
	`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } })}\n\n`;
const progress = `event: message\ndata: ${JSON.stringify({
	jsonrpc: "2.0",
	method: "notifications/progress",
	params: { progressToken: 1, progress: 0 },
})}\n\n`;

/** An upstream body the test writes to and ends, as the SDK's stream would be. */
function upstream(contentType = "text/event-stream") {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
	const encoder = new TextEncoder();
	return {
		response: new Response(body, { headers: { "Content-Type": contentType } }),
		write: (text: string) => controller.enqueue(encoder.encode(text)),
		end: () => controller.close(),
	};
}

describe("HeldExchange", () => {
	it("passes an uncut stream through unchanged and reports its end once", async () => {
		const exchange = new HeldExchange(res, call(1), true);
		const source = upstream();
		const onEnd = vi.fn();
		const relayed = exchange.relay(source.response, onEnd);
		source.write(progress);
		source.write(result(1));
		source.end();
		expect(await relayed.text()).toBe(progress + result(1));
		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(exchange.answering).toBe(true);
	});

	it("ends a cut stream already under way with an error frame for its request id", async () => {
		const exchange = new HeldExchange(res, call(7), true);
		const source = upstream();
		const relayed = exchange.relay(source.response);
		const reader = relayed.body!.getReader();
		source.write(progress);
		await reader.read();
		exchange.cut(SERVER_STOPPED);
		source.end();
		let rest = "";
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			rest += new TextDecoder().decode(chunk.value);
		}
		expect(rest).toBe(errorFrame(7, SERVER_STOPPED));
		expect(JSON.parse(rest.split("data: ")[1])).toEqual({
			jsonrpc: "2.0",
			id: 7,
			error: { code: CUT_ERROR_CODE, message: SERVER_STOPPED },
		});
	});

	it("writes nothing for a cut stream none of which was passed on", async () => {
		const exchange = new HeldExchange(res, call(7), true);
		const source = upstream();
		const relayed = exchange.relay(source.response);
		exchange.cut(CALL_CANCELLED);
		source.end();
		expect(await relayed.text()).toBe("");
		expect(exchange.answering).toBe(false);
	});

	it("owes a batch's unanswered ids only, an answer split across chunks included", async () => {
		const exchange = new HeldExchange(res, [call(1), call("1"), call(2)], true);
		const source = upstream();
		const relayed = exchange.relay(source.response);
		const answer = result(1);
		source.write(answer.slice(0, 20));
		source.write(answer.slice(20));
		// A server-to-client request carries an id too, and answers nothing.
		source.write(
			`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n\n`
		);
		exchange.cut(SERVER_STOPPED);
		source.end();
		const text = await relayed.text();
		expect(text.endsWith(errorFrame("1", SERVER_STOPPED) + errorFrame(2, SERVER_STOPPED))).toBe(
			true
		);
		expect(text).not.toContain(errorFrame(1, SERVER_STOPPED));
	});

	it("names the first cause, and aborts the signal the exchange is served under", async () => {
		const exchange = new HeldExchange(res, call(1), true);
		const source = upstream();
		const relayed = exchange.relay(source.response);
		source.write(progress);
		exchange.cut(CALL_CANCELLED);
		exchange.cut(SERVER_STOPPED);
		expect(exchange.signal.aborted).toBe(true);
		source.end();
		expect(await relayed.text()).toBe(progress + errorFrame(1, CALL_CANCELLED));
	});

	it("appends nothing to a JSON body, which is sent whole", async () => {
		const exchange = new HeldExchange(res, call(1), true);
		const source = upstream("application/json");
		const relayed = exchange.relay(source.response);
		source.write('{"jsonrpc":"2.0"');
		exchange.cut(SERVER_STOPPED);
		source.end();
		expect(await relayed.text()).toBe('{"jsonrpc":"2.0"');
	});

	it("reports the end of a body the reader cancels, and of a response with none", async () => {
		const exchange = new HeldExchange(res, call(1), true);
		const source = upstream();
		const onEnd = vi.fn();
		await exchange.relay(source.response, onEnd).body!.cancel();
		expect(onEnd).toHaveBeenCalledTimes(1);
		const empty = vi.fn();
		exchange.relay(new Response(null, { status: 202 }), empty);
		expect(empty).toHaveBeenCalledTimes(1);
	});
});
