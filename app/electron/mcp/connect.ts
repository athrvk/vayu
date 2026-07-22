/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file connect.ts
 * @brief One-click "connect this agent to Vayu" by shelling out to a client's
 *        own CLI - `claude mcp add` (Claude Code) and `code --add-mcp` (VS Code).
 *        Both are designed for exactly this and handle merging into the user's
 *        config. Clients without an add-CLI (Cursor, Codex) are not handled here;
 *        the UI falls back to a copyable snippet for those.
 *
 *        A GUI-launched Electron app often has a stripped PATH, so the target
 *        binary is resolved through a login shell (`command -v`) before it is
 *        spawned directly with an argument array (so the URL/JSON is never
 *        interpolated into a shell string). If the CLI cannot be found, the
 *        caller gets `reason: "cli-not-found"` and shows the copy snippet.
 */

import { spawn } from "node:child_process";

export type McpConnectClient = "claude" | "vscode";

export interface McpConnectResult {
	ok: boolean;
	/** Why it failed - distinguishes "install the CLI" from a real error. */
	reason?: "cli-not-found" | "error" | "unsupported";
	/** Human-readable detail (command output on success, error text on failure). */
	message?: string;
}

const RESOLVE_TIMEOUT_MS = 8000;
const RUN_TIMEOUT_MS = 20000;

/** Resolve a CLI to an absolute path via the user's login shell, or null. */
function resolveBin(bin: string): Promise<string | null> {
	return new Promise((resolve) => {
		const isWin = process.platform === "win32";
		const cmd = isWin ? "where" : process.env.SHELL || "/bin/bash";
		// `-lc` sources the login profile so PATH matches a real terminal.
		const args = isWin ? [bin] : ["-lc", `command -v ${bin} 2>/dev/null`];

		let out = "";
		let settled = false;
		const done = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		const child = spawn(cmd, args, { env: process.env });
		const timer = setTimeout(() => {
			child.kill();
			done(null);
		}, RESOLVE_TIMEOUT_MS);

		child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
		child.on("error", () => done(null));
		child.on("close", () => {
			const first = out
				.split(/\r?\n/)
				.map((s) => s.trim())
				.find(Boolean);
			done(first ?? null);
		});
	});
}

/** Spawn an already-resolved binary with an argument array (no shell). */
function run(bin: string, args: string[]): Promise<McpConnectResult> {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let settled = false;
		const done = (value: McpConnectResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};

		const child = spawn(bin, args, { env: process.env });
		const timer = setTimeout(() => {
			child.kill();
			done({ ok: false, reason: "error", message: "Timed out running the client CLI." });
		}, RUN_TIMEOUT_MS);

		child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
		child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
		child.on("error", (e) => done({ ok: false, reason: "error", message: e.message }));
		child.on("close", (code) => {
			if (code === 0) {
				done({ ok: true, message: (out || err).trim() });
			} else {
				done({
					ok: false,
					reason: "error",
					message: (err || out).trim() || `Exited with code ${code}.`,
				});
			}
		});
	});
}

/**
 * Register the Vayu MCP endpoint with a client via its own CLI. `url` is the
 * live endpoint (e.g. `http://127.0.0.1:9877/mcp`).
 */
export async function connectClient(
	client: McpConnectClient,
	url: string
): Promise<McpConnectResult> {
	if (client === "claude") {
		const bin = await resolveBin("claude");
		if (!bin) return { ok: false, reason: "cli-not-found" };
		// `--scope user` makes it available across all projects (not just cwd).
		return run(bin, ["mcp", "add", "--transport", "http", "--scope", "user", "vayu", url]);
	}
	if (client === "vscode") {
		const bin = await resolveBin("code");
		if (!bin) return { ok: false, reason: "cli-not-found" };
		return run(bin, ["--add-mcp", JSON.stringify({ name: "vayu", type: "http", url })]);
	}
	return { ok: false, reason: "unsupported", message: `Unsupported client: ${String(client)}` };
}
