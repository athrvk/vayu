/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The engine the app talks to is the one it spawned this session.
 *
 * `start()` has two paths that find an engine already on the port - the lock
 * file and the health probe. An engine found running lacks this session's
 * grant secret, so both stop and replace it (#2356), and a quit landing during
 * the replacement still stops it (#270). A build for another version is
 * replaced the same way (#1492).
 *
 * The lifecycle is driven through a fake `SidecarSystem` rather than real
 * processes and ports: replacement, shutdown and the restart/quit race are
 * ownership logic, and the alternative is a spawned binary and a 45-second
 * health ceiling per assertion. The lock file, the data directory and the
 * binary lookup are real, against a temp directory - those are the parts a mock
 * would have "passed" against.
 *
 * The same harness covers the other end of `start()`: an engine that dies at
 * spawn. It must not poll a dead port for the full 45-second ceiling, so the
 * assertions there are about *when* the failure arrives and what it says, not
 * only that it arrives.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

/** Mutable because the mock is hoisted above the temp directory each test makes. */
const fake = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
	app: {
		getPath: () => fake.userData,
		getAppPath: () => fake.userData,
		getVersion: () => "0.0.0-test",
	},
}));

// Only `spawn`, so the default system's spawn options can be read; `execSync`
// stays real for the PID probes.
vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	spawn: vi.fn(),
}));

import { spawn } from "child_process";
import {
	EngineSidecar,
	EngineNotReadyError,
	EnginePortInUseError,
	defaultSidecarSystem,
	type SidecarSystem,
} from "./sidecar";
import {
	ENGINE_HEALTH_POLL_BUDGET_MS,
	ENGINE_HEALTH_POLL_INITIAL_INTERVAL_MS,
	ENGINE_HEALTH_POLL_MAX_INTERVAL_MS,
	ENGINE_GRANT_SECRET_ENV,
	ENGINE_LOCK_FILE,
	ENGINE_PORT_RELEASE_DELAY_MS,
	ENGINE_RESTART_BASE_DELAY_MS,
} from "./constants";

const TEST_PORT = 39876;
const ADOPTED_PID = 4242;

/** Just enough of a piped stdio stream for the sidecar's drain to attach to. */
class FakeStream extends EventEmitter {
	setEncoding() {}
	resume() {}
}

/** A spawned engine: enough of a ChildProcess for the sidecar to drive. */
class FakeChild extends EventEmitter {
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	readonly signals: string[] = [];

	/** A wedged engine: only SIGKILL gets it, which is what the grace period is for. */
	ignoresSigterm = false;

	kill(signal?: string) {
		const sent = signal ?? "SIGTERM";
		this.signals.push(sent);
		if (sent !== "SIGKILL" && this.ignoresSigterm) return true;
		this.exit();
		return true;
	}

	/**
	 * Deferred, because the sidecar attaches its handlers only after `spawnEngine`
	 * has returned - anything emitted synchronously inside the mock is emitted at
	 * nobody. A microtask lands after that and still before the first `await`.
	 */
	say(line: string) {
		queueMicrotask(() => this.stderr.emit("data", `${line}\n`));
	}

	exit(code: number | null = null, signal: string | null = null) {
		queueMicrotask(() => this.emit("exit", code, signal));
	}
}

/**
 * The stop path forks on the host platform - Windows has no SIGTERM to send, so
 * the HTTP shutdown is its only graceful route there. Both branches are driven
 * by stubbing the input rather than by trusting whichever CI runner shows up.
 */
function stubPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/**
 * A fake OS: which PIDs are alive, whether anything answers on the port, and
 * what got spawned. `sleep` resolves immediately - the waits under test are
 * ordering, not duration.
 */
function fakeSystem(overrides: Partial<SidecarSystem> = {}) {
	const state = {
		alivePids: new Set<number>(),
		healthy: false,
		spawned: [] as FakeChild[],
	};

	const system: SidecarSystem = {
		spawnEngine: vi.fn(() => {
			const child = new FakeChild();
			// The port is the engine's until it exits, as it is a real one's.
			child.once("exit", () => {
				state.healthy = false;
			});
			state.spawned.push(child);
			state.healthy = true;
			return child as unknown as ChildProcess;
		}),
		isEngineProcessAlive: vi.fn((pid: number) => state.alivePids.has(pid)),
		killEngineProcess: vi.fn((pid: number) => {
			const killed = state.alivePids.delete(pid);
			if (killed) state.healthy = false;
			return killed;
		}),
		probeHealth: vi.fn(async () => state.healthy),
		requestShutdown: vi.fn(async () => true),
		isPortFree: vi.fn(async () => !state.healthy),
		sleep: vi.fn(async () => {}),
		...overrides,
	};

	return { system, state };
}

