/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An engine the app did not spawn is still the app's engine.
 *
 * `start()` has two paths that attach to an engine already on the port - the
 * lock file and the health probe - and both used to return with `this.process`
 * still null, while every other method keyed off exactly that. So a healthy
 * adopted engine reported `isRunning() === false`, `stop()` returned early and
 * left it running past quit (re-adopted, and orphaned again, on every launch),
 * and `restart()` "restarted" it by stopping nothing, waiting 500ms and
 * re-adopting the same process - reporting success, so Settings cleared its
 * restart-required banner while the config change never took effect.
 *
 * The lifecycle is driven through a fake `SidecarSystem` rather than real
 * processes and ports: adoption, shutdown and the restart/quit race are
 * ownership logic, and the alternative is a spawned binary and a 45-second
 * health ceiling per assertion. The lock file, the data directory and the
 * binary lookup are real, against a temp directory - those are the parts a mock
 * would have "passed" against.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { EngineSidecar, type SidecarSystem } from "./sidecar";
import { ENGINE_LOCK_FILE, ENGINE_PORT_RELEASE_DELAY_MS } from "./constants";

const TEST_PORT = 39876;
const ADOPTED_PID = 4242;

/** A spawned engine: enough of a ChildProcess for the sidecar to drive. */
class FakeChild extends EventEmitter {
	readonly stdout = null;
	readonly stderr = null;
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

	exit() {
		queueMicrotask(() => this.emit("exit", null, null));
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

describe("EngineSidecar - adoption", () => {
	it("adopts the engine the lock file points at, and knows it is running", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		const sidecar = new EngineSidecar(TEST_PORT, system);

		await sidecar.start();

		expect(system.spawnEngine).not.toHaveBeenCalled();
		expect(sidecar.isRunning()).toBe(true);
	});

	it("adopts an engine answering on the port with no readable lock PID", async () => {
		const { system, state } = fakeSystem();
		state.healthy = true;
		const sidecar = new EngineSidecar(TEST_PORT, system);

		await sidecar.start();

		expect(system.spawnEngine).not.toHaveBeenCalled();
		expect(sidecar.isRunning()).toBe(true);
	});

	it("stops an adopted engine on quit, force-killing one that ignores the request", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		const sidecar = new EngineSidecar(TEST_PORT, system);
		await sidecar.start();

		await sidecar.stop();

		expect(system.requestShutdown).toHaveBeenCalledWith(TEST_PORT);
		// The HTTP request was accepted but the process stayed up - the PID kill
		// is what makes "zero engines left behind" true rather than hopeful.
		expect(system.killEngineProcess).toHaveBeenCalledWith(ADOPTED_PID);
		expect(state.alivePids.has(ADOPTED_PID)).toBe(false);
		expect(sidecar.isRunning()).toBe(false);
	});

	it("does not kill an adopted engine that shuts down when asked", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		(system.requestShutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			state.alivePids.delete(ADOPTED_PID);
			state.healthy = false;
			return true;
		});
		const sidecar = new EngineSidecar(TEST_PORT, system);
		await sidecar.start();

		await sidecar.stop();

		expect(system.killEngineProcess).not.toHaveBeenCalled();
		expect(sidecar.isRunning()).toBe(false);
	});

	it("really restarts an adopted engine instead of re-adopting it", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		(system.requestShutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			state.alivePids.delete(ADOPTED_PID);
			state.healthy = false;
			return true;
		});
		const sidecar = new EngineSidecar(TEST_PORT, system);
		await sidecar.start();

		await sidecar.restart(0);

		// A spawn, not a 500ms pause and the same process again: this is what makes
		// the Settings restart-required banner tell the truth.
		expect(system.spawnEngine).toHaveBeenCalledOnce();
		expect(state.spawned).toHaveLength(1);
		expect(sidecar.isRunning()).toBe(true);
		// The stale lock of the engine we stopped must not survive into the new one.
		expect(existsSync(join(fake.userData, ENGINE_LOCK_FILE))).toBe(false);
	});

	it("reports failure when the restarted engine never becomes healthy", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		(system.requestShutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			state.alivePids.delete(ADOPTED_PID);
			state.healthy = false;
			return true;
		});
		// Spawns, but never answers /health.
		(system.spawnEngine as ReturnType<typeof vi.fn>).mockImplementation(() => {
			const child = new FakeChild();
			state.spawned.push(child);
			return child as unknown as ChildProcess;
		});
		const sidecar = new EngineSidecar(TEST_PORT, system);
		await sidecar.start();

		await expect(sidecar.restart(0)).rejects.toThrow(/close the Application/i);
	});
});

describe("EngineSidecar - spawned engine", () => {
	const realPlatform = process.platform;
	afterEach(() => stubPlatform(realPlatform));

	it("spawns when nothing is on the port", async () => {
		const { system } = fakeSystem();
		const sidecar = new EngineSidecar(TEST_PORT, system);

		await sidecar.start();

		expect(system.spawnEngine).toHaveBeenCalledOnce();
		expect(vi.mocked(system.spawnEngine).mock.calls[0][1]).toContain(String(TEST_PORT));
		expect(sidecar.isRunning()).toBe(true);
	});

	it("stops what it spawned with SIGTERM off Windows", async () => {
		stubPlatform("linux");
		const { system, state } = fakeSystem();
		const sidecar = new EngineSidecar(TEST_PORT, system);
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
		const sidecar = new EngineSidecar(TEST_PORT, system);
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
		const sidecar = new EngineSidecar(TEST_PORT, system);
		await sidecar.start();
		state.spawned[0].ignoresSigterm = true;

		await sidecar.stop();

		expect(state.spawned[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(sidecar.isRunning()).toBe(false);
	});
});

describe("EngineSidecar - restart racing quit", () => {
	it("does not spawn an engine when quit lands in the stop-to-spawn gap", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		(system.requestShutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			state.alivePids.delete(ADOPTED_PID);
			state.healthy = false;
			return true;
		});
		const sidecar = new EngineSidecar(TEST_PORT, system);
		await sidecar.start();

		// The port-release pause is the gap: the old engine is down and the new one
		// is not spawned yet. A quit arriving here used to leave a fresh engine
		// nothing would ever kill.
		let quitting: Promise<void> | null = null;
		(system.sleep as ReturnType<typeof vi.fn>).mockImplementation(async (ms: number) => {
			if (ms === ENGINE_PORT_RELEASE_DELAY_MS && !quitting) {
				quitting = sidecar.shutdown();
			}
		});

		await expect(sidecar.restart(0)).rejects.toThrow(/shutting down/i);
		await quitting;

		expect(system.spawnEngine).not.toHaveBeenCalled();
		expect(sidecar.isRunning()).toBe(false);
	});

	it("refuses to restart once the app is shutting down", async () => {
		const { system, state } = fakeSystem();
		engineAlreadyRunning(state);
		const sidecar = new EngineSidecar(TEST_PORT, system);
		await sidecar.start();

		await sidecar.shutdown();

		await expect(sidecar.restart(0)).rejects.toThrow(/shutting down/i);
		expect(system.spawnEngine).not.toHaveBeenCalled();
	});
});
