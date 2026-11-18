/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The MCP lifecycle against injected fakes (#3337). Every step that matters is
 * a promise the test holds, so an interleaving is staged by releasing one,
 * never by waiting out a duration; a step "has begun" when the fake reports
 * it, through a promise of its own.
 */

import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MCP_SAFETY_CONFIG, type McpSafetyConfig } from "./config.js";
import { freePort } from "./free-port.testkit.js";
import { McpListener, type McpRequestHandler } from "./listener.js";
import { buildMcpStatus } from "./status.js";
import {
	createMcpLifecycle,
	type McpEndpoint,
	type McpLifecycle,
	type McpLifecycleListener,
	type McpLifecycleService,
} from "./lifecycle.js";

interface Gate {
	promise: Promise<void>;
	open(): void;
}

function gate(): Gate {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => (open = resolve));
	return { promise, open };
}

class FakeListener implements McpLifecycleListener {
	bound = false;
	/** Held closed to keep the bind (or the close) in flight. */
	startGate: Gate | null = null;
	stopGate: Gate | null = null;
	startFailure: Error | null = null;

	constructor(
		readonly endpoint: McpEndpoint,
		readonly loadHandler: () => Promise<McpRequestHandler>,
		private readonly onStart: (listener: FakeListener) => void
	) {}

	get url(): string {
		return `http://${this.endpoint.host}:${this.endpoint.port}/mcp`;
	}

	isRunning(): boolean {
		return this.bound;
	}

	async start(): Promise<void> {
		this.onStart(this);
		await this.startGate?.promise;
		if (this.startFailure) throw this.startFailure;
		this.bound = true;
	}

	async stop(): Promise<void> {
		await this.stopGate?.promise;
		this.bound = false;
	}
}

class FakeService implements McpLifecycleService {
	readonly handleRequest = vi.fn<McpRequestHandler>(async () => {});
	readonly stop = vi.fn(async () => {});
	constructor(
		public safety: McpSafetyConfig,
		readonly endpoint: McpEndpoint
	) {}
}

const request = {} as http.IncomingMessage;
const response = {} as http.ServerResponse;

function harness() {
	const h = {
		enabled: (): boolean => true,
		/** What `endpoint()` answers: the port the engine guards, in main.ts. */
		endpoint: (): McpEndpoint => ({ host: "127.0.0.1", port: 0 }),
		/** What the service is constructed from, as `loadPersistedSafety()` is. */
		persisted: { ...DEFAULT_MCP_SAFETY_CONFIG },
		/** Held closed to keep the lazy service load in flight. */
		loadGate: null as Gate | null,
		/** Applied to each listener as it is made, before it starts. */
		configure: (_listener: FakeListener) => {},
		/** Runs right after a service is constructed, inside the same step. */
		afterConstruct: () => {},
		listeners: [] as FakeListener[],
		services: [] as FakeService[],
		started: [] as Array<(listener: FakeListener) => void>,
		log: vi.fn(),
	};
	const lifecycle = createMcpLifecycle<FakeService>({
		isEnabled: () => h.enabled(),
		endpoint: () => h.endpoint(),
		makeListener: (endpoint, loadHandler) => {
			const listener = new FakeListener(endpoint, loadHandler, (l) => h.started.shift()?.(l));
			h.configure(listener);
			h.listeners.push(listener);
			return listener;
		},
		loadServiceFactory: async () => {
			await h.loadGate?.promise;
			return (endpoint) => {
				const service = new FakeService(h.persisted, endpoint);
				h.services.push(service);
				queueMicrotask(h.afterConstruct);
				return service;
			};
		},
		log: h.log,
	});
	/** Resolves when the next listener's bind has begun. */
	const nextBind = () => new Promise<FakeListener>((resolve) => h.started.push(resolve));
	return { h, lifecycle, nextBind };
}

/**
 * `mcp:updateSafety`'s routing in main.ts: applied to the service when one
 * runs, and persisted either way for the next service to be built from.
 */
function changeSafety(
	lifecycle: McpLifecycle<FakeService>,
	store: { persisted: McpSafetyConfig },
	change: Partial<McpSafetyConfig>
): void {
	const service = lifecycle.service();
	if (service) service.safety = { ...service.safety, ...change };
	store.persisted = { ...store.persisted, ...change };
}