/** An engine already up on the port, with the lock file the engine writes. */
function engineAlreadyRunning(state: { alivePids: Set<number>; healthy: boolean }) {
	state.alivePids.add(ADOPTED_PID);
	state.healthy = true;
	writeFileSync(join(fake.userData, ENGINE_LOCK_FILE), `${ADOPTED_PID}\n`);
}

beforeEach(() => {
	fake.userData = mkdtempSync(join(tmpdir(), "vayu-sidecar-"));
	// Production resolves the binary under process.resourcesPath, which exists
	// only inside a packaged Electron app - that is the path that ships, so it is
	// the path these drive.
	Object.defineProperty(process, "resourcesPath", {
		value: fake.userData,
		configurable: true,
	});
	mkdirSync(join(fake.userData, "bin"), { recursive: true });
	writeFileSync(join(fake.userData, "bin", "vayu-engine"), "");
	writeFileSync(join(fake.userData, "bin", "vayu-engine.exe"), "");
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	rmSync(fake.userData, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/**
 * The environment the engine was spawned with, by spawn. The fake's `spawnEngine`
 * records it as its third argument.
 */
function spawnedEnvs(system: SidecarSystem): NodeJS.ProcessEnv[] {
	return vi.mocked(system.spawnEngine).mock.calls.map(([, , env]) => env);
}

/** A running engine that leaves when `POST /shutdown` asks it to, as a real one does. */
function shutsDownWhenAsked(
	system: SidecarSystem,
	state: { alivePids: Set<number>; healthy: boolean }
) {
	vi.mocked(system.requestShutdown).mockImplementation(async () => {
		state.alivePids.delete(ADOPTED_PID);
		state.healthy = false;
		return true;
	});
}

/*
 * #2356: every write to file trust needs the grant secret the engine was
 * spawned with, and an engine already running was given another session's or
 * none. So an engine found at start is stopped and replaced, never adopted, on
 * every path that used to adopt one. Mutation check: let `start()` return after
 * a healthy engine is found (the old adoption) and each case here reds on
 * `spawnEngine` never being called.
 */
describe("EngineSidecar - an engine already running at start", () => {
	it("stops the engine the lock file points at and spawns its own", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		shutsDownWhenAsked(system, state);
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await sidecar.start();

		expect(system.requestShutdown).toHaveBeenCalledWith(TEST_PORT);
		expect(system.killEngineProcess).not.toHaveBeenCalled();
		expect(system.spawnEngine).toHaveBeenCalledOnce();
		expect(sidecar.isRunning()).toBe(true);
	});

	it("stops an engine answering on the port with no readable lock PID", async () => {
		const { system, state } = fakeSystem();
		state.healthy = true;
		shutsDownWhenAsked(system, state);
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await sidecar.start();

		expect(system.requestShutdown).toHaveBeenCalledWith(TEST_PORT);
		expect(system.spawnEngine).toHaveBeenCalledOnce();
		expect(sidecar.isRunning()).toBe(true);
	});

	it("force-kills one that ignores the shutdown request, then spawns", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await sidecar.start();

		// The HTTP request was accepted but the process stayed up - the PID kill
		// is what frees the port and the database lock for this session's engine.
		expect(system.requestShutdown).toHaveBeenCalledWith(TEST_PORT);
		expect(system.killEngineProcess).toHaveBeenCalledWith(ADOPTED_PID);
		expect(state.alivePids.has(ADOPTED_PID)).toBe(false);
		expect(system.spawnEngine).toHaveBeenCalledOnce();
	});

	// Issue #1905: a live lock PID that does not answer /health is an engine
	// that is hung or still starting, not "another application".
	describe("a live lock PID that does not answer /health", () => {
		/** Healthy only once this test's own engine has been spawned. */
		function answersOnlyAfterSpawn(state: { spawned: FakeChild[] }) {
			return vi.fn(async () => state.spawned.length > 0);
		}

		it("is waited for, then killed and replaced", async () => {
			const { system, state } = fakeSystem();
			engineAlreadyRunning(state);
			state.healthy = false;
			const probeHealth = answersOnlyAfterSpawn(state);
			system.probeHealth = probeHealth;
			const sidecar = new EngineSidecar([TEST_PORT], system);

			await sidecar.start();

			expect(system.killEngineProcess).toHaveBeenCalledWith(ADOPTED_PID);
			expect(system.spawnEngine).toHaveBeenCalledOnce();
			expect(sidecar.isRunning()).toBe(true);
			// The ramped budget was spent before the kill, not skipped.
			const sleeps = vi.mocked(system.sleep).mock.calls.map(([ms]) => ms);
			expect(sleeps).toContain(ENGINE_HEALTH_POLL_INITIAL_INTERVAL_MS);
			expect(sleeps).toContain(ENGINE_HEALTH_POLL_MAX_INTERVAL_MS);
			expect(sleeps).toContain(ENGINE_PORT_RELEASE_DELAY_MS);
		});

		it("is asked to shut down, not killed, when it answers late", async () => {
			const { system, state } = fakeSystem();
			engineAlreadyRunning(state);
			shutsDownWhenAsked(system, state);
			let probes = 0;
			system.probeHealth = vi.fn(async () => state.spawned.length > 0 || ++probes > 3);
			const sidecar = new EngineSidecar([TEST_PORT], system);

			await sidecar.start();

			expect(probes).toBe(4);
			expect(system.requestShutdown).toHaveBeenCalledWith(TEST_PORT);
			expect(system.killEngineProcess).not.toHaveBeenCalled();
			expect(system.spawnEngine).toHaveBeenCalledOnce();
			expect(sidecar.isRunning()).toBe(true);
		});
	});

	// The port-in-use error is for a port held by something that is not a
	// Vayu engine - the lock names nothing alive, or names nothing at all.
	it("reports a port held by another program when no lock names a live engine", async () => {
		const { system, state } = fakeSystem();
		system.isPortFree = vi.fn(async () => false);
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await expect(sidecar.start()).rejects.toThrow(EnginePortInUseError);
		await expect(sidecar.start()).rejects.toThrow(
			`Another program is using port ${TEST_PORT}. Quit it and press Retry.`
		);
		expect(system.spawnEngine).not.toHaveBeenCalled();
		expect(state.spawned).toHaveLength(0);
	});

	it("reports a port held by another program when the lock PID is dead", async () => {
		const { system } = fakeSystem();
		writeFileSync(join(fake.userData, ENGINE_LOCK_FILE), `${ADOPTED_PID}\n`);
		system.isPortFree = vi.fn(async () => false);
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await expect(sidecar.start()).rejects.toThrow(EnginePortInUseError);
		expect(system.spawnEngine).not.toHaveBeenCalled();
	});

	it("reports the port held when the engine it stopped has not let go of it", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		shutsDownWhenAsked(system, state);
		system.isPortFree = vi.fn(async () => false);
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await expect(sidecar.start()).rejects.toThrow(EnginePortInUseError);
		expect(system.spawnEngine).not.toHaveBeenCalled();
		expect(sidecar.isRunning()).toBe(false);
	});

	it("leaves no stale lock behind once a restart has spawned its own engine", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		shutsDownWhenAsked(system, state);
		const sidecar = new EngineSidecar([TEST_PORT], system);
		await sidecar.start();

		await sidecar.restart(0);

		expect(system.spawnEngine).toHaveBeenCalledTimes(2);
		expect(sidecar.isRunning()).toBe(true);
		// The lock of the engine stopped at start must not survive into ours.
		expect(existsSync(join(fake.userData, ENGINE_LOCK_FILE))).toBe(false);
	});

	it("reports failure when the restarted engine never becomes healthy", async () => {
		const { system, state } = fakeSystem();
		const sidecar = new EngineSidecar([TEST_PORT], system);
		await sidecar.start();
		// From here on it spawns, but never answers /health.
		vi.mocked(system.spawnEngine).mockImplementation(() => {
			const child = new FakeChild();
			state.spawned.push(child);
			return child as unknown as ChildProcess;
		});

		const failure = await sidecar.restart(1).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		const { message, cause } = failure as Error;
		// Two attempts (one retry); the message quotes the last one's failure.
		expect(cause).toBeInstanceOf(Error);
		expect(message).toBe(
			`Nothing answered after 2 attempts (${(cause as Error).message}). Quit Vayu and open it again.`
		);
		expect((cause as Error).message).not.toBe("");
		expect(message).not.toMatch(/please/i);
	});
});

