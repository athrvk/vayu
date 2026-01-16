/**
 * @file sidecar.ts
 * @brief Manages the C++ engine sidecar process lifecycle
 */

import { spawn, ChildProcess } from "child_process";
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
				`Port ${this.port} is already in use by another application.\n` +
					`Please free the port or configure a different port.`
			);
		}

		// Ensure data directory exists
		this.ensureDataDirectory();

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
			["--port", this.port.toString(), "--data-dir", this.dataDir, "--verbose", "1"],
			{
				stdio: ["ignore", "pipe", "pipe"],
				detached: false,
			}
		);

		// Handle stdout
		this.process.stdout?.on("data", (data) => {
			console.log(`[Engine] ${data.toString().trim()}`);
		});

		// Handle stderr
		this.process.stderr?.on("data", (data) => {
			console.error(`[Engine] ${data.toString().trim()}`);
		});

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
	private async waitForEngine(maxAttempts: number = 30, delay: number = 500): Promise<void> {
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

			// Send SIGTERM to gracefully shut down
			this.process.kill("SIGTERM");
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
}