/**
 * Lets every microtask run. The fakes hold no timers, so whatever can happen
 * without a gate opening has happened once this resolves.
 */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createMcpLifecycle", () => {
	it("binds and publishes the listener when enabled", async () => {
		const { h, lifecycle } = harness();

		await lifecycle.start();

		expect(h.listeners).toHaveLength(1);
		expect(lifecycle.listener()).toBe(h.listeners[0]);
		expect(h.listeners[0].bound).toBe(true);
		expect(lifecycle.isActive()).toBe(true);
		expect(lifecycle.startError()).toBeNull();
	});

	it("makes no listener and loads nothing when the preference is off", async () => {
		const { h, lifecycle } = harness();
		h.enabled = () => false;
		const load = vi.fn();
		h.configure = load;

		await lifecycle.start();

		expect(load).not.toHaveBeenCalled();
		expect(h.services).toHaveLength(0);
		expect(lifecycle.isActive()).toBe(false);
		expect(lifecycle.startError()).toBeNull();
	});

	// The preference read is the first touch of the persisted MCP config, so a
	// corrupt store lands here; it must not reject the launch that awaits it.
	it("records a preference read that throws as a failed start, never a rejection", async () => {
		const { h, lifecycle } = harness();
		h.enabled = () => {
			throw new Error("mcp-config.json is unreadable");
		};

		await expect(lifecycle.start()).resolves.toBeUndefined();

		expect(h.listeners).toHaveLength(0);
		expect(lifecycle.startError()).toEqual({
			code: "other",
			message: expect.stringContaining("mcp-config.json is unreadable"),
		});
	});

	it("joins a start in flight rather than binding a second listener", async () => {
		const { h, lifecycle, nextBind } = harness();
		const held = gate();
		h.configure = (l) => (l.startGate = held);
		const binding = nextBind();

		const first = lifecycle.start();
		await binding;
		const second = lifecycle.start();
		held.open();
		await Promise.all([first, second]);

		expect(second).toBe(first);
		expect(h.listeners).toHaveLength(1);
	});

	it("ends a disable that lands mid-bind with nothing listening", async () => {
		const { h, lifecycle, nextBind } = harness();
		const held = gate();
		h.configure = (l) => (l.startGate = held);
		const binding = nextBind();

		const starting = lifecycle.start();
		const listener = await binding;
		const stopped = lifecycle.stop();
		held.open();
		await Promise.all([starting, stopped]);

		expect(listener.bound).toBe(false);
		expect(lifecycle.listener()).toBeNull();
		expect(lifecycle.isActive()).toBe(false);
	});

	it("does not resolve the stop until the bind it interrupted is closed", async () => {
		const { h, lifecycle, nextBind } = harness();
		const held = gate();
		h.configure = (l) => (l.startGate = held);
		const binding = nextBind();

		void lifecycle.start();
		const listener = await binding;
		let stopped = false;
		const stopping = lifecycle.stop().then(() => (stopped = true));
		await drain();
		expect(stopped).toBe(false);
		held.open();
		await stopping;

		expect(listener.bound).toBe(false);
	});

	it("never binds when quit stops it before the bind begins", async () => {
		const { h, lifecycle } = harness();

		const starting = lifecycle.start();
		await lifecycle.stop();
		await starting;

		expect(h.listeners).toHaveLength(0);
		expect(lifecycle.isActive()).toBe(false);
	});

	it("binds a re-enable only once the previous close has finished", async () => {
		const { h, lifecycle, nextBind } = harness();
		await lifecycle.start();
		const previous = h.listeners[0];
		const closing = gate();
		previous.stopGate = closing;

		const stopped = lifecycle.stop();
		const rebinding = nextBind();
		const restarted = lifecycle.start();
		let rebound = false;
		void rebinding.then(() => (rebound = true));
		await drain();
		expect(rebound).toBe(false);

		closing.open();
		await Promise.all([stopped, restarted]);

		expect(previous.bound).toBe(false);
		expect(h.listeners).toHaveLength(2);
		expect(lifecycle.listener()).toBe(h.listeners[1]);
	});

	it("records a failed bind and drops it on stop", async () => {
		const { h, lifecycle } = harness();
		h.configure = (l) =>
			(l.startFailure = Object.assign(new Error("listen EADDRINUSE"), {
				code: "EADDRINUSE",
			}));

		await lifecycle.start();

		expect(lifecycle.startError()).toEqual({
			code: "EADDRINUSE",
			message: "Another program holds 127.0.0.1:0.",
		});
		expect(lifecycle.isActive()).toBe(false);

		await lifecycle.stop();

		expect(lifecycle.startError()).toBeNull();
	});

	// `buildMcpStatus` derives `starting` from "no listener and no failure", so
	// that pair has to hold in every phase: both absent until the bind settles
	// (including before `start()` is ever called), then exactly one is present
	// (#3579).
	it("holds neither a listener nor a failure until the bind settles, then exactly one", async () => {
		const status = (lifecycle: McpLifecycle<FakeService>) =>
			buildMcpStatus({
				listener: lifecycle.listener(),
				enabled: true,
				error: lifecycle.startError(),
				corruptCopy: null,
				port: { configured: 0, inForce: 0, storedError: null },
			});

		const bound = harness();
		expect(status(bound.lifecycle).starting).toBe(true);
		const held = gate();
		bound.h.configure = (l) => (l.startGate = held);
		const binding = bound.nextBind();
		const starting = bound.lifecycle.start();
		await binding;
		expect(status(bound.lifecycle).starting).toBe(true);
		held.open();
		await starting;
		expect(status(bound.lifecycle)).toMatchObject({ running: true, starting: false });

		const failed = harness();
		failed.h.configure = (l) => (l.startFailure = new Error("listen EACCES"));
		await failed.lifecycle.start();
		const failure = status(failed.lifecycle);
		expect(failure.starting).toBe(false);
		expect(failure.error).toBeDefined();
	});

	it("does not record a bind failure for a start that was already stopped", async () => {
		const { h, lifecycle, nextBind } = harness();
		const held = gate();
		h.configure = (l) => {
			l.startGate = held;
			l.startFailure = new Error("listen EADDRINUSE");
		};
		const binding = nextBind();

		const starting = lifecycle.start();
		await binding;
		const stopped = lifecycle.stop();
		held.open();
		await Promise.all([starting, stopped]);

		expect(lifecycle.startError()).toBeNull();
	});

	it("serves requests from the service it publishes, and stops that service first", async () => {
		const { h, lifecycle } = harness();
		await lifecycle.start();
		const listener = h.listeners[0];

		const handle = await listener.loadHandler();
		await handle(request, response);

		const [service] = h.services;
		expect(lifecycle.service()).toBe(service);
		expect(service.handleRequest).toHaveBeenCalledWith(request, response);

		const order: string[] = [];
		service.stop.mockImplementation(async () => void order.push("service"));
		const closeListener = listener.stop.bind(listener);
		listener.stop = async () => {
			order.push("listener");
			await closeListener();
		};
		await lifecycle.stop();

		expect(order).toEqual(["service", "listener"]);
		expect(lifecycle.service()).toBeNull();
	});

	it("builds no service when a stop lands during the lazy load, even after a restart", async () => {
		const { h, lifecycle } = harness();
		await lifecycle.start();
		const loadGate = gate();
		h.loadGate = loadGate;

		const loading = h.listeners[0].loadHandler();
		await lifecycle.stop();
		await lifecycle.start();
		loadGate.open();

		await expect(loading).rejects.toThrow(/stopped before its service finished loading/);
		expect(h.services).toHaveLength(0);
		expect(lifecycle.service()).toBeNull();
		expect(lifecycle.listener()).toBe(h.listeners[1]);
	});

	it("puts a safety change made during the start in force once listening", async () => {
		const { h, lifecycle, nextBind } = harness();
		const held = gate();
		h.configure = (l) => (l.startGate = held);
		const binding = nextBind();

		const starting = lifecycle.start();
		await binding;
		changeSafety(lifecycle, h, { allowWrites: true });
		held.open();
		await starting;
		await h.listeners[0].loadHandler();

		expect(h.services[0].safety.allowWrites).toBe(true);
	});

	it("applies a safety change that lands right after the service is built to that service", async () => {
		const { h, lifecycle } = harness();
		await lifecycle.start();
		const applied = gate();
		h.afterConstruct = () => {
			changeSafety(lifecycle, h, { allowWrites: true });
			applied.open();
		};

		await h.listeners[0].loadHandler();
		await applied.promise;

		expect(lifecycle.service()?.safety.allowWrites).toBe(true);
	});
});