/*
 * #2356: the grant secret reaches the engine in its environment and nowhere
 * else, and this process learns it from the spawn that minted it.
 */
describe("EngineSidecar - the grant secret", () => {
	it("spawns the engine with a fresh secret in its environment and none in its arguments", async () => {
		const { system } = fakeSystem();
		const onGrantSecret = vi.fn();
		const sidecar = new EngineSidecar([TEST_PORT], system, () => {}, onGrantSecret);

		await sidecar.start();

		const [[, args, env]] = vi.mocked(system.spawnEngine).mock.calls;
		const secret = env[ENGINE_GRANT_SECRET_ENV] ?? "";
		// 32 random bytes as hex; the engine ignores anything under 32 characters.
		expect(secret).toMatch(/^[0-9a-f]{64}$/);
		expect(args.join(" ")).not.toContain(secret);
		expect(onGrantSecret.mock.calls).toEqual([[secret]]);
	});

	it("keeps the rest of this process's environment", async () => {
		vi.stubEnv("VAYU_SIDECAR_TEST_MARKER", "kept");
		const { system } = fakeSystem();

		await new EngineSidecar([TEST_PORT], system).start();

		expect(spawnedEnvs(system)[0]?.VAYU_SIDECAR_TEST_MARKER).toBe("kept");
		vi.unstubAllEnvs();
	});

	it("mints a different secret for every spawn, a restart included", async () => {
		const { system } = fakeSystem();
		const onGrantSecret = vi.fn();
		const sidecar = new EngineSidecar([TEST_PORT], system, () => {}, onGrantSecret);

		await sidecar.start();
		await sidecar.restart(0);

		const secrets = spawnedEnvs(system).map((env) => env[ENGINE_GRANT_SECRET_ENV]);
		expect(secrets).toHaveLength(2);
		expect(secrets[0]).not.toBe(secrets[1]);
		expect(onGrantSecret.mock.calls).toEqual(secrets.map((secret) => [secret]));
	});

	it("reaches the real spawn as the child's environment", () => {
		const env = { [ENGINE_GRANT_SECRET_ENV]: "s".repeat(64) };

		defaultSidecarSystem.spawnEngine("/opt/vayu-engine", ["--port", "1"], env);

		expect(vi.mocked(spawn)).toHaveBeenCalledWith(
			"/opt/vayu-engine",
			["--port", "1"],
			expect.objectContaining({ env })
		);
	});

	it("is never written to this process's own environment", async () => {
		const { system } = fakeSystem();

		await new EngineSidecar([TEST_PORT], system).start();

		expect(process.env[ENGINE_GRANT_SECRET_ENV]).toBeUndefined();
	});
});

