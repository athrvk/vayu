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
 *        binary is resolved first (`where` / `command -v`) and only then spawned.
 *        Resolution and spawning both differ per platform, and getting either
 *        wrong looks identical to "the CLI is not installed":
 *
 *        - **Windows.** `where` lists every match and puts the extensionless
 *          POSIX script first (VS Code ships `code` next to `code.cmd`), which
 *          Node cannot execute at all; and since Node 20.12 it refuses to spawn
 *          a `.cmd`/`.bat` without `shell: true` (the CVE-2024-27980 fix). So
 *          the match is picked by extension and a shim is run through cmd.exe
 *          with every argument quoted by hand - the VS Code argument is a JSON
 *          blob, and an unquoted one loses its braces and quotes.
 *        - **POSIX.** `-lc` sources the login profile, which is what recovers
 *          the PATH a GUI launch stripped, so the login shell is tried first;
 *          `/bin/sh` is the fallback for a login shell that does not speak `-lc`
 *          (nushell, xonsh), which would otherwise report the CLI as missing.
 *
 *        If the CLI cannot be found, the caller gets `reason: "cli-not-found"`
 *        and shows the copy snippet. Nothing here rejects: every failure is a
 *        `McpConnectResult`, because the renderer distinguishes the reasons.
 */

import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

export type McpConnectClient = "claude" | "vscode";

export interface McpConnectResult {
	ok: boolean;
	/** Why it failed - distinguishes "install the CLI" from a real error. */
	reason?: "cli-not-found" | "error" | "unsupported";
	/** Human-readable detail (command output on success, error text on failure). */
	message?: string;
}

/**
 * Injection seam for the tests, matching `EngineClient`'s `fetchImpl`: the
 * behaviour worth pinning is which command gets spawned on which platform, and
 * that cannot be observed by running real CLIs the test machine does not have.
 */
export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions
) => ChildProcess;

const RESOLVE_TIMEOUT_MS = 8000;
const RUN_TIMEOUT_MS = 20000;

/**
 * Login shell first (it sources the profile that holds the real PATH), then
 * `/bin/sh`, which POSIX guarantees exists and understands `-lc`. Deduplicated
 * so the common `SHELL=/bin/sh` case does not probe twice.
 */
function posixShells(): string[] {
	const shells = [process.env.SHELL || "/bin/bash"];
	if (!shells.includes("/bin/sh")) shells.push("/bin/sh");
	return shells;
}

/** Run a probe and return its stdout lines, trimmed and empties dropped. */
function capture(spawnImpl: SpawnFn, cmd: string, args: string[]): Promise<string[]> {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const done = (value: string[]) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(value);
		};

		let child: ChildProcess;
		try {
			child = spawnImpl(cmd, args, { env: process.env });
		} catch {
			// A shell that is not on disk throws here rather than emitting "error".
			resolve([]);
			return;
		}
		timer = setTimeout(() => {
			child.kill();
			done([]);
		}, RESOLVE_TIMEOUT_MS);

		child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
		child.on("error", () => done([]));
		child.on("close", () =>
			done(
				out
					.split(/\r?\n/)
					.map((s) => s.trim())
					.filter(Boolean)
			)
		);
	});
}

/**
 * `where` lists every match and orders them by PATH, so the extensionless
 * POSIX script VS Code ships (`code`) comes before the `code.cmd` Windows can
 * actually run. Pick by extension instead of taking the first line.
 */
function pickWindowsBin(paths: string[]): string | null {
	const withExt = (exts: string[]) =>
		paths.find((p) => exts.some((e) => p.toLowerCase().endsWith(e)));
	return withExt([".exe", ".com"]) ?? withExt([".cmd", ".bat"]) ?? paths[0] ?? null;
}

/** Resolve a CLI to an absolute path, or null when it is not installed. */
async function resolveBin(bin: string, spawnImpl: SpawnFn): Promise<string | null> {
	if (process.platform === "win32") {
		return pickWindowsBin(await capture(spawnImpl, "where", [bin]));
	}
	for (const shell of posixShells()) {
		const [first] = await capture(spawnImpl, shell, ["-lc", `command -v ${bin} 2>/dev/null`]);
		if (first) return first;
	}
	return null;
}

/** Node >= 20.12 refuses to spawn these without a shell (CVE-2024-27980). */
function needsShell(bin: string): boolean {
	return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

/**
 * Quote one argument for `cmd.exe /d /s /c "..."`, which Node builds when
 * `shell: true` is set on Windows.
 *
 * Two parsers read this string in turn: cmd.exe, then the target program's own
 * command-line splitter. Double quotes neutralise cmd's metacharacters
 * (`& | < > ^`) and hand the splitter a single argument; backslashes only need
 * doubling where they precede a quote (the MSVCRT rule). `%` is the one
 * character quotes do not protect - cmd expands `%VAR%` before anything else
 * sees the line, and there is no escape for it outside a batch file - so an
 * argument carrying one is refused rather than silently mangled.
 */
function quoteForCmd(arg: string): string {
	if (arg.includes("%")) {
		throw new Error(`Cannot pass an argument containing "%" through cmd.exe: ${arg}`);
	}
	const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
	return `"${escaped}"`;
}

/** Spawn an already-resolved binary, through cmd.exe when it is a shim. */
function run(bin: string, args: string[], spawnImpl: SpawnFn): Promise<McpConnectResult> {
	return new Promise((resolve) => {
		let out = "";
		let err = "";
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const done = (value: McpConnectResult) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(value);
		};

		let command = bin;
		let spawnArgs: string[] = args;
		let options: SpawnOptions = { env: process.env };
		if (needsShell(bin)) {
			try {
				// The whole line goes in `command`: Node joins command and args
				// with plain spaces under `shell: true`, so anything left in
				// `args` would arrive unquoted.
				command = [bin, ...args].map(quoteForCmd).join(" ");
			} catch (e) {
				done({ ok: false, reason: "error", message: (e as Error).message });
				return;
			}
			spawnArgs = [];
			options = { env: process.env, shell: true };
		}

		let child: ChildProcess;
		try {
			child = spawnImpl(command, spawnArgs, options);
		} catch (e) {
			// EINVAL for a shim spawned without a shell throws synchronously -
			// a rejection here would reach the renderer as an unhandled invoke.
			done({ ok: false, reason: "error", message: (e as Error).message });
			return;
		}
		timer = setTimeout(() => {
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
	url: string,
	spawnImpl: SpawnFn = spawn
): Promise<McpConnectResult> {
	if (client === "claude") {
		const bin = await resolveBin("claude", spawnImpl);
		if (!bin) return { ok: false, reason: "cli-not-found" };
		// `--scope user` makes it available across all projects (not just cwd).
		return run(
			bin,
			["mcp", "add", "--transport", "http", "--scope", "user", "vayu", url],
			spawnImpl
		);
	}
	if (client === "vscode") {
		const bin = await resolveBin("code", spawnImpl);
		if (!bin) return { ok: false, reason: "cli-not-found" };
		return run(
			bin,
			["--add-mcp", JSON.stringify({ name: "vayu", type: "http", url })],
			spawnImpl
		);
	}
	return { ok: false, reason: "unsupported", message: `Unsupported client: ${String(client)}` };
}
