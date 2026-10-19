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
import { randomBytes } from "crypto";
import { app } from "electron";
import path from "path";
import fs from "fs";
import net from "net";
import {
	ENGINE_PORT_CANDIDATES,
	ENGINE_LOCK_FILE,
	ENGINE_GRANT_SECRET_BYTES,
	ENGINE_GRANT_SECRET_ENV,
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
import { isDevelopmentBuild } from "./dev-mode.js";
import { appLogger } from "./app-log.js";

/**
 * The directory the engine keeps its state in - logs, database and lock file.
 *
 * Production:
 *   - macOS: ~/Library/Application Support/Vayu
 *   - Windows: %APPDATA%/Vayu
 *   - Linux: ~/.config/Vayu
 * Development: <repo>/engine/data
 *
 * Module-level rather than a method because callers outside the sidecar need it
 * when there is no sidecar instance to ask: `app:getPaths` answers Settings
 * whether or not the engine came up. It used to re-derive this inline, so a
 * change here silently showed the user the old directory.
 */
export function engineDataDirectory(): string {
	if (isDevelopmentBuild()) {
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

/** `GET /health`'s body, or null on any transport, timeout or parse failure. */
async function fetchHealth(
	port: number
): Promise<{ status?: unknown; version?: unknown; workers?: unknown } | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(ENGINE_HEALTH_REQUEST_TIMEOUT_MS),
		});
		return await response.json();
	} catch {
		return null;
	}
}

/**
 * Does a Vayu engine answer on this port (#2153)? `status: "ok"` alone is what
 * any service's health route says, and a positive answer here stops whatever
 * answered with `POST /shutdown`, to replace it with this session's engine. The
 * engine's `/health` also carries a string `version` and a numeric `workers`;
 * a reply without both is another program, treated as a held port.
 */
async function isEngineRunning(port: number): Promise<boolean> {
	const data = await fetchHealth(port);
	return (
		data?.status === "ok" &&
		typeof data.version === "string" &&
		typeof data.workers === "number"
	);
}

/**
 * A fresh grant secret (#2356): what a write to file trust must present, and
 * only the engine spawned with it and this process ever hold it.
 */
function newGrantSecret(): string {
	return randomBytes(ENGINE_GRANT_SECRET_BYTES).toString("hex");
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
 * Can we rule out this PID without spawning anything?
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
 * Only `ESRCH` is proof, and the asymmetry is deliberate. Every other failure
 * means we could not tell - `EPERM` for a process we may not signal, and on
 * Windows an `OpenProcess` denial that libuv reports as `EACCES` rather than
 * `EPERM`, since it comes back through the generic Win32 error translation.
 * Reading "could not tell" as "gone" would let a *running* engine be declared
 * stale, its lock deleted underneath it; so an unclear answer costs a
 * subprocess and lets the name check decide, which is what the old
 * tasklist-only Windows path did in every case.
 */
function isPidCertainlyDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ESRCH";
	}
}

/**
 * What holds a lock file's PID, as far as the OS will say.
 *
 * `not-engine` is proof: nothing holds the PID, or the name read back is not
 * vayu-engine. `unknown` is a live PID whose name could not be read (`ps`
 * missing from a minimal container, `tasklist` failing), and it is neither
 * answer (#2422): read as `not-engine` it deleted a live engine's lock, and
 * read as `engine` it would aim the force-kill at whatever inherited a
 * recycled PID.
 */
type EngineProcessState = "engine" | "not-engine" | "unknown";

/**
 * Does the OS agree that this live PID is a vayu-engine?
 *
 * The subprocess half, and the only half that costs anything - reached only
 * once something is known to be alive under the PID.
 */
function classifyLiveProcess(pid: number): EngineProcessState {
	try {
		if (process.platform === "win32") {
			// Format: "vayu-engine.exe","12345","Console","1","12,345 K" - and
			// "INFO: No tasks are running..." when the PID filter matches nothing,
			// which fails the same name test.
			const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
				encoding: "utf-8",
				windowsHide: true,
			});
			return output.toLowerCase().includes("vayu-engine.exe") ? "engine" : "not-engine";
		}

		const name = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8" });
		return name.includes("vayu-engine") ? "engine" : "not-engine";
	} catch {
		return "unknown";
	}
}