/*
 * #2118: another program on the default port used to end the launch. The
 * sidecar now walks a candidate list, and the port it settles on is fixed for
 * its lifetime because the renderer is told it once.
 */
describe("EngineSidecar - choosing a port", () => {
	const FALLBACK = TEST_PORT + 4;
	const CANDIDATES = [TEST_PORT, FALLBACK, FALLBACK + 1];

	/**
	 * Ports as the OS sees them: `foreign` are held by a program that is not a
	 * Vayu engine, `vayu` answer /health. A spawned engine takes the port its
	 * `--port` names and lets it go when it exits.
	 */
	function ports(
		system: SidecarSystem,
		state: { spawned: FakeChild[] },
		{ foreign = [], vayu = [] }: { foreign?: number[]; vayu?: number[] }
	) {
		const answering = new Set(vayu);
		const held = new Set([...foreign, ...vayu]);
		system.probeHealth = vi.fn(async (port: number) => answering.has(port));
		system.isPortFree = vi.fn(async (port: number) => !held.has(port));
		system.spawnEngine = vi.fn((_binary: string, args: string[]) => {
			const port = Number(args[args.indexOf("--port") + 1]);
			const child = new FakeChild();
			child.once("exit", () => {
				answering.delete(port);
				held.delete(port);
			});
			state.spawned.push(child);
			answering.add(port);
			held.add(port);
			return child as unknown as ChildProcess;
		});
		return { held };
	}

	function spawnedPorts(system: SidecarSystem): number[] {
		return vi
			.mocked(system.spawnEngine)
			.mock.calls.map(([, args]) => Number(args[args.indexOf("--port") + 1]));
	}

	it("runs the engine on the next candidate when another program holds the first", async () => {
		const { system, state } = fakeSystem();
		ports(system, state, { foreign: [TEST_PORT] });
		const onPortFixed = vi.fn();
		const sidecar = new EngineSidecar(CANDIDATES, system, onPortFixed);

		await sidecar.start();

		expect(spawnedPorts(system)).toEqual([FALLBACK]);
		expect(sidecar.getApiUrl()).toBe(`http://127.0.0.1:${FALLBACK}`);
		expect(onPortFixed.mock.calls).toEqual([[FALLBACK]]);
	});

	/** The engine on `port` leaves when asked, freeing the port and its PID. */
	function leavesWhenAsked(
		system: SidecarSystem,
		state: { alivePids: Set<number> },
		held: Set<number>,
		port: number
	) {
		system.requestShutdown = vi.fn(async (asked: number) => {
			if (asked !== port) return false;
			held.delete(port);
			state.alivePids.delete(ADOPTED_PID);
			return true;
		});
	}

	it("replaces a Vayu engine on a fallback port there, rather than moving", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		const { held } = ports(system, state, { foreign: [TEST_PORT], vayu: [FALLBACK] });
		leavesWhenAsked(system, state, held, FALLBACK);
		const onPortFixed = vi.fn();
		const sidecar = new EngineSidecar(CANDIDATES, system, onPortFixed);

		await sidecar.start();

		expect(system.requestShutdown).toHaveBeenCalledWith(FALLBACK);
		expect(spawnedPorts(system)).toEqual([FALLBACK]);
		expect(onPortFixed.mock.calls).toEqual([[FALLBACK]]);
	});

	// Mutation check: walk the candidates in order for a live lock too, and the
	// free default is taken, the orphan waited out there for the whole budget and
	// killed rather than asked to leave.
	it("replaces a crash orphan on its fallback port even once the default is free", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		const { held } = ports(system, state, { vayu: [FALLBACK] });
		leavesWhenAsked(system, state, held, FALLBACK);
		const sidecar = new EngineSidecar(CANDIDATES, system);

		await sidecar.start();

		expect(system.killEngineProcess).not.toHaveBeenCalled();
		expect(spawnedPorts(system)).toEqual([FALLBACK]);
		expect(sidecar.getApiUrl()).toBe(`http://127.0.0.1:${FALLBACK}`);
	});

	it("names the first port when every candidate is held, and fixes that one", async () => {
		const { system, state } = fakeSystem();
		ports(system, state, { foreign: CANDIDATES });
		const onPortFixed = vi.fn();
		const sidecar = new EngineSidecar(CANDIDATES, system, onPortFixed);

		const failure = await sidecar.start().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(EnginePortInUseError);
		expect((failure as Error).message).toBe(
			`Another program is using port ${TEST_PORT}, and the fallback ports are held too. Free port ${TEST_PORT} and press Retry.`
		);
		expect(system.spawnEngine).not.toHaveBeenCalled();
		expect(onPortFixed.mock.calls).toEqual([[TEST_PORT]]);
	});

	it("keeps the port it settled on across a restart, even once the default frees up", async () => {
		const { system, state } = fakeSystem();
		const { held } = ports(system, state, { foreign: [TEST_PORT] });
		const onPortFixed = vi.fn();
		const sidecar = new EngineSidecar(CANDIDATES, system, onPortFixed);
		await sidecar.start();
		held.delete(TEST_PORT);

		await sidecar.restart(0);

		expect(spawnedPorts(system)).toEqual([FALLBACK, FALLBACK]);
		expect(onPortFixed).toHaveBeenCalledOnce();
	});

	it("retries only the port it named, without a timer, and spawns there once it is free", async () => {
		const { system, state } = fakeSystem();
		const { held } = ports(system, state, { foreign: CANDIDATES });
		const sidecar = new EngineSidecar(CANDIDATES, system);
		await expect(sidecar.start()).rejects.toBeInstanceOf(EnginePortInUseError);

		// A fallback coming free is no help: the renderer was told the first.
		held.delete(FALLBACK);
		const retry = await sidecar.restart().catch((error: unknown) => error);
		// Thrown as written, not wrapped in the restart's generic sentence, and
		// not retried on the backoff timer.
		expect(retry).toBeInstanceOf(EnginePortInUseError);
		expect((retry as Error).message).toBe(
			`Another program is using port ${TEST_PORT}. Quit it and press Retry.`
		);
		const sleeps = vi.mocked(system.sleep).mock.calls.map(([ms]) => ms);
		expect(sleeps).not.toContain(ENGINE_RESTART_BASE_DELAY_MS);

		held.delete(TEST_PORT);
		await sidecar.restart(0);
		expect(spawnedPorts(system)).toEqual([TEST_PORT]);
	});

	it("refuses an empty candidate list", () => {
		const { system } = fakeSystem();
		expect(() => new EngineSidecar([], system)).toThrow(/at least one candidate/);
	});
});