/*
 * #3580: the port is read at each start, and a restarted engine that now
 * guards another port takes the listener with it through `followEndpoint`.
 * Mutation check: make `followEndpoint` resolve without stopping, and the
 * "moves" cases red with the listener still on the old port.
 */
describe("createMcpLifecycle and the endpoint", () => {
	const at = (port: number): McpEndpoint => ({ host: "127.0.0.1", port });

	it("binds, and builds the service on, the port endpoint() names at the start", async () => {
		const { h, lifecycle } = harness();
		h.endpoint = () => at(19_877);

		await lifecycle.start();
		await h.listeners[0].loadHandler();

		expect(h.listeners[0].endpoint).toEqual(at(19_877));
		expect(h.services[0].endpoint).toEqual(at(19_877));
		expect(lifecycle.heldPort()).toBe(19_877);
	});

	it("names the configured port when its bind fails, and holds it as the failed one", async () => {
		const { h, lifecycle } = harness();
		h.endpoint = () => at(19_877);
		h.configure = (l) =>
			(l.startFailure = Object.assign(new Error("listen EADDRINUSE"), {
				code: "EADDRINUSE",
			}));

		await lifecycle.start();

		expect(lifecycle.startError()?.message).toBe("Another program holds 127.0.0.1:19877.");
		expect(lifecycle.heldPort()).toBe(19_877);
	});

	it("records an endpoint read that throws as a failed start on no port", async () => {
		const { h, lifecycle } = harness();
		h.endpoint = () => {
			throw new Error("store unreadable");
		};

		await expect(lifecycle.start()).resolves.toBeUndefined();

		expect(lifecycle.startError()?.code).toBe("other");
		expect(lifecycle.heldPort()).toBeNull();
	});

	it("leaves a listener alone while endpoint() still names its port", async () => {
		const { h, lifecycle } = harness();
		await lifecycle.start();

		await lifecycle.followEndpoint();

		expect(h.listeners).toHaveLength(1);
		expect(lifecycle.listener()).toBe(h.listeners[0]);
	});

	it("moves a listening server to the port endpoint() now names", async () => {
		const { h, lifecycle } = harness();
		h.endpoint = () => at(19_877);
		await lifecycle.start();
		const previous = h.listeners[0];

		h.endpoint = () => at(19_878);
		await lifecycle.followEndpoint();

		expect(previous.bound).toBe(false);
		expect(h.listeners).toHaveLength(2);
		expect(lifecycle.listener()).toBe(h.listeners[1]);
		expect(h.listeners[1].endpoint).toEqual(at(19_878));
	});

	it("tries a start that failed on the old port again on the new one", async () => {
		const { h, lifecycle } = harness();
		h.endpoint = () => at(19_877);
		h.configure = (l) => (l.startFailure = new Error("listen EACCES"));
		await lifecycle.start();
		h.configure = () => {};

		h.endpoint = () => at(19_878);
		await lifecycle.followEndpoint();

		expect(lifecycle.startError()).toBeNull();
		expect(lifecycle.heldPort()).toBe(19_878);
	});

	it("waits out a start in flight before deciding", async () => {
		const { h, lifecycle, nextBind } = harness();
		h.endpoint = () => at(19_877);
		const held = gate();
		h.configure = (l) => (l.startGate = held);
		const binding = nextBind();
		const starting = lifecycle.start();
		await binding;

		h.endpoint = () => at(19_878);
		const following = lifecycle.followEndpoint();
		h.configure = () => {};
		held.open();
		await Promise.all([starting, following]);

		expect(lifecycle.heldPort()).toBe(19_878);
		expect(h.listeners[0].bound).toBe(false);
	});

	it("binds nothing for a server that is off", async () => {
		const { h, lifecycle } = harness();
		h.endpoint = () => at(19_878);

		await lifecycle.followEndpoint();

		expect(h.listeners).toHaveLength(0);
		expect(lifecycle.isActive()).toBe(false);
	});

	it("leaves the last word to a stop that lands while it closes the old listener", async () => {
		const { h, lifecycle } = harness();
		h.endpoint = () => at(19_877);
		await lifecycle.start();
		const closing = gate();
		h.listeners[0].stopGate = closing;

		h.endpoint = () => at(19_878);
		const following = lifecycle.followEndpoint();
		const quit = lifecycle.stop();
		closing.open();
		await Promise.all([following, quit]);

		expect(h.listeners).toHaveLength(1);
		expect(lifecycle.isActive()).toBe(false);
	});

	it("moves a real listener between two free ports", async () => {
		const first = await freePort();
		const second = await freePort();
		let port = first;
		const lifecycle = createMcpLifecycle<FakeService>({
			isEnabled: () => true,
			endpoint: () => at(port),
			makeListener: (endpoint, loadHandler) => new McpListener({ ...endpoint, loadHandler }),
			loadServiceFactory: async () => (endpoint) =>
				new FakeService(DEFAULT_MCP_SAFETY_CONFIG, endpoint),
			log: () => {},
		});
		try {
			await lifecycle.start();
			expect(lifecycle.listener()?.url).toBe(`http://127.0.0.1:${first}/mcp`);

			port = second;
			await lifecycle.followEndpoint();

			expect(lifecycle.listener()?.url).toBe(`http://127.0.0.1:${second}/mcp`);
			expect(lifecycle.listener()?.isRunning()).toBe(true);
			// The old port was given back: something else can listen on it now.
			const probe = http.createServer();
			await new Promise<void>((resolve, reject) => {
				probe.once("error", reject);
				probe.listen(first, "127.0.0.1", resolve);
			});
			await new Promise((resolve) => probe.close(resolve));
		} finally {
			await lifecycle.stop();
		}
	});
});
