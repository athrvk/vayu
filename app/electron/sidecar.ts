/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file sidecar.ts
 * @brief Manages the C++ engine sidecar process lifecycle
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import net from "net";
import {
	ENGINE_PORT,
	ENGINE_LOCK_FILE,
	ENGINE_HEALTH_POLL_BUDGET_MS,
	ENGINE_HEALTH_POLL_INITIAL_INTERVAL_MS,
	ENGINE_HEALTH_POLL_MAX_INTERVAL_MS,
	ENGINE_HEALTH_REQUEST_TIMEOUT_MS,
	ENGINE_SHUTDOWN_REQUEST_TIMEOUT_MS,
	ENGINE_GRACEFUL_EXIT_TIMEOUT_MS,
	ENGINE_EXIT_POLL_INTERVAL_MS,
	ENGINE_RESTART_MAX_RETRIES,
	ENGINE_RESTART_BASE_DELAY_MS,
	ENGINE_PORT_RELEASE_DELAY_MS,
	ENGINE_STDERR_TAIL_LINES,
} from "./constants.js";

const isDev = process.env.NODE_ENV === "development";

/**
 * The directory the engine keeps its state in - logs, database and lock file.
 *
 * Production:
 *   - macOS: ~/Library/Application Support/vayu-client
 *   - Windows: %APPDATA%/vayu-client
 *   - Linux: ~/.config/vayu-client
 * Development: <repo>/engine/data
 *
 * Module-level rather than a method because callers outside the sidecar need it
 * when there is no sidecar instance to ask: `app:getPaths` answers Settings
 * whether or not the engine came up. It used to re-derive this inline, so a
 * change here silently showed the user the old directory.
 */
export function engineDataDirectory(): string {
	if (isDev) {
		// In development, use a local directory in the engine folder
		return path.join(app.getAppPath(), "..", "engine", "data");
	}
	// In production, use the app's userData directory
	// app.getPath("userData") returns platform-specific paths
	return app.getPath("userData");
}

/**
 * Check if a port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close();
			resolve(true);
		});
		server.listen(port, "127.0.0.1");
	});
}

/**
 * Check if our engine is already running on a port
 */
async function isEngineRunning(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(ENGINE_HEALTH_REQUEST_TIMEOUT_MS),
		});
		const data = await response.json();
		return data?.status === "ok";
	} catch {
		return false;
	}
}

/**
 * Ask the engine to shut itself down over HTTP.
 *
 * The engine answers the POST before it stops, so a `true` here means the
 * request was accepted, never that the process is gone - the caller still has
 * to watch for the exit.
 */