describe("EngineSidecar - spawned engine", () => {
	const realPlatform = process.platform;
	afterEach(() => stubPlatform(realPlatform));

	it("spawns when nothing is on the port", async () => {
		const { system } = fakeSystem();
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await sidecar.start();

		expect(system.spawnEngine).toHaveBeenCalledOnce();
		expect(vi.mocked(system.spawnEngine).mock.calls[0][1]).toContain(String(TEST_PORT));
		expect(sidecar.isRunning()).toBe(true);
	});

	/*
	 * #1558: the engine's own `engine_<stamp>.log` is the record now, so the
	 * app no longer needs the engine's console text at `-v 1` in production -
	 * only dev, where a developer is watching a terminal, keeps `2`. `isDev`
	 * is read once at module load, so this pins the mapping against whatever
	 * `NODE_ENV` this test run actually has rather than asserting a literal
	 * that would silently stop testing anything under a different one.
	 */
	it("passes --verbose 0 outside development, 2 in it", async () => {
		const { system } = fakeSystem();
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await sidecar.start();

		const args = vi.mocked(system.spawnEngine).mock.calls[0][1];
		const verboseAt = args.indexOf("--verbose");
		expect(verboseAt).toBeGreaterThan(-1);
		expect(args[verboseAt + 1]).toBe(process.env.NODE_ENV === "development" ? "2" : "0");
	});

	it("stops what it spawned with SIGTERM off Windows", async () => {
		stubPlatform("linux");
		const { system, state } = fakeSystem();
		const sidecar = new EngineSidecar([TEST_PORT], system);
		await sidecar.start();

		await sidecar.stop();

		expect(state.spawned[0].signals).toContain("SIGTERM");
		expect(sidecar.isRunning()).toBe(false);
	});

	it("stops what it spawned on Windows, where the HTTP shutdown is the only graceful path", async () => {
		stubPlatform("win32");
		const { system, state } = fakeSystem();
		// A real engine exits once it has accepted POST /shutdown.
		(system.requestShutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			state.spawned[0]?.exit();
			state.healthy = false;
			return true;
		});
		const sidecar = new EngineSidecar([TEST_PORT], system);
		await sidecar.start();

		await sidecar.stop();

		// SIGTERM is not a request on Windows, it is an immediate kill - so the
		// stop path must not reach for one, and must not sit out the grace period
		// waiting for an engine that already left.
		expect(state.spawned[0].signals).toEqual([]);
		expect(sidecar.isRunning()).toBe(false);
	});

	it("force-kills a spawned engine that ignores the graceful shutdown", async () => {
		stubPlatform("linux");
		const { system, state } = fakeSystem();
		const sidecar = new EngineSidecar([TEST_PORT], system);
		await sidecar.start();
		state.spawned[0].ignoresSigterm = true;

		await sidecar.stop();

		expect(state.spawned[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(sidecar.isRunning()).toBe(false);
	});
});

describe("EngineSidecar - an engine that dies at spawn", () => {
	/** Spawns a child that leaves the way `die` says, instead of coming up. */
	function spawnsAndDies(
		state: { spawned: FakeChild[] },
		system: SidecarSystem,
		die: (child: FakeChild) => void
	) {
		(system.spawnEngine as ReturnType<typeof vi.fn>).mockImplementation(() => {
			const child = new FakeChild();
			state.spawned.push(child);
			die(child);
			return child as unknown as ChildProcess;
		});
	}

	it("fails at the exit instead of polling out the 45-second ceiling", async () => {
		const { system, state } = fakeSystem();
		// The outcome sidecar.ts calls expected: the engine could not take its own
		// lock, so it is gone milliseconds after the spawn.
		spawnsAndDies(state, system, (child) => child.exit(3, null));
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await expect(sidecar.start()).rejects.toThrow(/exit code 3/);

		// The point of the fix, and what a revert breaks: without consulting the
		// child, the loop runs all 90 attempts before saying anything - 45 real
		// seconds with no window on screen. Two probes are the pre-spawn adoption
		// check and the loop's first pass.
		expect(vi.mocked(system.probeHealth).mock.calls.length).toBeLessThanOrEqual(3);
		expect(sidecar.isRunning()).toBe(false);
	});

	it("names the signal and the engine's last words", async () => {
		const { system, state } = fakeSystem();
		spawnsAndDies(state, system, (child) => {
			child.say("error while loading shared libraries: libssl.so.3");
			child.exit(null, "SIGABRT");
		});
		const sidecar = new EngineSidecar([TEST_PORT], system);

		// The stderr line is the whole diagnosis; an exit status alone sends the
		// user to the logs for it.
		await expect(sidecar.start()).rejects.toThrow(/libssl\.so\.3/);
		await expect(sidecar.start()).rejects.toThrow(/signal SIGABRT/);
	});

	// #1558: the stderr tail is still collected for the failure message above -
	// that assertion reds on its own if the collection ever breaks - but the
	// line itself must not also be re-printed; the engine's own file is that
	// record now. Mutation check: restore the `console.error` call this issue
	// removed from the stderr `"data"` handler and this reds.
	it("drains stdout and stderr without printing either", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { system, state } = fakeSystem();
		const sidecar = new EngineSidecar([TEST_PORT], system);
		await sidecar.start();

		state.spawned[0].stdout.emit("data", "engine startup line\n");
		state.spawned[0].stderr.emit("data", "a debug line\n");

		expect(log).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		log.mockRestore();
		error.mockRestore();
	});

	it("reports a spawn that never produced a process at all", async () => {
		const { system, state } = fakeSystem();
		spawnsAndDies(state, system, (child) => {
			queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
		});
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await expect(sidecar.start()).rejects.toThrow(/EACCES/);
		expect(sidecar.isRunning()).toBe(false);
	});

	it("still waits out the ceiling for an engine that is merely slow", async () => {
		const { system, state } = fakeSystem();
		// Spawns, stays alive, never answers: the loop has nothing to shortcut on
		// and must not mistake "not ready yet" for "dead".
		spawnsAndDies(state, system, () => {});
		const sidecar = new EngineSidecar([TEST_PORT], system);

		await expect(sidecar.start()).rejects.toThrow(EngineNotReadyError);
		// The early exit must not have shortened the wait for a live engine.
		expect(vi.mocked(system.probeHealth).mock.calls.length).toBeGreaterThan(50);
	});

	it("separates a slow engine from a dead one by error type, not by message", async () => {
		// The launch path branches on this distinction to decide whether to quit,
		// so the two failures must not be one type: a dead engine is fatal, a slow
		// one is the renderer's problem and the app stays up (see main.ts).
		const slow = fakeSystem();
		spawnsAndDies(slow.state, slow.system, () => {});
		await expect(new EngineSidecar([TEST_PORT], slow.system).start()).rejects.toBeInstanceOf(
			EngineNotReadyError
		);

		const dead = fakeSystem();
		spawnsAndDies(dead.state, dead.system, (child) => {
			queueMicrotask(() => child.emit("exit", 127, null));
		});
		await expect(
			new EngineSidecar([TEST_PORT], dead.system).start()
		).rejects.not.toBeInstanceOf(EngineNotReadyError);
	});

	it("ramps the health poll so a fast engine is not held for a full quantum", async () => {
		const { system, state } = fakeSystem();
		spawnsAndDies(state, system, () => {});
		// The engine comes up during the first gap between probes. The probe
		// before it cannot succeed - nothing is listening microseconds after
		// spawn() returns - which is exactly why a flat interval made its own
		// length the floor on every healthy launch.
		vi.mocked(system.sleep).mockImplementation(async () => {
			state.healthy = true;
		});

		await new EngineSidecar([TEST_PORT], system).start();

		// The one sleep it paid is the ramp's first step, not the 500ms ceiling.
		// Revert the ramp and this reads 500.
		expect(vi.mocked(system.sleep).mock.calls).toEqual([
			[ENGINE_HEALTH_POLL_INITIAL_INTERVAL_MS],
		]);
		expect(ENGINE_HEALTH_POLL_INITIAL_INTERVAL_MS).toBeLessThan(
			ENGINE_HEALTH_POLL_MAX_INTERVAL_MS
		);
	});

	it("doubles the poll interval up to the ceiling and spends the whole budget", async () => {
		const { system, state } = fakeSystem();
		spawnsAndDies(state, system, () => {});

		await expect(new EngineSidecar([TEST_PORT], system).start()).rejects.toBeInstanceOf(
			EngineNotReadyError
		);

		const slept = vi.mocked(system.sleep).mock.calls.map(([ms]) => ms as number);
		expect(slept.slice(0, 4)).toEqual([50, 100, 200, 400]);
		expect(slept.every((ms) => ms <= ENGINE_HEALTH_POLL_MAX_INTERVAL_MS)).toBe(true);
		expect(slept[slept.length - 1]).toBe(ENGINE_HEALTH_POLL_MAX_INTERVAL_MS);
		// The ceiling the engine's own startup housekeeping is priced against is
		// unchanged by the ramp: it is a budget of waiting, not an attempt count.
		const total = slept.reduce((sum, ms) => sum + ms, 0);
		expect(total).toBeGreaterThanOrEqual(ENGINE_HEALTH_POLL_BUDGET_MS);
		expect(total).toBeLessThan(
			ENGINE_HEALTH_POLL_BUDGET_MS + ENGINE_HEALTH_POLL_MAX_INTERVAL_MS
		);
	});
});

