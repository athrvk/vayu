/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The session Console's rows (#3634): everything this window sent, newest
 * last - each Send, the scripts' console lines and `pm.sendRequest` calls
 * around it, and each collection-run step.
 *
 * In memory only, like `response-store`: a reload or a quit empties it, and
 * History is what persists. The ring is bounded twice, by
 * {@link CONSOLE_MAX_ROWS} and by {@link CONSOLE_MAX_BYTES} of retained text,
 * and evicts oldest first; the newest row is never the victim. A body kept on
 * a row is cut at {@link CONSOLE_BODY_MAX_CHARS} here, on the way in, so no
 * writer can store more.
 *
 * Rows arrive masked: `modules/console/console-rows.ts` builds them, and this
 * store holds whatever it is handed.
 */

import { create } from "zustand";
import type {
	ConsoleLevel,
	ElementScope,
	ResponseTiming,
	ScriptSource,
	StepOutcome,
} from "@/types";

/** The most rows the ring holds. */
export const CONSOLE_MAX_ROWS = 5_000;

/**
 * The most retained text the ring holds, as {@link estimateConsoleRowBytes}
 * counts it.
 */
export const CONSOLE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Where a body kept on a row is cut, in UTF-16 code units: 256 KiB of ASCII
 * text. A row with a `runId` can point at the stored trace, which holds the
 * body up to `maxTraceBodyBytes`.
 */
export const CONSOLE_BODY_MAX_CHARS = 256 * 1024;

/** A request or response body as a row keeps it. */
export interface ConsoleBody {
	text: string;
	/** Set when the ring cut `text` at {@link CONSOLE_BODY_MAX_CHARS}. */
	cut?: true;
	/** `text` is the bytes in base64, as the engine recorded a binary body. */
	base64?: true;
}

/** What a request row expands to. Header values are masked before they get here. */
export interface ConsoleExchange {
	requestHeaders: Record<string, string>;
	requestBody?: ConsoleBody;
	responseHeaders: Record<string, string>;
	responseBody?: ConsoleBody;
	timing?: ResponseTiming;
}

/** The summary line every request row draws. */
interface ConsoleRequestSummary {
	method: string;
	/** Masked: no userinfo password, no credential query value. */
	url: string;
	/** `0` when the exchange failed before an answer; `errorCode` then says why. */
	status: number;
	statusText?: string;
	timeMs: number;
	/** The response body's size in bytes. */
	sizeBytes: number;
	errorCode?: string;
	errorMessage?: string;
}

/** One Send from a request tab, buffered or streamed. */
export interface ConsoleSendRow extends ConsoleRequestSummary {
	kind: "send";
	/** The stored request that was sent. */
	requestId?: string;
	/** The run the send was filed under, when the app learned it (a stream's). */
	runId?: string;
	exchange: ConsoleExchange;
}

/** One `pm.sendRequest` a Send's script made (#3633), masked by the engine. */
export interface ConsoleScriptRequestRow extends ConsoleRequestSummary {
	kind: "scriptRequest";
	/** The script that made it: pre-request or post-response, at which level. */
	source: ScriptSource;
	scope?: ElementScope;
	/** The request whose Send ran the script. */
	requestId?: string;
	/** The summary line the script printed for this call, which this row stands in for. */
	line?: string;
	exchange: ConsoleExchange;
}

/** One line a Send's script wrote. */
export interface ConsoleLineRow {
	kind: "line";
	source: ScriptSource;
	scope?: ElementScope;
	level: ConsoleLevel;
	message: string;
	requestId?: string;
}

/**
 * One collection-run step, from its `step` frame. A frame is constant-size by
 * rule, so the exchange, the step's console lines and its script requests are
 * read from the stored row (`GET /runs/:id/results`) by `runId`, `iteration`
 * and `stepIndex` when the row is expanded.
 */
export interface ConsoleStepRow {
	kind: "step";
	runId: string;
	iteration: number;
	stepIndex: number;
	name: string;
	outcome: StepOutcome;
	/** Absent for a step that sent nothing; the URL is the engine's masked, 512-byte cut. */
	method?: string;
	url?: string;
	status: number;
	timeMs: number;
	sizeBytes?: number;
	requestId?: string;
}

/** What a writer hands {@link ConsoleStoreState.append}: a row without the ring's own fields. */
export type ConsoleRowInput =
	ConsoleSendRow | ConsoleScriptRequestRow | ConsoleLineRow | ConsoleStepRow;

/** A row in the ring: `id` is unique for the session, `at` is when it was appended (epoch ms). */
export type ConsoleRow = ConsoleRowInput & { id: number; at: number };

export type ConsoleRowKind = ConsoleRow["kind"];

interface ConsoleStoreState {
	/** Oldest first. */
	rows: readonly ConsoleRow[];
	/** {@link estimateConsoleRowBytes} summed over `rows`. */
	retainedBytes: number;
	/** How many rows the bounds have dropped since the last clear. */
	evictedCount: number;
	/**
	 * The run identity of each row that has one (a step's run, iteration and
	 * position; a streamed Send's run), so a replayed frame or a second
	 * finalisation of one run appends nothing.
	 */
	runKeys: ReadonlySet<string>;
	nextId: number;
	/** Append rows in the order given, then evict past the bounds. */
	append: (rows: readonly ConsoleRowInput[]) => void;
	/** Empty the ring. History is untouched: nothing here was ever stored there. */
	clear: () => void;
}

