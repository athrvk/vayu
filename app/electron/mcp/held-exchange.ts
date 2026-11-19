/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file held-exchange.ts
 * @brief One exchange the MCP HTTP host is serving, and the answer it is owed
 *        when the host cuts it (#3598).
 *
 * A cut is a stop (MCP switched off, the app quitting) or a 2025-era client's
 * cancel. Either way the SDK ends the response stream with no answer, and what
 * that costs the client depends on how far the response got. Before any of it
 * is out, a stop drops a 2025-era connection (a 2026-07-28 call gets the SDK's
 * bare `499`) and a cancel lets the empty stream end: the client's fetch fails
 * at once, or the client that cancelled has stopped waiting. Once a byte is
 * out, an SDK client is reading a stream and acts on nothing but a JSON-RPC
 * response for its request id, so a stream that just ends holds the call until
 * the client's own request timeout. So a cut stream that is already under way
 * ends with an error frame for each request id it has not answered, naming the
 * cause.
 */

import type http from "node:http";
import { isJSONRPCRequest, isJSONRPCResponse, type RequestId } from "@modelcontextprotocol/server";

/** Why a stop ended a call, in the error the call is answered with. */
export const SERVER_STOPPED = "Vayu stopped the MCP server.";

/** Why a cancel ended a call, in the error the call is answered with. */
export const CALL_CANCELLED = "The call was cancelled.";

/**
 * JSON-RPC's implementation-defined server error: a cut is neither the
 * client's mistake nor a fault inside the server.
 */
export const CUT_ERROR_CODE = -32000;

/** An exchange from its request to the end of its response, and how a cut ends it. */
export class HeldExchange {
	private readonly controller = new AbortController();
	/** The request ids the stream has not answered yet, in the order they arrived. */
	private owed: RequestId[];
	private cause: string | undefined;
	private started = false;

	/**
	 * @param res    the Node response the exchange is written to
	 * @param body   the parsed request body: one message, or a batch
	 * @param legacy whether the 2025-era leg serves it
	 */
	constructor(
		readonly res: http.ServerResponse,
		body: unknown,
		readonly legacy: boolean
	) {
		this.owed = (Array.isArray(body) ? body : [body]).filter(isJSONRPCRequest).map((m) => m.id);
	}

	/** Aborted by a cut; the host serves a 2025-era exchange under it. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** Whether any of the response has been passed on to be written. */
	get answering(): boolean {
		return this.started;
	}

	/** End the exchange for @p cause, which its error frames name. The first cause stands. */
	cut(cause: string): void {
		this.cause ??= cause;
		this.controller.abort();
	}

	/**
	 * @p response with its body passed through on demand, ending a cut event
	 * stream with the error frames it owes. @p onEnd runs once, when the body
	 * ends, fails or is cancelled. Nothing is read ahead of the reader: the
	 * handler tears its server down when its own stream ends.
	 */
	relay(response: Response, onEnd: () => void = () => {}): Response {
		if (response.body === null) {
			onEnd();
			return response;
		}
		const reader = response.body.getReader();
		// A JSON body is sent whole; only an event stream can be cut short.
		const answers = isEventStream(response) ? new StreamAnswers() : undefined;
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			onEnd();
		};
		const body = new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					try {
						const { done, value } = await reader.read();
						if (done) {
							end();
							if (answers) this.owedFrames().forEach((f) => controller.enqueue(f));
							controller.close();
							return;
						}
						this.started = true;
						if (answers && this.owed.length > 0) this.settle(answers.read(value));
						controller.enqueue(value);
					} catch (err) {
						end();
						controller.error(err);
					}
				},
				cancel: (reason) => {
					end();
					return reader.cancel(reason);
				},
			},
			{ highWaterMark: 0 }
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	private settle(answered: RequestId[]): void {
		this.owed = this.owed.filter((id) => !answered.includes(id));
	}

	/** One error frame per unanswered id, when a cut ended a stream already under way. */
	private owedFrames(): Uint8Array[] {
		const cause = this.cause;
		if (cause === undefined || !this.started) return [];
		const encoder = new TextEncoder();
		const frames = this.owed.map((id) => encoder.encode(errorFrame(id, cause)));
		this.owed = [];
		return frames;
	}
}

/** The SSE frame the SDK writes for a message, carrying a JSON-RPC error for @p id. */
export function errorFrame(id: RequestId, message: string): string {
	const error = { jsonrpc: "2.0", id, error: { code: CUT_ERROR_CODE, message } };
	return `event: message\ndata: ${JSON.stringify(error)}\n\n`;
}

function isEventStream(response: Response): boolean {
	const type = response.headers.get("content-type") ?? "";
	return type.split(";")[0].trim().toLowerCase() === "text/event-stream";
}

/**
 * The request ids an event stream answers, read event by event as its bytes
 * pass. An event ends at a blank line (the SDK writes LF line endings only),
 * and a client dispatches none before it, so a tail the stream ends on
 * answers nothing.
 */
class StreamAnswers {
	private readonly decoder = new TextDecoder();
	private pending = "";

	/** The ids answered by the events @p chunk completes. */
	read(chunk: Uint8Array): RequestId[] {
		this.pending += this.decoder.decode(chunk, { stream: true });
		const events = this.pending.split("\n\n");
		this.pending = events.pop() ?? "";
		return events.flatMap(answeredIdOf);
	}
}

/** The id a JSON-RPC response in @p event answers; empty for any other event. */
function answeredIdOf(event: string): RequestId[] {
	const data = event
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice("data:".length).replace(/^ /, ""))
		.join("\n");
	if (data === "") return [];
	try {
		const message: unknown = JSON.parse(data);
		if (!isJSONRPCResponse(message) || message.id === undefined) return [];
		return [message.id];
	} catch {
		return [];
	}
}