describe("EngineSidecar - the missing-binary message", () => {
	function removeBinaries() {
		for (const name of ["vayu-engine", "vayu-engine.exe"]) {
			rmSync(join(fake.userData, "bin", name), { force: true });
		}
	}

	it("points at the build entry point that exists", async () => {
		const { system } = fakeSystem();
		removeBinaries();
		const sidecar = new EngineSidecar([TEST_PORT], system);

		// Read exactly once by a user, at the moment nothing works, so every line
		// of it has to lead somewhere real.
		await expect(sidecar.start()).rejects.toThrow(/python build\.py -e/);
		await expect(sidecar.start()).rejects.toThrow(/docs\/building\.md/);
		expect(system.spawnEngine).not.toHaveBeenCalled();
	});

	it("leaves no reference to the build-script directory the repo does not have", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const sources = readdirSync(here, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
			// This file spells the dead path in the assertion below, so scanning it
			// would flag the guard itself.
			.filter((entry) => entry.name !== "sidecar.test.ts")
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));

		// Without this the scan below passes on an empty list - the failure mode
		// CLAUDE.md records a source guard sitting in for weeks.
		expect(sources.length).toBeGreaterThan(10);
		expect(sources.join("").length).toBeGreaterThan(10_000);

		const deadPath = ["scripts", "build", ""].join("/");
		expect(sources.filter((source) => source.includes(deadPath))).toEqual([]);
	});
});