async function requestEngineShutdown(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/shutdown`, {
			method: "POST",
			signal: AbortSignal.timeout(ENGINE_SHUTDOWN_REQUEST_TIMEOUT_MS),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * A number we are willing to hand to `process.kill`.
 *
 * The PID comes out of a lock file on disk, so it is whatever that file says.
 * Zero and negatives are not PIDs: `process.kill` reads them as *process
 * group* targets on Unix, so a truncated or garbled lock file would aim the
 * probe - and, through `killVayuEngineProcess`, a SIGKILL - at this app's own
 * process group.
 */
function isPlausiblePid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 0;
}

/**
 * Does *anything* hold this PID?
 *
 * Signal 0 delivers nothing - it is an existence-and-permission probe, and
 * libuv implements it on Windows too (`OpenProcess` plus an exit-code check, so
 * a process that has terminated while someone still holds a handle to it
 * reports `ESRCH` rather than "alive"). That makes it the cheap first half of
 * the question on every platform, which matters because the dominant case at
 * startup is a leftover lock file naming a PID that is long gone: the engine
 * only releases its lock on a clean shutdown and never unlinks the file, so
 * every ordinary boot asks about a dead PID. Windows used to answer that by
 * spawning cmd.exe + tasklist - 52.5 ms median, measured, on the main-process
 * event loop, every launch.
 *
 * `EPERM` is alive-but-not-ours: something is running under that PID, and the
 * name check is what decides whether it is our engine.
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Does the OS agree that this live PID is a vayu-engine?
 *
 * The subprocess half, and the only half that costs anything - reached only
 * once something is known to be alive under the PID. Failure to read the name
 * is not evidence of an engine, so it answers no.
 */
function isEngineProcessName(pid: number): boolean {
	try {
		if (process.platform === "win32") {
			// Format: "vayu-engine.exe","12345","Console","1","12,345 K" - and
			// "INFO: No tasks are running..." when the PID filter matches nothing,
			// which fails the same name test.
			const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
				encoding: "utf-8",
				windowsHide: true,
			});
			return output.toLowerCase().includes("vayu-engine.exe");
		}

		return execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8" }).includes("vayu-engine");
	} catch {
		return false;
	}
}

/**
 * Check if a process is still running by PID and verify it's vayu-engine
 *
 * Cheap first, subprocess second: a PID nothing holds is answered by the signal-0
 * probe alone, and only a live PID is worth paying a `tasklist` / `ps` for. The
 * name check is not optional politeness - it prevents PID reuse issues where a
 * different process might have reused the same PID that was previously held by
 * vayu-engine.
 */
function isVayuEngineRunning(pid: number): boolean {
	if (!isPlausiblePid(pid)) return false;
	if (!isPidAlive(pid)) return false;
	return isEngineProcessName(pid);
}

/**
 * Force-kill a vayu-engine process by PID.
 *
 * Name-verified first, for the same reason `isVayuEngineRunning` verifies: the
 * PID comes from a lock file written by a process that may be long gone, and
 * killing whatever inherited that PID would be far worse than leaving an engine
 * running. Returns whether a kill was actually issued.
 */
function killVayuEngineProcess(pid: number): boolean {
	if (!isVayuEngineRunning(pid)) {
		return false;
	}

	try {
		if (process.platform === "win32") {
			execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore", windowsHide: true });
		} else {
			process.kill(pid, "SIGKILL");
		}
		return true;
	} catch (err) {
		console.warn(`[Sidecar] Failed to kill engine process ${pid}: ${err}`);
		return false;
	}
}

/**
 * Read PID from lock file
 */
function readPidFromLock(lockPath: string): number | null {
	try {
		if (!fs.existsSync(lockPath)) {
			return null;
		}

		const content = fs.readFileSync(lockPath, "utf-8").trim();
		const pid = parseInt(content, 10);
		if (isNaN(pid)) {
			return null;
		}
		return pid;
	} catch {
		return null;
	}
}

/**
 * Check lock file and verify if the vayu-engine process is still running
 * Returns true if lock file exists and vayu-engine process is running, false otherwise
 *
 * This verifies both that the PID exists AND that it belongs to vayu-engine,
 * preventing false positives from PID reuse.
 */
function checkLockFile(
	lockPath: string,
	isAlive: (pid: number) => boolean
): {
	locked: boolean;
	pid: number | null;
	running: boolean;
} {
	const pid = readPidFromLock(lockPath);
	if (pid === null) {
		return { locked: false, pid: null, running: false };
	}

	return { locked: true, pid, running: isAlive(pid) };
}

/**
 * The OS- and network-facing half of the sidecar.
 *
 * Everything here talks to a real process, a real port or a real clock, which
 * is exactly what a test cannot have: adoption, shutdown and the restart/quit
 * race are all *ownership* logic, and driving them through real engines would
 * mean 45-second health waits and a spawned binary per assertion. Production
 * passes `defaultSidecarSystem`, which is the code that used to be inline.
 */
export interface SidecarSystem {
	/** Spawn the engine binary. Stdio is piped; the caller drains it. */
	spawnEngine(binaryPath: string, args: string[]): ChildProcess;
	/** Is this PID alive *and* still vayu-engine? (PID reuse is real.) */
	isEngineProcessAlive(pid: number): boolean;
	/** Force-kill a name-verified engine PID. Returns whether a kill was issued. */
	killEngineProcess(pid: number): boolean;
	/** Does an engine answer `/health` with `status: ok` on this port? */
	probeHealth(port: number): Promise<boolean>;
	/** `POST /shutdown`. True means accepted, not that the process has gone. */
	requestShutdown(port: number): Promise<boolean>;
	/** Can we bind this port, i.e. is nothing at all listening? */
	isPortFree(port: number): Promise<boolean>;
	sleep(ms: number): Promise<void>;
}

export const defaultSidecarSystem: SidecarSystem = {
	spawnEngine: (binaryPath, args) =>
		spawn(binaryPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		}),
	isEngineProcessAlive: isVayuEngineRunning,
	killEngineProcess: killVayuEngineProcess,
	probeHealth: isEngineRunning,
	requestShutdown: requestEngineShutdown,
	isPortFree: isPortAvailable,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * How this instance came to be attached to the engine it is talking to.
 *
 * `spawned` is the ordinary case. `adopted` is an engine that was already up on
 * the port when we started - after the single-instance lock in main.ts, that
 * can only be an orphan of a crashed session (or, in development, an engine
 * started by hand), never a second Vayu. Either way this instance owns it: it
 * is stopped on quit and really restarted on request, which is what the three
 * defects in issue #270 were about. Every method that used to key off
 * `this.process` alone reported "no engine" for an adopted one and quietly did
 * nothing.
 */
type Ownership =
	| { kind: "none" }
	| { kind: "spawned" }
	/** `pid` is null when the engine answered health but wrote no readable lock. */
	| { kind: "adopted"; pid: number | null };

/**
 * Why a spawned engine is never going to answer.
 *
 * Recorded by the child's `exit` and `error` handlers so `waitForEngine` can
 * stop polling a port nothing is listening on. The loop used to consult only
 * the health probe, so an engine that died at spawn - a missing shared library,
 * a corrupt binary, a lock it could not take - still cost the full 45-second
 * ceiling, and with no window on screen yet the user watched nothing happen for
 * all of it.
 */
type SpawnFailure =
	| { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stderr: string[] }
	| { kind: "error"; message: string };

/**
 * Raised when the readiness budget is spent but the engine is still alive.
 *
 * Distinct from every other start failure because it is the one that is not a
 * failure of the engine: a large run history, a cold disk or an antivirus scan
 * can push `db.init()` past the budget on a machine where the engine then comes
 * up perfectly well. The launch path treats it as "not yet", not as "never" -
 * quitting here killed engines that were seconds from answering.
 */
export class EngineNotReadyError extends Error {
	constructor(budgetMs: number) {
		super(`Engine did not answer /health within ${budgetMs / 1000} seconds`);
		this.name = "EngineNotReadyError";
	}
}

/** The user-facing half of a `SpawnFailure`; ends up in a `showErrorBox`. */
function describeSpawnFailure(failure: SpawnFailure): string {
	if (failure.kind === "error") {
		return `The engine process could not be started: ${failure.message}`;
	}

	// A signal means something killed it; a code means it decided to leave. Only
	// one of the two is ever set, and naming the wrong one reads as a crash that
	// did not happen.
	const cause =
		failure.signal !== null
			? `killed by signal ${failure.signal}`
			: `exit code ${failure.code}`;
	const tail =
		failure.stderr.length > 0 ? `\n\nLast engine output:\n${failure.stderr.join("\n")}` : "";

	return `The engine exited before it was ready (${cause}).${tail}`;
}

export class EngineSidecar {
	private process: ChildProcess | null = null;
	private ownership: Ownership = { kind: "none" };
	private port: number;
	private dataDir: string;
	private binaryPath: string;
	private system: SidecarSystem;
	/**
	 * Set once the app is on its way out. Read at every point in `start()` and
	 * `restart()` that could otherwise spawn - a spawn that lands after the quit
	 * path has taken its last look at the sidecar is a process nothing kills.
	 */
	private stopping = false;
	/** A restart in progress, so the quit path can wait it out rather than race it. */
	private restartInFlight: Promise<void> | null = null;

	constructor(port: number = ENGINE_PORT, system: SidecarSystem = defaultSidecarSystem) {
		this.port = port;
		this.system = system;
		this.dataDir = engineDataDirectory();
		this.binaryPath = this.getEngineBinaryPath();
	}

	/** Where this engine keeps its state. See `engineDataDirectory()`. */
	getDataDirectory(): string {
		return this.dataDir;
	}

	/**
	 * Get the lock file path
	 * This should match the path used by the engine: {dataDir}/vayu.lock
	 */
	private getLockFilePath(): string {
		return path.join(this.dataDir, ENGINE_LOCK_FILE);
	}

	/**
	 * Get the path to the vayu-engine binary
	 * Development:
	 *   - All platforms: ../engine/build/vayu-engine[.exe]
	 *   - Legacy Windows multi-config layout: ../engine/build/Debug/vayu-engine.exe
	 * Production:
	 *   - macOS: Contents/Resources/bin/vayu-engine
	 *   - Windows: resources/bin/vayu-engine.exe
	 *   - Linux: resources/bin/vayu-engine
	 */
	private getEngineBinaryPath(): string {
		const isWindows = process.platform === "win32";
		const binaryName = isWindows ? "vayu-engine.exe" : "vayu-engine";

		if (isDev) {
			// Every dev preset now uses the Ninja generator, which is single-config
			// and writes straight into build/. Older Windows trees configured with
			// the Visual Studio generator nest the binary under build/Debug/, so
			// fall back to that rather than failing on a stale build directory.
			const buildDir = path.join(app.getAppPath(), "..", "engine", "build");
			const candidates = [
				path.join(buildDir, binaryName),
				path.join(buildDir, "Debug", binaryName),
			];
			return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
		} else {
			// In production, the binary is in resources/bin
			// process.resourcesPath points to the Resources directory
			const prodBinaryPath = path.join(process.resourcesPath, "bin", binaryName);
			return prodBinaryPath;
		}
	}

	/**
	 * Ensure the data directory exists
	 */
	private ensureDataDirectory(): void {
		if (!fs.existsSync(this.dataDir)) {
			fs.mkdirSync(this.dataDir, { recursive: true });
			console.log(`[Sidecar] Created data directory: ${this.dataDir}`);
		}
	}

	/**
	 * Start the engine process
	 */
	async start(): Promise<void> {
		if (this.ownership.kind !== "none") {
			console.log("[Sidecar] Engine already running (managed by this instance)");
			return;
		}

		// Ensure data directory exists first
		this.ensureDataDirectory();

		// Check lock file to see if engine is already running
		const lockPath = this.getLockFilePath();
		const lockStatus = checkLockFile(lockPath, this.system.isEngineProcessAlive);

		if (lockStatus.locked) {
			if (lockStatus.running && lockStatus.pid !== null) {
				console.log(
					`[Sidecar] Lock file found with PID ${lockStatus.pid}, process is running`
				);
				// Verify engine is actually responding on the port
				if (await this.system.probeHealth(this.port)) {
					console.log(
						`[Sidecar] Adopting the engine already running on port ${this.port} (PID ${lockStatus.pid})`
					);
					this.ownership = { kind: "adopted", pid: lockStatus.pid };
					return;
				} else {
					console.warn(
						`[Sidecar] Lock file indicates process ${lockStatus.pid} is running, but engine is not responding on port ${this.port}`
					);
					// Process might be stuck, but we'll let the engine's lock mechanism handle it
					// The engine will fail to start if it can't acquire the lock
				}
			} else if (lockStatus.pid !== null) {
				// Lock file exists but process is not running - stale lock file
				console.warn(
					`[Sidecar] Stale lock file found (PID ${lockStatus.pid} not running), cleaning up...`
				);
				// Clean up stale lock file to prevent issues during install/reinstall
				try {
					fs.unlinkSync(lockPath);
					console.log(`[Sidecar] Removed stale lock file: ${lockPath}`);
				} catch (err) {
					console.warn(`[Sidecar] Failed to remove stale lock file: ${err}`);
					// Continue anyway - the engine's lock mechanism will handle it
				}
			}
		}

		// Check if engine is already running on this port (from previous session or
		// crash). No lock file to read a PID from, so ownership is by port only -
		// stop() falls back to watching health for the exit.
		if (await this.system.probeHealth(this.port)) {
			console.log(
				`[Sidecar] Adopting the engine already running on port ${this.port} (no lock PID)`
			);
			this.ownership = { kind: "adopted", pid: readPidFromLock(lockPath) };
			return;
		}

		// Check if port is in use by something else
		if (!(await this.system.isPortFree(this.port))) {
			throw new Error(
				`[Sidecar] Port ${this.port} is already in use by another application.`
			);
		}

		// Check if binary exists. The remediation names `build.py` because that is
		// the repo's single build entry point - the per-platform shell scripts this
		// message used to name have never existed, and the raw cmake line it
		// offered skips the vcpkg toolchain wiring build.py does for you.
		if (!fs.existsSync(this.binaryPath)) {
			throw new Error(
				`Engine binary not found at: ${this.binaryPath}\n\n` +
					`From a source checkout, build it with:\n` +
					`  python build.py -e\n\n` +
					`If this is an installed copy of Vayu, the installation is incomplete - ` +
					`reinstall it. Prerequisites and platform notes are in docs/building.md.`
			);
		}

		console.log(`[Sidecar] Starting engine...`);
		console.log(`[Sidecar]   Binary: ${this.binaryPath}`);
		console.log(`[Sidecar]   Data Dir: ${this.dataDir}`);
		console.log(`[Sidecar]   Port: ${this.port}`);

		// Last look before the spawn, with no `await` between the two: from here
		// on the child is tracked, so the quit path can kill it. Every check
		// earlier than this one has an await after it, which is a window a quit
		// can land in - and a child spawned into that window is an orphan.
		this.assertNotStopping();

		// Spawn the engine process
		this.process = this.system.spawnEngine(this.binaryPath, [
			"--port",
			this.port.toString(),
			"--data-dir",
			this.dataDir,
			"--verbose",
			`${isDev ? "2" : "1"}`,
		]);
		this.ownership = { kind: "spawned" };

		// Handle stdout - set up listeners immediately to prevent buffering issues
		// On Linux, if pipes aren't read, the process can block waiting for buffer space
		if (this.process.stdout) {
			this.process.stdout.setEncoding("utf8");
			this.process.stdout.on("data", (data) => {
				const lines = data
					.toString()
					.split("\n")
					.filter((line: string) => line.trim());
				for (const line of lines) {
					console.log(`[Engine] ${line}`);
				}
			});
			// Resume reading to prevent backpressure
			this.process.stdout.resume();
		}

		// Kept for the failure message: an engine that dies at spawn has usually
		// said why on stderr, and that line is the difference between "exit code 127"
		// and "cannot open shared object file".
		const stderrTail: string[] = [];

		// Handle stderr - set up listeners immediately to prevent buffering issues
		if (this.process.stderr) {
			this.process.stderr.setEncoding("utf8");
			this.process.stderr.on("data", (data) => {
				const lines = data
					.toString()
					.split("\n")
					.filter((line: string) => line.trim());
				for (const line of lines) {
					console.error(`[Engine] ${line}`);
					stderrTail.push(line);
					if (stderrTail.length > ENGINE_STDERR_TAIL_LINES) stderrTail.shift();
				}
			});
			// Resume reading to prevent backpressure
			this.process.stderr.resume();
		}

		// Forget the child only while it is still the current one: a restart's
		// replacement is already spawned by the time a slow `exit` can land, and
		// clearing then would drop the handle to a live engine.
		const child = this.process;
		const forget = () => {
			if (this.process !== child) return;
			this.process = null;
			if (this.ownership.kind === "spawned") {
				this.ownership = { kind: "none" };
			}
		};

		// Scoped to this spawn rather than to the instance: a restart's replacement
		// is a different child, and its wait must not inherit the reason the
		// previous one died.
		let failure: SpawnFailure | null = null;

		// Handle process exit
		child.on("exit", (code, signal) => {
			console.log(`[Sidecar] Engine exited with code ${code} signal ${signal}`);
			failure = { kind: "exit", code, signal, stderr: [...stderrTail] };
			forget();
		});

		// Handle errors
		child.on("error", (err) => {
			console.error(`[Sidecar] Engine error:`, err);
			failure = { kind: "error", message: err.message };
			forget();
		});

		// Wait for the engine to be ready
		await this.waitForEngine(() => failure);
	}

	/**
	 * Wait for the engine to be ready by polling the health endpoint.
	 *
	 * `spawnFailure` reports what the child we just spawned did instead of coming
	 * up, and is the loop's early exit: polling out the remaining attempts against
	 * a process that has already gone only delays the error the user needs.
	 *
	 * The gap between probes ramps rather than sitting flat, because the first
	 * probe cannot succeed - nothing is listening microseconds after `spawn()`
	 * returns - so a flat interval made its own length the floor on every healthy
	 * launch. Spending the budget as `ENGINE_HEALTH_POLL_BUDGET_MS` of accumulated
	 * waiting rather than as a fixed attempt count keeps that ceiling exactly
	 * where the engine's own startup housekeeping is priced against it, while
	 * letting the early attempts be cheap.
	 *
	 * Throws `EngineNotReadyError` when the budget is spent and the child is
	 * still alive; the caller decides what a slow engine costs.
	 */
	private async waitForEngine(spawnFailure: () => SpawnFailure | null): Promise<void> {
		let waited = 0;
		let interval = ENGINE_HEALTH_POLL_INITIAL_INTERVAL_MS;

		for (;;) {
			// A quit arriving mid-startup must not be held for the rest of the
			// ceiling: the child is already tracked, so the quit path kills it and
			// this loop's only remaining job is to stop waiting.
			this.assertNotStopping();

			// Before the probe, not after: by the time control is back here the
			// child's exit handler has already run, and one more health request to a
			// closed port would answer no faster than the record already has.
			const died = spawnFailure();
			if (died) {
				throw new Error(describeSpawnFailure(died));
			}

			if (await this.system.probeHealth(this.port)) {
				console.log(`[Sidecar] Engine is ready`);
				return;
			}

			if (waited >= ENGINE_HEALTH_POLL_BUDGET_MS) {
				throw new EngineNotReadyError(ENGINE_HEALTH_POLL_BUDGET_MS);
			}

			await this.system.sleep(interval);
			waited += interval;
			interval = Math.min(interval * 2, ENGINE_HEALTH_POLL_MAX_INTERVAL_MS);
		}
	}

	/** Throw if the app is shutting down, so no caller spawns into a quit. */
	private assertNotStopping(): void {
		if (this.stopping) {
			throw new Error("Engine start aborted: the app is shutting down");
		}
	}

	/**
	 * Stop the engine this instance is attached to - spawned or adopted.
	 *
	 * An adopted engine is not our child, so there is no `exit` event to wait on
	 * and `kill()` on a handle we do not have is not available either: it is
	 * asked over HTTP, watched by PID (or by health, when no lock PID was
	 * readable), and force-killed by PID if it outlives the grace period.
	 */
	async stop(): Promise<void> {
		const owned = this.ownership;
		if (owned.kind === "none") {
			console.log("[Sidecar] Engine not running");
			return;
		}

		console.log("[Sidecar] Stopping engine...");

		// Try graceful HTTP shutdown first (works reliably on all platforms)
		console.log("[Sidecar] Requesting graceful shutdown via HTTP...");
		if (await this.system.requestShutdown(this.port)) {
			console.log("[Sidecar] Shutdown request accepted");
		} else {
			console.log("[Sidecar] HTTP shutdown request failed, will use signal");
		}

		if (owned.kind === "adopted") {
			await this.stopAdopted(owned.pid);
			return;
		}

		await this.stopSpawned();
	}

	/** Wait out (and if necessary kill) the child this instance spawned. */
	private async stopSpawned(): Promise<void> {
		const child = this.process;
		if (!child) {
			this.ownership = { kind: "none" };
			return;
		}

		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});

		// Send SIGTERM as fallback (works on Unix, immediate termination on Windows)
		// On Windows, the HTTP shutdown should have already initiated graceful shutdown
		if (process.platform !== "win32") {
			child.kill("SIGTERM");
		}

		// Give the process a grace period to exit before force-killing. Through
		// the system seam, so this is one wait a test can make instant rather than
		// a real five seconds - on Windows there is no SIGTERM to shortcut it.
		const exitedInTime = await Promise.race([
			exited.then(() => true),
			this.system.sleep(ENGINE_GRACEFUL_EXIT_TIMEOUT_MS).then(() => false),
		]);

		if (!exitedInTime) {
			console.log("[Sidecar] Engine did not exit gracefully, killing...");
			child.kill("SIGKILL");
			await exited;
		}

		if (this.process === child) this.process = null;
		this.ownership = { kind: "none" };
		console.log("[Sidecar] Engine stopped");
	}

	/**
	 * Wait out (and if necessary kill) an engine this instance adopted.
	 *
	 * The lock file is re-read when adoption produced no PID: the engine writes
	 * it at startup, so a health-only adoption early in its life can still learn
	 * the PID by the time we come to stop it.
	 */
	private async stopAdopted(adoptedPid: number | null): Promise<void> {
		const lockPath = this.getLockFilePath();
		const pid = adoptedPid ?? readPidFromLock(lockPath);

		const gone = await this.waitForAdoptedExit(pid);

		if (!gone && pid !== null) {
			console.log(
				`[Sidecar] Adopted engine (PID ${pid}) did not exit gracefully, killing...`
			);
			if (this.system.killEngineProcess(pid)) {
				await this.waitForAdoptedExit(pid);
			}
		}

		// Ownership is released either way: a survivor we could not kill is not
		// ours to keep claiming, and saying otherwise would make `isRunning()`
		// lie in the other direction.
		this.ownership = { kind: "none" };
		console.log(
			gone ? "[Sidecar] Adopted engine stopped" : "[Sidecar] Adopted engine released"
		);
	}

	/**
	 * Poll until the adopted engine is gone or the grace period expires.
	 *
	 * By PID when we have one - a healthy `/health` answer would keep reporting
	 * "alive" for a *replacement* engine on the same port, and a dead one for an
	 * engine still writing its final flush. Health is only the fallback.
	 */
	private async waitForAdoptedExit(pid: number | null): Promise<boolean> {
		const deadline = ENGINE_GRACEFUL_EXIT_TIMEOUT_MS;
		for (let waited = 0; waited < deadline; waited += ENGINE_EXIT_POLL_INTERVAL_MS) {
			await this.system.sleep(ENGINE_EXIT_POLL_INTERVAL_MS);
			const alive =
				pid !== null
					? this.system.isEngineProcessAlive(pid)
					: await this.system.probeHealth(this.port);
			if (!alive) return true;
		}
		return false;
	}

	/**
	 * Get the engine API URL
	 */
	getApiUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/**
	 * Whether the engine this app is using is alive - however we came by it.
	 *
	 * This used to read `this.process !== null`, which is false for every
	 * adopted engine, so a perfectly healthy backend reported "not running" and
	 * the quit path skipped shutting it down.
	 */
	isRunning(): boolean {
		return this.ownership.kind !== "none";
	}

	/**
	 * Restart the engine process with retry logic and exponential backoff.
	 *
	 * The promise is kept on the instance so `shutdown()` can wait it out: a
	 * restart's stop-then-spawn has a gap, and a quit landing inside it used to
	 * leave a fresh engine nothing would ever kill.
	 */
	async restart(maxRetries: number = ENGINE_RESTART_MAX_RETRIES): Promise<void> {
		const run = this.runRestart(maxRetries);
		// Swallowed separately from the caller's copy: the quit path only needs to
		// know the restart is over, not whether it worked.
		const inFlight = run.then(
			() => undefined,
			() => undefined
		);
		this.restartInFlight = inFlight;
		try {
			await run;
		} finally {
			// Only clear our own: an overlapping restart owns the field now, and
			// dropping its promise would let a quit stop waiting for a live one.
			if (this.restartInFlight === inFlight) this.restartInFlight = null;
		}
	}

	private async runRestart(maxRetries: number): Promise<void> {
		console.log("[Sidecar] Restarting engine...");

		let lastError: Error | null = null;
		const baseDelay = ENGINE_RESTART_BASE_DELAY_MS;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				// Checked per attempt, not once up front: a quit can arrive between
				// two retries just as easily as before the first.
				this.assertNotStopping();

				if (attempt > 0) {
					// Calculate exponential delay: baseDelay * 2^(attempt-1)
					const delay = baseDelay * Math.pow(2, attempt - 1);
					console.log(
						`[Sidecar] Retry attempt ${attempt}/${maxRetries} after ${delay}ms delay...`
					);
					await this.system.sleep(delay);
				}

				await this.stop();
				// Small delay to ensure port is released
				await this.system.sleep(ENGINE_PORT_RELEASE_DELAY_MS);
				await this.start();
				console.log("[Sidecar] Engine restarted successfully");
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				console.error(
					`[Sidecar] Restart attempt ${attempt + 1}/${maxRetries + 1} failed:`,
					lastError.message
				);

				// A shutdown is not a failed restart to retry - the engine is meant
				// to be down, and retrying would spawn the orphan we just avoided.
				if (this.stopping) {
					throw lastError;
				}

				// If this was the last attempt, throw the error
				if (attempt === maxRetries) {
					throw new Error(`Please close the Application and reopen it.`);
				}
			}
		}
	}

	/**
	 * Stop the engine for good, on the way out of the app.
	 *
	 * Distinct from `stop()` because quit is one-way: further restarts are
	 * refused from here on, and a restart already in flight is waited out rather
	 * than raced, so the engine cannot be spawned again behind the shutdown.
	 */
	async shutdown(): Promise<void> {
		this.stopping = true;
		const inFlight = this.restartInFlight;
		if (inFlight) {
			console.log("[Sidecar] Waiting for the in-flight restart before shutting down...");
			await inFlight;
		}
		await this.stop();
	}
}