/** The text a body costs, two bytes per UTF-16 code unit as `estimateResponseBytes` counts. */
function textBytes(text: string | undefined): number {
	return (text?.length ?? 0) * 2;
}

function headerBytes(headers: Readonly<Record<string, string>>): number {
	let bytes = 0;
	for (const [name, value] of Object.entries(headers))
		bytes += textBytes(name) + textBytes(value);
	return bytes;
}

function exchangeBytes(exchange: ConsoleExchange): number {
	return (
		headerBytes(exchange.requestHeaders) +
		headerBytes(exchange.responseHeaders) +
		textBytes(exchange.requestBody?.text) +
		textBytes(exchange.responseBody?.text)
	);
}

/**
 * What a row's text costs, as a documented estimate in the response store's
 * measure (`estimateResponseBytes`): every string it holds at two bytes per
 * UTF-16 code unit. Numbers and flags are not counted.
 */
export function estimateConsoleRowBytes(row: ConsoleRowInput): number {
	switch (row.kind) {
		case "line":
			return textBytes(row.message);
		case "step":
			return textBytes(row.name) + textBytes(row.url);
		case "send":
			return (
				textBytes(row.url) +
				textBytes(row.statusText) +
				textBytes(row.errorMessage) +
				exchangeBytes(row.exchange)
			);
		case "scriptRequest":
			return (
				textBytes(row.url) +
				textBytes(row.line) +
				textBytes(row.statusText) +
				textBytes(row.errorMessage) +
				exchangeBytes(row.exchange)
			);
	}
}

/** @p body cut at {@link CONSOLE_BODY_MAX_CHARS}, never inside a surrogate pair. */
function cutBody(body: ConsoleBody | undefined): ConsoleBody | undefined {
	if (!body || body.text.length <= CONSOLE_BODY_MAX_CHARS) return body;
	let end = CONSOLE_BODY_MAX_CHARS;
	const last = body.text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return { ...body, text: body.text.slice(0, end), cut: true };
}

function withBodiesCut(row: ConsoleRowInput): ConsoleRowInput {
	if (row.kind !== "send" && row.kind !== "scriptRequest") return row;
	const { exchange } = row;
	return {
		...row,
		exchange: {
			...exchange,
			requestBody: cutBody(exchange.requestBody),
			responseBody: cutBody(exchange.responseBody),
		},
	};
}

function runKeyOf(row: ConsoleRowInput): string | undefined {
	if (row.kind === "step") return `step:${row.runId}:${row.iteration}:${row.stepIndex}`;
	if (row.kind === "send" && row.runId) return `send:${row.runId}`;
	return undefined;
}

type RingState = Pick<
	ConsoleStoreState,
	"rows" | "retainedBytes" | "evictedCount" | "runKeys" | "nextId"
>;

/**
 * The one place rows enter, so the rows, their byte total and the run keys
 * cannot disagree. Shaped after `response-store`'s `withResponse`: stopping at
 * one row is what keeps the newest, even when it alone is over the budget.
 */
function withAppended(state: RingState, inputs: readonly ConsoleRowInput[]): RingState {
	const at = Date.now();
	const runKeys = new Set(state.runKeys);
	const rows = [...state.rows];
	let bytes = state.retainedBytes;
	let nextId = state.nextId;
	for (const input of inputs) {
		const key = runKeyOf(input);
		if (key !== undefined) {
			if (runKeys.has(key)) continue;
			runKeys.add(key);
		}
		const row = withBodiesCut(input);
		rows.push({ ...row, id: nextId++, at });
		bytes += estimateConsoleRowBytes(row);
	}
	if (rows.length === state.rows.length) return state;

	let dropped = 0;
	while (
		rows.length - dropped > 1 &&
		(rows.length - dropped > CONSOLE_MAX_ROWS || bytes > CONSOLE_MAX_BYTES)
	) {
		const victim = rows[dropped++];
		bytes -= estimateConsoleRowBytes(victim);
		const key = runKeyOf(victim);
		if (key !== undefined) runKeys.delete(key);
	}

	return {
		rows: dropped > 0 ? rows.slice(dropped) : rows,
		retainedBytes: bytes,
		evictedCount: state.evictedCount + dropped,
		runKeys,
		nextId,
	};
}

export const useConsoleStore = create<ConsoleStoreState>((set) => ({
	rows: [],
	retainedBytes: 0,
	evictedCount: 0,
	runKeys: new Set(),
	nextId: 1,

	append: (inputs) => {
		if (inputs.length === 0) return;
		set((state) => withAppended(state, inputs));
	},

	// `nextId` carries on, so a row appended after a clear never reuses a key
	// a list rendered before it.
	clear: () => set({ rows: [], retainedBytes: 0, evictedCount: 0, runKeys: new Set() }),
}));

export const selectConsoleRows = (state: ConsoleStoreState) => state.rows;
export const selectConsoleEvictedCount = (state: ConsoleStoreState) => state.evictedCount;
