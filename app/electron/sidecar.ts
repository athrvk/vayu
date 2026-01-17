/**
 * @file sidecar.ts
 * @brief Manages the C++ engine sidecar process lifecycle
 */

import { spawn, ChildProcess, execSync } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import net from "net";

const isDev = process.env.NODE_ENV === "development";

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
			signal: AbortSignal.timeout(1000),
		});
		const data = await response.json();
		return data?.status === "ok";
	} catch {
		return false;
	}
}

/**
 * Check if a process is still running by PID
 * Cross-platform implementation
 */
function isProcessRunning(pid: number): boolean {
	try {
		if (process.platform === "win32") {
			// On Windows, use tasklist to check if process exists
			try {
				// Try to get process info - if it fails, process doesn't exist
				execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		} else {
			// On Unix (macOS, Linux), send signal 0 to check if process exists
			// This doesn't actually send a signal, just checks existence
			process.kill(pid, 0);
			return true;
		}
	} catch (err: any) {
		// If errno is ESRCH, process doesn't exist
		// If errno is EPERM, process exists but we don't have permission (still running)
		if (err.code === "ESRCH") {
			return false;
		}
		// EPERM or other errors mean process might exist
		return err.code === "EPERM";
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
 * Check lock file and verify if the process is still running
 * Returns true if lock file exists and process is running, false otherwise
 */
function checkLockFile(lockPath: string): {
	locked: boolean;
	pid: number | null;
	running: boolean;
} {
	const pid = readPidFromLock(lockPath);
	if (pid === null) {
		return { locked: false, pid: null, running: false };
	}

	const running = isProcessRunning(pid);
	return { locked: true, pid, running };
}

export class EngineSidecar {
	private process: ChildProcess | null = null;
	private port: number;
	private dataDir: string;
	private binaryPath: string;

	constructor(port: number = 9876) {
		this.port = port;
		this.dataDir = this.getDataDirectory();
		this.binaryPath = this.getEngineBinaryPath();
	}

	/**
	 * Get the user data directory for the engine
	 * Production:
	 *   - macOS: ~/Library/Application Support/vayu
	 *   - Windows: %APPDATA%/vayu
	 *   - Linux: ~/.config/vayu
	 * Development: <repo>/engine/data
	 */
	private getDataDirectory(): string {
		if (isDev) {
			// In development, use a local directory in the engine folder
			const devDataDir = path.join(app.getAppPath(), "..", "engine", "data");
			return devDataDir;
		} else {
			// In production, use the app's userData directory
			// app.getPath("userData") returns platform-specific paths
			return app.getPath("userData");
		}
	}

	/**
	 * Get the lock file path
	 * This should match the path used by the engine: {dataDir}/vayu.lock
	 */
	private getLockFilePath(): string {
		return path.join(this.dataDir, "vayu.lock");
	}

	/**
	 * Get the path to the vayu-engine binary
	 * Development:
	 *   - Unix: ../engine/build/vayu-engine
	 *   - Windows: ../engine/build/Release/vayu-engine.exe
	 * Production:
	 *   - macOS: Contents/Resources/bin/vayu-engine
	 *   - Windows: resources/bin/vayu-engine.exe
	 *   - Linux: resources/bin/vayu-engine
	 */
	private getEngineBinaryPath(): string {
		const isWindows = process.platform === "win32";
		const binaryName = isWindows ? "vayu-engine.exe" : "vayu-engine";

		if (isDev) {
			// In development, use the build directory
			if (isWindows) {
				// Windows build outputs to build/Debug/
				const devBinaryPath = path.join(
					app.getAppPath(),
					"..",
					"engine",
					"build",
					"Debug",
					binaryName
				);
				return devBinaryPath;
			} else {
				// Unix systems (macOS, Linux)
				const devBinaryPath = path.join(
					app.getAppPath(),
					"..",
					"engine",
					"build",
					binaryName
				);
				return devBinaryPath;
			}
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
		if (this.process) {
			console.log("[Sidecar] Engine already running (managed by this instance)");
			return;
		}

		// Ensure data directory exists first
		this.ensureDataDirectory();

		// Check lock file to see if engine is already running
		const lockPath = this.getLockFilePath();
		const lockStatus = checkLockFile(lockPath);

		if (lockStatus.locked) {
			if (lockStatus.running && lockStatus.pid !== null) {
				console.log(
					`[Sidecar] Lock file found with PID ${lockStatus.pid}, process is running`
				);
				// Verify engine is actually responding on the port
				if (await isEngineRunning(this.port)) {
					console.log(
						`[Sidecar] Engine already running on port ${this.port}, reusing existing instance`
					);
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

		// Check if engine is already running on this port (from previous session or crash)
		if (await isEngineRunning(this.port)) {
			console.log(
				`[Sidecar] Engine already running on port ${this.port}, reusing existing instance`
			);
			return;
		}

		// Check if port is in use by something else
		if (!(await isPortAvailable(this.port))) {
			throw new Error(
				`[Sidecar] Port ${this.port} is already in use by another application.`
			);
		}

		// Check if binary exists
		if (!fs.existsSync(this.binaryPath)) {
			const platform = process.platform;
			let buildScript = "./scripts/build/build-macos.sh";
			if (platform === "win32") {
				buildScript = "./scripts/build/build-windows.ps1";
			} else if (platform === "linux") {
				buildScript = "./scripts/build/build-linux.sh";
			}

			throw new Error(
				`Engine binary not found at: ${this.binaryPath}\n` +
					`Please build the engine first:\n` +
					`  Development: cd engine && cmake -B build && cmake --build build\n` +
					`  Production: ${buildScript}`
			);
		}

		console.log(`[Sidecar] Starting engine...`);
		console.log(`[Sidecar]   Binary: ${this.binaryPath}`);
		console.log(`[Sidecar]   Data Dir: ${this.dataDir}`);
		console.log(`[Sidecar]   Port: ${this.port}`);

		// Spawn the engine process
		this.process = spawn(
			this.binaryPath,
			[
				"--port",
				this.port.toString(),
				"--data-dir",
				this.dataDir,
				"--verbose",
				`${isDev ? "2" : "1"}`,
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			}
		);

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
				}
			});
			// Resume reading to prevent backpressure
			this.process.stderr.resume();
		}

		// Handle process exit
		this.process.on("exit", (code, signal) => {
			console.log(`[Sidecar] Engine exited with code ${code} signal ${signal}`);
			this.process = null;
		});

		// Handle errors
		this.process.on("error", (err) => {
			console.error(`[Sidecar] Engine error:`, err);
			this.process = null;
		});

		// Wait for the engine to be ready
		await this.waitForEngine();
	}

	/**
	 * Wait for the engine to be ready by polling the health endpoint
	 */
	private async waitForEngine(maxAttempts?: number, delay: number = 500): Promise<void> {
		// Platform-specific timeout: Linux needs more time for DB initialization
		if (maxAttempts === undefined) {
			if (process.platform === "linux") {
				maxAttempts = 60; // 30 seconds on Linux
			} else {
				maxAttempts = 30; // 15 seconds on Windows/macOS
			}
		}

		const healthUrl = `http://127.0.0.1:${this.port}/health`;

		for (let i = 0; i < maxAttempts; i++) {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 2000);

				const response = await fetch(healthUrl, {
					signal: controller.signal,
				});

				clearTimeout(timeout);

				if (response.ok) {
					console.log(`[Sidecar] Engine is ready`);
					return;
				}
			} catch (err) {
				// Engine not ready yet, continue waiting
			}

			await new Promise((resolve) => setTimeout(resolve, delay));
		}

		throw new Error(`Engine failed to start within ${(maxAttempts * delay) / 1000} seconds`);
	}

	/**
	 * Stop the engine process
	 */
	async stop(): Promise<void> {
		if (!this.process) {
			console.log("[Sidecar] Engine not running");
			return;
		}

		console.log("[Sidecar] Stopping engine...");

		// Try graceful HTTP shutdown first (works reliably on all platforms)
		try {
			console.log("[Sidecar] Requesting graceful shutdown via HTTP...");
			const response = await fetch(`http://127.0.0.1:${this.port}/shutdown`, {
				method: "POST",
				signal: AbortSignal.timeout(2000),
			});
			if (response.ok) {
				console.log("[Sidecar] Shutdown request accepted");
			}
		} catch (err) {
			console.log("[Sidecar] HTTP shutdown request failed, will use signal");
		}

		return new Promise((resolve) => {
			if (!this.process) {
				resolve();
				return;
			}

			// Give the process 5 seconds to exit gracefully
			const timeout = setTimeout(() => {
				if (this.process) {
					console.log("[Sidecar] Engine did not exit gracefully, killing...");
					this.process.kill("SIGKILL");
				}
			}, 5000);

			this.process.on("exit", () => {
				clearTimeout(timeout);
				this.process = null;
				console.log("[Sidecar] Engine stopped");
				resolve();
			});

			// Send SIGTERM as fallback (works on Unix, immediate termination on Windows)
			// On Windows, the HTTP shutdown should have already initiated graceful shutdown
			if (process.platform !== "win32") {
				this.process.kill("SIGTERM");
			}
		});
	}

	/**
	 * Get the engine API URL
	 */
	getApiUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/**
	 * Check if the engine is running
	 */
	isRunning(): boolean {
		return this.process !== null;
	}

	/**
	 * Restart the engine process with retry logic and exponential backoff
	 */
	async restart(maxRetries: number = 3): Promise<void> {
		console.log("[Sidecar] Restarting engine...");

		let lastError: Error | null = null;
		const baseDelay = 1000; // Initial delay in milliseconds

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				if (attempt > 0) {
					// Calculate exponential delay: baseDelay * 2^(attempt-1)
					const delay = baseDelay * Math.pow(2, attempt - 1);
					console.log(
						`[Sidecar] Retry attempt ${attempt}/${maxRetries} after ${delay}ms delay...`
					);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}

				await this.stop();
				// Small delay to ensure port is released
				await new Promise((resolve) => setTimeout(resolve, 500));
				await this.start();
				console.log("[Sidecar] Engine restarted successfully");
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				console.error(
					`[Sidecar] Restart attempt ${attempt + 1}/${maxRetries + 1} failed:`,
					lastError.message
				);

				// If this was the last attempt, throw the error
				if (attempt === maxRetries) {
					throw new Error(`Please close the Application and reopen it.`);
				}
			}
		}
	}
}
