/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
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
 *        The listener only ever holds the port the engine guards (#3580): a
 *        spawn that will guard another port first takes it down
 *        (`releaseForSpawn`), and `followEndpoint` binds it again once the
 *        engine is up. A released server is off, not disabled: it is the one
 *        state `followEndpoint` starts from.
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

export interface McpEndpoint {
	host: string;
	port: number;
}

export interface McpLifecycleDeps<S extends McpLifecycleService> {
	/** The persisted preference; a throw is recorded as a failed start. */
	isEnabled(): boolean;
	/**
	 * Where the next bind goes, read by each start: the port the engine being
	 * spawned, or last spawned, refuses to reach (#3580). A throw is recorded as
	 * a failed start.
	 */
	endpoint(): McpEndpoint;
	/** A listener on `endpoint` that asks `loadHandler` for the handler on its first request. */
	makeListener(
		endpoint: McpEndpoint,
		loadHandler: () => Promise<McpRequestHandler>
	): McpLifecycleListener;
	/**
	 * Loads what the service needs and returns its constructor, which is handed
	 * the listener's endpoint. Split from the construction so the lifecycle
	 * builds and publishes the service in one synchronous step: whatever the
	 * constructor reads (the persisted safety config) cannot change between the
	 * build and the publish.
	 */
	loadServiceFactory(): Promise<(endpoint: McpEndpoint) => S>;
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
	/** The port the listener holds, or the one the last start failed to bind; else null. */
	heldPort(): number | null;
	/**
	 * Called before each engine spawn with the MCP port that engine will guard.
	 * A listener on any other port is taken down and left released, so no
	 * engine runs while the server holds a port it does not guard; a stop or a
	 * start that lands before `followEndpoint` has the last word. A server on
	 * `guardedPort`, off, or failed is left as it is. Never rejects.
	 */
	releaseForSpawn(guardedPort: number): Promise<void>;
	/**
	 * Once a spawn has settled: start a server `releaseForSpawn` released, or
	 * stop and start again one that holds (or failed on) another port than
	 * `endpoint()` now names, so the listener follows the engine onto the port
	 * it guards. Nothing to do when off. Never rejects.
	 */
	followEndpoint(): Promise<void>;
}

type State<S> =
	| { kind: "off" }
	/** Off for an engine spawn, until `followEndpoint` starts it again. */
	| { kind: "released" }
	| { kind: "starting"; done: Promise<void> }
	| {
			kind: "listening";
			generation: number;
			listener: McpLifecycleListener;
			endpoint: McpEndpoint;
			service: S | null;
	  }
	/** `port` is null when the start failed before an endpoint was read. */
	| { kind: "failed"; error: McpStartError; port: number | null };

const OFF = { kind: "off" } as const;
const RELEASED = { kind: "released" } as const;

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
			// open and the 2025-era calls in flight, which the listener's close
			// would otherwise wait on.
			await service?.stop();
			await listener.stop();
			deps.log("info", "MCP server stopped");
		} catch (error) {
			deps.log("error", "Error stopping MCP server", { error: String(error) });
		}
	}

	function recordFailure(owner: number, error: unknown, endpoint: McpEndpoint | null): void {
		const failure = classifyStartError(error, endpoint);
		deps.log("error", "Failed to start MCP server (continuing without it)", {
			error: String(error),
			errorCode: failure.code,
		});
		if (isCurrent(owner)) {
			state = { kind: "failed", error: failure, port: endpoint?.port ?? null };
		}
	}

	/** The bound listener, or null once `state` says why there is none. */
	async function bind(
		owner: number
	): Promise<{ listener: McpLifecycleListener; endpoint: McpEndpoint } | null> {
		let endpoint: McpEndpoint | null = null;
		try {
			if (!deps.isEnabled()) {
				state = OFF;
				deps.log("info", "MCP server disabled by preference; not starting.");
				return null;
			}
			endpoint = deps.endpoint();
			const listener = deps.makeListener(endpoint, () => loadHandler(owner));
			await listener.start();
			return { listener, endpoint };
		} catch (error) {
			recordFailure(owner, error, endpoint);
			return null;
		}
	}

	async function runStart(owner: number): Promise<void> {
		await stopping;
		if (!isCurrent(owner)) return;
		const bound = await bind(owner);
		if (!bound) return;
		if (!isCurrent(owner)) {
			await close(null, bound.listener);
			return;
		}
		state = { kind: "listening", generation: owner, ...bound, service: null };
		deps.log("info", "MCP server listening", { url: bound.listener.url });
	}

	async function loadHandler(owner: number): Promise<McpRequestHandler> {
		const create = await deps.loadServiceFactory();
		const current = state;
		if (current.kind !== "listening" || current.generation !== owner) {
			throw new Error("The MCP server stopped before its service finished loading.");
		}
		const service = create(current.endpoint);
		state = { ...current, service };
		return (req, res) => service.handleRequest(req, res);
	}

	function release(previous: State<S>): Promise<void> {
		// A start in flight sees its generation is stale and closes its own listener.
		if (previous.kind === "starting") return previous.done;
		if (previous.kind === "listening") return close(previous.service, previous.listener);
		return Promise.resolve();
	}

	function start(): Promise<void> {
		if (state.kind === "starting") return state.done;
		if (state.kind === "listening") return Promise.resolve();
		const owner = ++generation;
		const done = runStart(owner);
		state = { kind: "starting", done };
		return done;
	}

	/** Moves past every async step in flight and closes what is up; `next` is what remains. */
	function takeDown(next: typeof OFF | typeof RELEASED): Promise<void> {
		generation++;
		const previous = state;
		state = next;
		stopping = Promise.all([stopping, release(previous)]).then(() => undefined);
		return stopping;
	}

	function stop(): Promise<void> {
		return takeDown(OFF);
	}

	function heldPort(): number | null {
		if (state.kind === "listening") return state.endpoint.port;
		if (state.kind === "failed") return state.port;
		return null;
	}

	/** A throw reads as moved: the start that follows records it as its failure. */
	function endpointMovedFrom(port: number): boolean {
		try {
			return deps.endpoint().port !== port;
		} catch {
			return true;
		}
	}

	async function releaseForSpawn(guardedPort: number): Promise<void> {
		while (state.kind === "starting") await state.done;
		if (state.kind !== "listening" || state.endpoint.port === guardedPort) return;
		await takeDown(RELEASED);
	}

	async function followEndpoint(): Promise<void> {
		if (state.kind === "starting") await state.done;
		// Only a release sets this state; a stop or start since then has the last word.
		if (state.kind === "released") return start();
		const held = heldPort();
		if (held === null || !endpointMovedFrom(held)) return;
		const stopped = stop();
		const owner = generation;
		await stopped;
		// A stop or start that landed meanwhile (a disable, the quit) has the last word.
		if (generation !== owner) return;
		await start();
	}

	return {
		start,
		stop,
		releaseForSpawn,
		followEndpoint,
		heldPort,
		listener: () => (state.kind === "listening" ? state.listener : null),
		service: () => (state.kind === "listening" ? state.service : null),
		startError: () => (state.kind === "failed" ? state.error : null),
		isActive: () => state.kind === "starting" || state.kind === "listening",
	};
}