describe("EngineSidecar - restart racing quit", () => {
	it("does not spawn an engine when quit lands in the stop-to-spawn gap", async () => {
		const { system } = fakeSystem();
		const sidecar = new EngineSidecar([TEST_PORT], system);
		await sidecar.start();

		// The port-release pause is the gap: the old engine is down and the new one
		// is not spawned yet. A quit arriving here used to leave a fresh engine
		// nothing would ever kill.
		let quitting: Promise<void> | null = null;
		vi.mocked(system.sleep).mockImplementation(async (ms: number) => {
			if (ms === ENGINE_PORT_RELEASE_DELAY_MS && !quitting) {
				quitting = sidecar.shutdown();
			}
		});

		await expect(sidecar.restart(0)).rejects.toThrow(/shutting down/i);
		await quitting;

		// The first start's spawn, and nothing after it.
		expect(system.spawnEngine).toHaveBeenCalledOnce();
		expect(sidecar.isRunning()).toBe(false);
	});

	it("refuses to restart once the app is shutting down", async () => {
		const { system } = fakeSystem();
		const sidecar = new EngineSidecar([TEST_PORT], system);
		await sidecar.start();

		await sidecar.shutdown();

		await expect(sidecar.restart(0)).rejects.toThrow(/shutting down/i);
		expect(system.spawnEngine).toHaveBeenCalledOnce();
	});
});