/**
 * Is this PID a running vayu-engine?
 *
 * Cheap first, subprocess second: a PID nothing holds is answered by the signal-0
 * probe alone, and only a live PID is worth paying a `tasklist` / `ps` for. The
 * name check is not optional politeness - it prevents PID reuse issues where a
 * different process might have reused the same PID that was previously held by
 * vayu-engine.
 */
function engineProcessState(pid: number): EngineProcessState {
	if (!isPlausiblePid(pid)) return "not-engine";
	if (isPidCertainlyDead(pid)) return "not-engine";
	return classifyLiveProcess(pid);
}

/**
 * Force-kill a vayu-engine process by PID.
 *
 * Name-verified first, for the same reason `engineProcessState` verifies: the
 * PID comes from a lock file written by a process that may be long gone, and
 * killing whatever inherited that PID would be far worse than leaving an engine
 * running. So only a confirmed engine is killed, never an `unknown` one.
 * Returns whether a kill was actually issued.
 */
function killVayuEngineProcess(pid: number): boolean {
	if (engineProcessState(pid) !== "engine") {
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
		appLogger().warn("sidecar", `Failed to kill engine process ${pid}`, { error: String(err) });
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
 * Read the lock file's PID and classify what holds it; null when there is no
 * readable PID. `classify` checks the name as well as the PID, so a recycled
 * PID is not mistaken for the engine.
 */
function checkLockFile(
	lockPath: string,
	classify: (pid: number) => EngineProcessState
): { pid: number; state: EngineProcessState } | null {
	const pid = readPidFromLock(lockPath);
	return pid === null ? null : { pid, state: classify(pid) };
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
	/**
	 * Spawn the engine binary with `env` as its whole environment. Stdio is
	 * piped; the caller drains it. The grant secret travels in `env` and never
	 * in `args`, which any process listing shows.
	 */
	spawnEngine(binaryPath: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess;
	/** Is this PID alive *and* still vayu-engine? (PID reuse is real.) */
	engineProcessState(pid: number): EngineProcessState;
	/** Force-kill a name-verified engine PID. Returns whether a kill was issued. */
	killEngineProcess(pid: number): boolean;
	/** Does a Vayu engine answer `/health` on this port: `status: ok` plus its `version` and `workers`? */
	probeHealth(port: number): Promise<boolean>;
	/** `POST /shutdown`. True means accepted, not that the process has gone. */
	requestShutdown(port: number): Promise<boolean>;
	/** Can we bind this port, i.e. is nothing at all listening? */
	isPortFree(port: number): Promise<boolean>;
	sleep(ms: number): Promise<void>;
}

export const defaultSidecarSystem: SidecarSystem = {
	spawnEngine: (binaryPath, args, env) =>
		spawn(binaryPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
			env,
		}),
	engineProcessState,
	killEngineProcess: killVayuEngineProcess,
	probeHealth: isEngineRunning,
	requestShutdown: requestEngineShutdown,
	isPortFree: isPortAvailable,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * How this instance came to be attached to the engine it is talking to.
 *
 * `spawned` is the ordinary case and, once `start()` returns, the only one.
 * `adopted` is an engine that was already up when we started - after the
 * single-instance lock in main.ts, an orphan of a crashed session or, in
 * development, an engine started by hand - held only while it is being
 * stopped: it does not hold this session's grant secret, so it is replaced and
 * never used (#2356). It is ownership all the same, so a quit landing during
 * the replacement still stops it (#270).
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

/**
 * Raised when every candidate port is held by something that is not a Vayu
 * engine (#2118). Like `EngineNotReadyError` it leaves the app up: the user can
 * free the port and press Retry, so the message is the sentence they read.
 *
 * Several `ports` means a first start found every candidate held. The renderer
 * is told one port once, so the start narrows to the first (`claimPort`) and
 * Retry looks at that one alone: the sentence names it as the one to free and
 * mentions the fallbacks only as context.
 */
export class EnginePortInUseError extends Error {
	constructor(ports: readonly number[]) {
		const [first] = ports;
		super(
			ports.length > 1
				? `Another program is using port ${first}, and the fallback ports are held too. Free port ${first} and press Retry.`
				: `Another program is using port ${first}. Quit it and press Retry.`
		);
		this.name = "EnginePortInUseError";
	}
}

/** Where `start()` will run the engine, and whether something already answers `/health` there. */
interface PortChoice {
	port: number;
	answering: boolean;
}

/** The user-facing half of a `SpawnFailure`; ends up in a `showErrorBox`. */
function describeSpawnFailure(failure: SpawnFailure): string {
	if (failure.kind === "error") {
		return `Couldn't start the engine process: ${failure.message}`;
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
	/**
	 * The ports `start()` may use. Narrowed to the one it settles on by the first
	 * start, so a restart never moves the engine out from under a renderer that
	 * was told the port once.
	 */
	private candidates: readonly number[];
	private port: number;
	private portFixed = false;
	private onPortFixed: (port: number) => void;
	private onGrantSecret: (secret: string) => void;
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

	/**
	 * @param onPortFixed called once, when the first start settles the port, and
	 *        also when every candidate was held (with the first, which the error
	 *        names and a Retry tries again).
	 * @param onGrantSecret called with each spawned engine's grant secret, at
	 *        the spawn: the one way this process learns it (#2356).
	 */
	constructor(
		candidates: readonly number[] = ENGINE_PORT_CANDIDATES,
		system: SidecarSystem = defaultSidecarSystem,
		onPortFixed: (port: number) => void = () => {},
		onGrantSecret: (secret: string) => void = () => {}
	) {
		if (candidates.length === 0) {
			throw new Error("EngineSidecar needs at least one candidate port");
		}
		this.candidates = candidates;
		this.port = candidates[0];
		this.onPortFixed = onPortFixed;
		this.onGrantSecret = onGrantSecret;
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

		if (isDevelopmentBuild()) {
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
			appLogger().info("sidecar", "Created data directory", { dataDir: this.dataDir });
		}
	}

	/**
	 * Stop a healthy engine this session did not spawn, so the caller can spawn
	 * one in its place (#2356).
	 *
	 * Every write to file trust - a picked file, an allowed folder - needs the
	 * grant secret the engine was spawned with, and an engine already running was
	 * given another session's secret or none. Nothing writes the secret where it
	 * could be read back, so it cannot be handed one now: adopting it would leave
	 * every such write refused for the whole session. The same stop retires
	 * #1492's version mismatch, a daemon built for another Vayu version, which no
	 * longer needs a probe of its own.
	 */
	private async replaceAnsweringEngine(pid: number | null): Promise<void> {
		appLogger().warn(
			"sidecar",
			"An engine this session did not start is running - stopping it to start one that holds this session's grant secret",
			{ port: this.port, pid }
		);
		this.ownership = { kind: "adopted", pid };
		await this.system.requestShutdown(this.port);
		await this.stopAdopted(pid);
		// Same gap `restart()` waits out between a stop and the spawn that follows.
		await this.system.sleep(ENGINE_PORT_RELEASE_DELAY_MS);
	}

	/**
	 * Stop a live process the lock file names that did not answer `/health`
	 * (issue #1905), so the caller can spawn one in its place.
	 *
	 * The lock PID is verified to be a Vayu engine, so a missing `/health`
	 * answer means that engine is either still starting - an orphan from a
	 * crashed session reads its database and runs migrations before it listens -
	 * or hung. Spawning beside it loses the flock, and reporting the port as
	 * held would blame another program for our own engine. So it is given the
	 * budget a freshly spawned engine gets: one that answers is asked to shut
	 * down like any other engine found running, and one that does not is killed.
	 *
	 * A PID whose name could not be read arrives here too, and the kill refuses
	 * it; the cost is the budget plus the stop's grace period, after which the
	 * spawn goes ahead and the engine's own data-directory lock decides.
	 */
	private async replaceLockedEngine(pid: number): Promise<void> {
		appLogger().warn(
			"sidecar",
			"Lock file indicates the process is running, but the engine is not responding on this port - waiting for it",
			{ pid, port: this.port }
		);
		if (await this.pollHealthWithinBudget(() => null)) {
			await this.replaceAnsweringEngine(pid);
			return;
		}

		appLogger().warn(
			"sidecar",
			"Engine never answered /health - stopping it to start a fresh one",
			{
				pid,
				port: this.port,
				budgetMs: ENGINE_HEALTH_POLL_BUDGET_MS,
			}
		);
		this.ownership = { kind: "adopted", pid };
		await this.stopAdopted(pid);
		// Same gap `restart()` waits out between a stop and the spawn that follows.
		await this.system.sleep(ENGINE_PORT_RELEASE_DELAY_MS);
		appLogger().info("sidecar", "Replaced an unresponsive engine", { pid });
	}

	/**
	 * The lock file's PID unless it certainly names no Vayu engine, in which case
	 * the lock is removed and this answers null. A live PID whose name could not
	 * be read counts as live: its lock is never removed (#2422).
	 */
	private liveLockPid(lockPath: string): number | null {
		const lock = checkLockFile(lockPath, this.system.engineProcessState);
		if (lock === null) return null;
		const { pid, state } = lock;

		if (state === "engine") {
			appLogger().info("sidecar", "Lock file found, process is running", { pid });
			return pid;
		}
		if (state === "unknown") {
			appLogger().warn(
				"sidecar",
				"Lock file names a live process whose name could not be read - keeping the lock",
				{ pid }
			);
			return pid;
		}

		appLogger().warn("sidecar", "Stale lock file found, cleaning up", { pid });
		// Clean up stale lock file to prevent issues during install/reinstall
		try {
			fs.unlinkSync(lockPath);
			appLogger().info("sidecar", "Removed stale lock file", { lockPath });
		} catch (err) {
			appLogger().warn("sidecar", "Failed to remove stale lock file", {
				error: String(err),
			});
			// Continue anyway - the engine's lock mechanism will handle it
		}
		return null;
	}

	/**
	 * Pick the candidate this start uses (#2118).
	 *
	 * With no live lock, each candidate in turn: one answering `/health` is
	 * taken over (its engine replaced on that port), a free one is taken, a held
	 * one is skipped. A live lock means our own engine is up somewhere, so every
	 * candidate is asked for `/health` before any free port is taken: a crash
	 * orphan on a fallback port is replaced there even once the default has come
	 * free. When it answers nowhere it is starting (not listening, so its port
	 * reads free) or hung (holding a port no probe can tell from another
	 * program's), and the wait in `replaceLockedEngine` watches the first free
	 * candidate, or the first candidate when none is free.
	 */
	private async choosePort(lockedPid: number | null): Promise<PortChoice> {
		if (lockedPid !== null) {
			const answering = await this.firstCandidate((port) => this.system.probeHealth(port));
			if (answering !== null) return { port: answering, answering: true };
			const free = await this.firstCandidate((port) => this.system.isPortFree(port));
			return { port: free ?? this.candidates[0], answering: false };
		}

		for (const port of this.candidates) {
			if (await this.system.probeHealth(port)) return { port, answering: true };
			if (await this.system.isPortFree(port)) return { port, answering: false };
		}
		throw new EnginePortInUseError(this.candidates);
	}

	/** The first candidate `test` accepts, asked in order, or null. */
	private async firstCandidate(test: (port: number) => Promise<boolean>): Promise<number | null> {
		for (const port of this.candidates) {
			if (await test(port)) return port;
		}
		return null;
	}

	/**
	 * `choosePort`, then fix its answer for this sidecar's lifetime. A start that
	 * found every candidate held fixes the first: the session needs one address
	 * to give the renderer, and it is the one the error tells the user to free.
	 */
	private async claimPort(lockedPid: number | null): Promise<PortChoice> {
		try {
			const choice = await this.choosePort(lockedPid);
			this.fixPort(choice.port);
			return choice;
		} catch (error) {
			this.fixPort(this.candidates[0]);
			throw error;
		}
	}

	private fixPort(port: number): void {
		this.port = port;
		this.candidates = [port];
		if (this.portFixed) return;
		this.portFixed = true;
		this.onPortFixed(port);
	}

	/** Stop the engine `choice` found, or the one the lock names, if there is one. */
	private async replaceRunningEngine(
		choice: PortChoice,
		lockedPid: number | null,
		lockPath: string
	): Promise<void> {
		if (lockedPid !== null) {
			await (choice.answering
				? this.replaceAnsweringEngine(lockedPid)
				: this.replaceLockedEngine(lockedPid));
			return;
		}
		// An engine from a previous session or crash with no live lock to read a
		// PID from, so it is watched by port only - `stopAdopted` falls back to
		// health for the exit.
		if (choice.answering) await this.replaceAnsweringEngine(readPidFromLock(lockPath));
	}

	/**
	 * Start the engine process
	 */
	async start(): Promise<void> {
		if (this.ownership.kind !== "none") {
			appLogger().info("sidecar", "Engine already running (managed by this instance)");
			return;
		}

		// Ensure data directory exists first
		this.ensureDataDirectory();

		const lockPath = this.getLockFilePath();
		const lockedPid = this.liveLockPid(lockPath);
		const choice = await this.claimPort(lockedPid);
		await this.replaceRunningEngine(choice, lockedPid, lockPath);

		// Free when chosen, but an engine stopped there may not have let go of
		// it, and something else may have taken it since.
		if (!(await this.system.isPortFree(this.port))) {
			throw new EnginePortInUseError([this.port]);
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

		appLogger().info("sidecar", "Starting engine", {
			binaryPath: this.binaryPath,
			dataDir: this.dataDir,
			port: this.port,
		});

		// Last look before the spawn, with no `await` between the two: from here
		// on the child is tracked, so the quit path can kill it. Every check
		// earlier than this one has an await after it, which is a window a quit
		// can land in - and a child spawned into that window is an orphan.
		this.assertNotStopping();

		// Spawn the engine process. `--verbose 0` in production: the engine writes
		// its own structured records to `engine_<stamp>.log` (#1557) regardless,
		// so nothing here reads its console text any more (#1558) - dev keeps `2`
		// for a developer watching a terminal. A fresh grant secret per spawn: the
		// engine takes it out of its own environment at start, so a restart
		// cannot reuse the last one and does not need to.
		const grantSecret = newGrantSecret();
		this.process = this.system.spawnEngine(
			this.binaryPath,
			[
				"--port",
				this.port.toString(),
				"--data-dir",
				this.dataDir,
				"--verbose",
				`${isDevelopmentBuild() ? "2" : "0"}`,
			],
			{ ...process.env, [ENGINE_GRANT_SECRET_ENV]: grantSecret }
		);
		this.ownership = { kind: "spawned" };
		this.onGrantSecret(grantSecret);

		// Drain stdout without re-printing it - the engine's own file is the
		// record now (#1557, #1558). Still read eagerly: on Linux an unread pipe
		// blocks the child on buffer space once it fills.
		if (this.process.stdout) {
			this.process.stdout.setEncoding("utf8");
			this.process.stdout.resume();
		}

		// Kept for the failure message: an engine that dies at spawn has usually
		// said why on stderr, and that line is the difference between "exit code 127"
		// and "cannot open shared object file". Not re-printed, for the same
		// reason stdout is not: only the tail this app cannot get any other way
		// (the engine has no file yet) is worth keeping.
		const stderrTail: string[] = [];

		if (this.process.stderr) {
			this.process.stderr.setEncoding("utf8");
			this.process.stderr.on("data", (data) => {
				const lines = data
					.toString()
					.split("\n")
					.filter((line: string) => line.trim());
				for (const line of lines) {
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
			appLogger().info("sidecar", "Engine exited", { code, signal });
			failure = { kind: "exit", code, signal, stderr: [...stderrTail] };
			forget();
		});

		// Handle errors
		child.on("error", (err) => {
			appLogger().error("sidecar", "Engine error", { error: String(err) });
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
		if (await this.pollHealthWithinBudget(spawnFailure)) {
			appLogger().info("sidecar", "Engine is ready");
			return;
		}
		throw new EngineNotReadyError(ENGINE_HEALTH_POLL_BUDGET_MS);
	}

	/**
	 * The ramped health poll behind `waitForEngine`, shared with the wait on a
	 * lock-file engine that has not answered yet (#1905).
	 *
	 * @returns `true` once `/health` answers, `false` when the budget is spent.
	 *          A `spawnFailure` that reports a dead child throws instead.
	 */
	private async pollHealthWithinBudget(
		spawnFailure: () => SpawnFailure | null
	): Promise<boolean> {
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

			if (await this.system.probeHealth(this.port)) return true;

			if (waited >= ENGINE_HEALTH_POLL_BUDGET_MS) return false;

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
			appLogger().info("sidecar", "Engine not running");
			return;
		}

		appLogger().info("sidecar", "Stopping engine");

		// Try graceful HTTP shutdown first (works reliably on all platforms)
		appLogger().info("sidecar", "Requesting graceful shutdown via HTTP");
		if (await this.system.requestShutdown(this.port)) {
			appLogger().info("sidecar", "Shutdown request accepted");
		} else {
			appLogger().info("sidecar", "HTTP shutdown request failed, will use signal");
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
			appLogger().info("sidecar", "Engine did not exit gracefully, killing");
			child.kill("SIGKILL");
			await exited;
		}

		if (this.process === child) this.process = null;
		this.ownership = { kind: "none" };
		appLogger().info("sidecar", "Engine stopped");
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
			appLogger().info("sidecar", "Adopted engine did not exit gracefully, killing", { pid });
			if (this.system.killEngineProcess(pid)) {
				await this.waitForAdoptedExit(pid);
			}
		}

		// Ownership is released either way: a survivor we could not kill is not
		// ours to keep claiming, and saying otherwise would make `isRunning()`
		// lie in the other direction.
		this.ownership = { kind: "none" };
		appLogger().info("sidecar", gone ? "Adopted engine stopped" : "Adopted engine released");
	}

	/**
	 * Poll until the adopted engine is gone or the grace period expires.
	 *
	 * By PID when we have one - a healthy `/health` answer would keep reporting
	 * "alive" for a *replacement* engine on the same port, and a dead one for an
	 * engine still writing its final flush. Health is only the fallback. A PID
	 * whose name cannot be read is not gone until the signal-0 probe says so.
	 */
	private async waitForAdoptedExit(pid: number | null): Promise<boolean> {
		const deadline = ENGINE_GRACEFUL_EXIT_TIMEOUT_MS;
		for (let waited = 0; waited < deadline; waited += ENGINE_EXIT_POLL_INTERVAL_MS) {
			await this.system.sleep(ENGINE_EXIT_POLL_INTERVAL_MS);
			const alive =
				pid !== null
					? this.system.engineProcessState(pid) !== "not-engine"
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
		appLogger().info("sidecar", "Restarting engine");

		const baseDelay = ENGINE_RESTART_BASE_DELAY_MS;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				// Checked per attempt, not once up front: a quit can arrive between
				// two retries just as easily as before the first.
				this.assertNotStopping();

				if (attempt > 0) {
					// Calculate exponential delay: baseDelay * 2^(attempt-1)
					const delay = baseDelay * Math.pow(2, attempt - 1);
					appLogger().info("sidecar", "Retry attempt after delay", {
						attempt,
						maxRetries,
						delayMs: delay,
					});
					await this.system.sleep(delay);
				}

				await this.stop();
				// Small delay to ensure port is released
				await this.system.sleep(ENGINE_PORT_RELEASE_DELAY_MS);
				await this.start();
				appLogger().info("sidecar", "Engine restarted successfully");
				return;
			} catch (error) {
				const lastError = error instanceof Error ? error : new Error(String(error));
				appLogger().error("sidecar", "Restart attempt failed", {
					attempt: attempt + 1,
					maxAttempts: maxRetries + 1,
					error: lastError.message,
				});

				// A shutdown is not a failed restart to retry - the engine is meant
				// to be down, and retrying would spawn the orphan we just avoided.
				if (this.stopping) {
					throw lastError;
				}

				// Only the user can free the port, so a retry on a timer just
				// delays the sentence that tells them to; it is thrown as written.
				if (error instanceof EnginePortInUseError) {
					throw error;
				}

				// The last attempt's failure is named in the message and rides along
				// as the cause, so the user reads what happened and the log keeps
				// the original error and its stack.
				if (attempt === maxRetries) {
					throw new Error(
						`Nothing answered after ${maxRetries + 1} attempts (${lastError.message}). Quit Vayu and open it again.`,
						{ cause: error }
					);
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
			appLogger().info("sidecar", "Waiting for the in-flight restart before shutting down");
			await inFlight;
		}
		await this.stop();
	}
}
