/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file lifecycle.ts
 * @brief The one owner of the MCP server's running state: whether the port is
 *        bound, the service behind it, and why the last start failed.
 *
 *        The state is a single value, `off | starting | listening | failed`,
 *        and every start and stop takes a new generation. An async step (the
 *        bind, the lazy service load) carries the generation it began under and
 *        publishes nothing once a stop has moved past it: a stop that lands
 *        mid-start waits for the start and closes what it bound, and a service
 *        whose load outlives its listener is never built (#3337).
 *
 *        Electron-free and SDK-free on purpose: `main.ts` imports it eagerly
 *        (`startup-import-graph.test.ts`), and the SDK arrives through
 *        `loadServiceFactory` on the first request.
 */

import type { LogFields } from "../log.js";
import type { McpRequestHandler } from "./listener.js";
import { classifyStartError, type McpListenerState, type McpStartError } from "./status.js";

/** The slice of `McpListener` the lifecycle drives. */
export interface McpLifecycleListener extends McpListenerState {
	start(): Promise<void>;
	stop(): Promise<void>;
}

/** The slice of `VayuMcpService` the lifecycle drives. */
export interface McpLifecycleService {
	handleRequest: McpRequestHandler;
	stop(): Promise<void>;
}

export interface McpLifecycleDeps<S extends McpLifecycleService> {
	/** The persisted preference; a throw is recorded as a failed start. */
	isEnabled(): boolean;
	/** Where the listener binds, for the failure wording. */
	endpoint: { host: string; port: number };
	/** A listener that asks `loadHandler` for the handler on its first request. */
	makeListener(loadHandler: () => Promise<McpRequestHandler>): McpLifecycleListener;
	/**
	 * Loads what the service needs and returns its constructor. Split from the
	 * construction so the lifecycle builds and publishes the service in one
	 * synchronous step: whatever the constructor reads (the persisted safety
	 * config) cannot change between the build and the publish.
	 */
	loadServiceFactory(): Promise<() => S>;
	log(level: "info" | "error", msg: string, fields?: LogFields): void;
}

export interface McpLifecycle<S extends McpLifecycleService> {
	/** Binds the port if enabled. Joins a start in flight; never rejects. */
	start(): Promise<void>;
	/** Resolves once nothing is bound. Also drops a failed start's error. */
	stop(): Promise<void>;
	/** The listener, only while it is up. */
	listener(): McpListenerState | null;
	/** The service, only while it is listening and a request has built it. */
	service(): S | null;
	/** Why the last start failed, while that is still the state. */
	startError(): McpStartError | null;
	/** Starting or listening: something a quit has to stop. */
	isActive(): boolean;
}

type State<S> =
	| { kind: "off" }
	| { kind: "starting"; done: Promise<void> }
	| { kind: "listening"; generation: number; listener: McpLifecycleListener; service: S | null }
	| { kind: "failed"; error: McpStartError };

const OFF = { kind: "off" } as const;

export function createMcpLifecycle<S extends McpLifecycleService>(
	deps: McpLifecycleDeps<S>
): McpLifecycle<S> {
	let state: State<S> = OFF;
	let generation = 0;
	// The close of whatever the last stop took down. A start waits for it, so
	// a re-enable never binds against its own predecessor's port.
	let stopping: Promise<void> = Promise.resolve();

	const isCurrent = (owner: number) => owner === generation;

	async function close(service: S | null, listener: McpLifecycleListener): Promise<void> {
		try {
			// The service first: it holds the exchanges a 2026-07-28 client keeps
			// open, which the listener's close would otherwise wait on.
			await service?.stop();
			await listener.stop();
			deps.log("info", "MCP server stopped");
		} catch (error) {
			deps.log("error", "Error stopping MCP server", { error: String(error) });
		}
	}

	function recordFailure(owner: number, error: unknown): void {
		const failure = classifyStartError(error, deps.endpoint);
		deps.log("error", "Failed to start MCP server (continuing without it)", {
			error: String(error),
			code: failure.code,
		});
		if (isCurrent(owner)) state = { kind: "failed", error: failure };
	}

	/** The bound listener, or null once `state` says why there is none. */
	async function bind(owner: number): Promise<McpLifecycleListener | null> {
		try {
			if (!deps.isEnabled()) {
				state = OFF;
				deps.log("info", "MCP server disabled by preference; not starting.");
				return null;
			}
			const listener = deps.makeListener(() => loadHandler(owner));
			await listener.start();
			return listener;
		} catch (error) {
			recordFailure(owner, error);
			return null;
		}
	}

	async function runStart(owner: number): Promise<void> {
		await stopping;
		if (!isCurrent(owner)) return;
		const listener = await bind(owner);
		if (!listener) return;
		if (!isCurrent(owner)) {
			await close(null, listener);
			return;
		}
		state = { kind: "listening", generation: owner, listener, service: null };
		deps.log("info", "MCP server listening", { url: listener.url });
	}

	async function loadHandler(owner: number): Promise<McpRequestHandler> {
		const create = await deps.loadServiceFactory();
		const current = state;
		if (current.kind !== "listening" || current.generation !== owner) {
			throw new Error("The MCP server stopped before its service finished loading.");
		}
		const service = create();
		state = { ...current, service };
		return (req, res) => service.handleRequest(req, res);
	}

	function release(previous: State<S>): Promise<void> {
		// A start in flight sees its generation is stale and closes its own listener.
		if (previous.kind === "starting") return previous.done;
		if (previous.kind === "listening") return close(previous.service, previous.listener);
		return Promise.resolve();
	}

	return {
		start() {
			if (state.kind === "starting") return state.done;
			if (state.kind === "listening") return Promise.resolve();
			const owner = ++generation;
			const done = runStart(owner);
			state = { kind: "starting", done };
			return done;
		},
		stop() {
			generation++;
			const previous = state;
			state = OFF;
			stopping = Promise.all([stopping, release(previous)]).then(() => undefined);
			return stopping;
		},
		listener: () => (state.kind === "listening" ? state.listener : null),
		service: () => (state.kind === "listening" ? state.service : null),
		startError: () => (state.kind === "failed" ? state.error : null),
		isActive: () => state.kind === "starting" || state.kind === "listening",
	};
}