/*
 * #2153: `{"status":"ok"}` is what any service's health route says. The
 * default probes read real sockets, because the fakes above would "pass" a
 * probe that trusts `status` alone.
 */
describe("defaultSidecarSystem - recognising a Vayu engine", () => {
	const VAYU_HEALTH = { status: "ok", version: "0.0.0-test", workers: 8 };
	const servers: Server[] = [];

	/** A listener on a free loopback port answering `GET /health` with `body`. */
	async function serveHealth(body: unknown): Promise<number> {
		const server = createServer((_request, response) => {
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(body));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		return (server.address() as AddressInfo).port;
	}

	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
		);
	});

	it.each([
		["status alone", { status: "ok" }],
		["no workers", { status: "ok", version: "0.0.0-test" }],
		["no version", { status: "ok", workers: 8 }],
		["a numeric version", { status: "ok", version: 1, workers: 8 }],
		["a string workers", { status: "ok", version: "0.0.0-test", workers: "8" }],
		["a status other than ok", { ...VAYU_HEALTH, status: "starting" }],
	])("does not take a reply with %s for an engine", async (_name, body) => {
		const port = await serveHealth(body);

		expect(await defaultSidecarSystem.probeHealth(port)).toBe(false);
	});

	it("takes status, a string version and a numeric workers for an engine", async () => {
		const port = await serveHealth(VAYU_HEALTH);

		expect(await defaultSidecarSystem.probeHealth(port)).toBe(true);
	});

	it("skips a marker-less listener as held and replaces the Vayu engine on the next candidate", async () => {
		const foreignPort = await serveHealth({ status: "ok" });
		const enginePort = await serveHealth(VAYU_HEALTH);
		const engineServer = servers[servers.length - 1];
		const { system, state } = fakeSystem({
			// The real probe until this test's own engine exists, which has no
			// socket to answer on.
			probeHealth: async (port: number) =>
				state.spawned.length > 0 || (await defaultSidecarSystem.probeHealth(port)),
			isPortFree: defaultSidecarSystem.isPortFree,
			requestShutdown: vi.fn(async () => {
				engineServer.closeAllConnections();
				await new Promise((resolve) => engineServer.close(resolve));
				return true;
			}),
		});
		const sidecar = new EngineSidecar([foreignPort, enginePort], system);

		await sidecar.start();

		expect(sidecar.getApiUrl()).toBe(`http://127.0.0.1:${enginePort}`);
		expect(vi.mocked(system.requestShutdown).mock.calls).toEqual([[enginePort]]);
		expect(system.spawnEngine).toHaveBeenCalledOnce();
	});

	it("never shuts down a marker-less listener, even when it is the only candidate", async () => {
		const foreignPort = await serveHealth({ status: "ok" });
		const { system } = fakeSystem({
			probeHealth: defaultSidecarSystem.probeHealth,
			isPortFree: defaultSidecarSystem.isPortFree,
		});
		const sidecar = new EngineSidecar([foreignPort], system);

		await expect(sidecar.start()).rejects.toBeInstanceOf(EnginePortInUseError);

		expect(system.requestShutdown).not.toHaveBeenCalled();
		expect(system.spawnEngine).not.toHaveBeenCalled();
	});
});
