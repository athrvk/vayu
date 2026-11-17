/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One-click connect is a platform contract, and both halves of it fail silently.
 *
 * On Windows the CLI that gets resolved is usually a shim: `where` lists VS
 * Code's extensionless POSIX script before the `code.cmd` Windows can run, and
 * Node has refused to spawn `.cmd`/`.bat` without a shell since 20.12. Through
 * a shell the argument array is joined with plain spaces, so the VS Code JSON
 * blob loses its quotes and braces unless every argument is quoted by hand -
 * which is why the exact command line is asserted here rather than "a spawn
 * happened". On POSIX the login shell is what recovers the PATH a GUI launch
 * stripped, but a login shell that does not speak `-lc` reported the CLI as
 * missing rather than falling back.
 *
 * `process.platform` is stubbed both ways (as `updater.test.ts` does): asserting
 * the host platform would leave whichever branch CI is not running untested.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { connectClient, type SpawnFn } from "./connect.js";

const URL = "http://127.0.0.1:9877/mcp";

/** Just enough of a ChildProcess for connect.ts to attach to and drain. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	kill() {
		return true;
	}
}

interface SpawnCall {
	command: string;
	args: readonly string[];
	options: SpawnOptions;
}

/**
 * A spawn that records every call and hands each child to `respond`, which
 * decides what that process printed and how it exited. Emission is deferred a
 * microtask so the listeners connect.ts attaches are in place first.
 */
function recorder(respond: (call: SpawnCall, child: FakeChild, index: number) => void): {
	spawnImpl: SpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	const spawnImpl: SpawnFn = (command, args, options) => {
		const call = { command, args, options };
		const index = calls.push(call) - 1;
		const child = new FakeChild();
		queueMicrotask(() => respond(call, child, index));
		return child as unknown as ChildProcess;
	};
	return { spawnImpl, calls };
}

/** Finish a fake process: what it printed, and the code it exited with. */
function finish(child: FakeChild, stdout: string, code = 0, stderr = "") {
	if (stdout) child.stdout.emit("data", Buffer.from(stdout));
	if (stderr) child.stderr.emit("data", Buffer.from(stderr));
	child.emit("close", code);
}

/**
 * The `claude` flow is position-indexed: call 0 resolves the binary, call 1 is
 * `mcp get vayu`, and what follows is a remove and/or the add. This answers the
 * resolve probe with `resolved` and the lookup as "nothing registered yet", then
 * every later call with `rest`.
 */
function freshClaude(resolved: string, rest = "Added vayu.") {
	return (child: FakeChild, index: number) => {
		if (index === 0) finish(child, resolved);
		else if (index === 1) finish(child, "", 1, "No MCP server found with name: vayu");
		else finish(child, rest);
	};
}

const realPlatform = process.platform;
const realShell = process.env.SHELL;

function setPlatform(platform: NodeJS.Platform) {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
	delete process.env.SHELL;
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
	if (realShell === undefined) delete process.env.SHELL;
	else process.env.SHELL = realShell;
});

describe("connectClient on Windows", () => {
	beforeEach(() => setPlatform("win32"));

	const CODE_DIR = "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin";
	// `where` order, verbatim: the POSIX script Windows cannot execute is first.
	const WHERE_CODE = `${CODE_DIR}\\code\r\n${CODE_DIR}\\code.cmd\r\n`;

	it("runs the .cmd shim through a shell, with every argument quoted", async () => {
		const { spawnImpl, calls } = recorder((call, child, index) => {
			finish(child, index === 0 ? WHERE_CODE : "Added.");
		});

		const res = await connectClient("vscode", URL, spawnImpl);

		expect(res).toEqual({ ok: true, message: "Added." });
		expect(calls[0]).toMatchObject({ command: "where", args: ["code"] });
		// Under `shell: true` Node joins command and args with plain spaces, so
		// the whole line has to arrive pre-quoted in `command` - an unquoted JSON
		// blob loses its quotes to cmd.exe and reaches `code` as several words.
		expect(calls[1].options.shell).toBe(true);
		expect(calls[1].args).toEqual([]);
		expect(calls[1].command).toBe(
			`"${CODE_DIR}\\code.cmd" "--add-mcp" ` +
				'"{\\"name\\":\\"vayu\\",\\"type\\":\\"http\\",\\"url\\":\\"http://127.0.0.1:9877/mcp\\"}"'
		);
	});

	it("picks the runnable shim over the extensionless first line of `where`", async () => {
		const { spawnImpl, calls } = recorder((call, child, index) => {
			finish(child, index === 0 ? WHERE_CODE : "Added.");
		});

		await connectClient("vscode", URL, spawnImpl);

		expect(calls[1].command.startsWith(`"${CODE_DIR}\\code.cmd"`)).toBe(true);
		expect(calls[1].command).not.toContain(`"${CODE_DIR}\\code"`);
	});

	it("quotes an npm-shimmed `claude` the same way", async () => {
		const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
		const { spawnImpl, calls } = recorder((call, child, index) =>
			freshClaude(`${NPM}\\claude\r\n${NPM}\\claude.cmd\r\n`)(child, index)
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res.ok).toBe(true);
		expect(calls[1].command).toBe(`"${NPM}\\claude.cmd" "mcp" "get" "vayu"`);
		expect(calls[2].command).toBe(
			`"${NPM}\\claude.cmd" "mcp" "add" "--transport" "http" ` +
				`"--scope" "user" "vayu" "${URL}"`
		);
	});

	it("spawns a native .exe directly, with no shell and an argument array", async () => {
		const EXE = "C:\\Program Files\\Claude\\claude.exe";
		const { spawnImpl, calls } = recorder((call, child, index) =>
			freshClaude(`${EXE}\r\n`)(child, index)
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res.ok).toBe(true);
		expect(calls[2].command).toBe(EXE);
		expect(calls[2].options.shell).toBeUndefined();
		expect(calls[2].args).toEqual([
			"mcp",
			"add",
			"--transport",
			"http",
			"--scope",
			"user",
			"vayu",
			URL,
		]);
	});

	it("resolves a synchronous spawn throw into a failure result, not a rejection", async () => {
		const { spawnImpl } = recorder((call, child, index) => {
			// The resolve probe succeeds; the run throws the way Node's
			// CVE-2024-27980 guard does - synchronously, before any event.
			if (index === 0) finish(child, `${CODE_DIR}\\code.cmd\r\n`);
		});
		const throwingSpawn: SpawnFn = (command, args, options) => {
			if (command === "where") return spawnImpl(command, args, options);
			throw new Error("EINVAL: invalid argument, spawn");
		};

		const res = await connectClient("vscode", URL, throwingSpawn);

		expect(res.ok).toBe(false);
		expect(res.reason).toBe("error");
		expect(res.message).toMatch(/EINVAL/);
	});

	it("reports the CLI as missing when `where` finds nothing", async () => {
		const { spawnImpl, calls } = recorder((call, child) => finish(child, "", 1));

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res).toEqual({ ok: false, reason: "cli-not-found" });
		expect(calls).toHaveLength(1);
	});
});

describe("connectClient on POSIX", () => {
	beforeEach(() => setPlatform("darwin"));

	it("probes the login shell first, since that is what sources the real PATH", async () => {
		process.env.SHELL = "/bin/zsh";
		const { spawnImpl, calls } = recorder((call, child, index) =>
			freshClaude("/opt/homebrew/bin/claude\n")(child, index)
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res.ok).toBe(true);
		expect(calls[0].command).toBe("/bin/zsh");
		expect(calls[0].args).toEqual(["-lc", "command -v claude 2>/dev/null"]);
		// The JSON/URL is never interpolated into a shell string off Windows.
		expect(calls[2].command).toBe("/opt/homebrew/bin/claude");
		expect(calls[2].options.shell).toBeUndefined();
		expect(calls[2].args).toContain(URL);
	});

	it("falls back to /bin/sh when the login shell does not speak -lc", async () => {
		process.env.SHELL = "/usr/local/bin/nu";
		const { spawnImpl, calls } = recorder((call, child, index) => {
			// nushell rejects `-lc` outright: nonzero, nothing on stdout.
			if (index === 0) finish(child, "", 1);
			else finish(child, index === 1 ? "/usr/local/bin/code\n" : "Added.");
		});

		const res = await connectClient("vscode", URL, spawnImpl);

		expect(res.ok).toBe(true);
		expect(calls.map((c) => c.command)).toEqual([
			"/usr/local/bin/nu",
			"/bin/sh",
			"/usr/local/bin/code",
		]);
	});

	it("does not probe twice when the login shell already is /bin/sh", async () => {
		process.env.SHELL = "/bin/sh";
		const { spawnImpl, calls } = recorder((call, child) => finish(child, "", 1));

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res).toEqual({ ok: false, reason: "cli-not-found" });
		expect(calls.map((c) => c.command)).toEqual(["/bin/sh"]);
	});

	it("survives a login shell that is not on disk at all", async () => {
		process.env.SHELL = "/usr/bin/xonsh";
		// The throwing shell never reaches the recorder, so /bin/sh is call 0.
		const { spawnImpl, calls } = recorder((call, child, index) =>
			freshClaude("/usr/bin/claude\n")(child, index)
		);
		const throwingSpawn: SpawnFn = (command, args, options) => {
			if (command === "/usr/bin/xonsh") throw new Error("ENOENT");
			return spawnImpl(command, args, options);
		};

		const res = await connectClient("claude", URL, throwingSpawn);

		expect(res.ok).toBe(true);
		expect(calls[0].command).toBe("/bin/sh");
	});
});

describe("connectClient for claude is idempotent", () => {
	const BIN = "/usr/local/bin/claude";
	const ADD = ["mcp", "add", "--transport", "http", "--scope", "user", "vayu", URL];
	const REMOVE = ["mcp", "remove", "--scope", "user", "vayu"];

	beforeEach(() => setPlatform("darwin"));

	/** `mcp get` prints what the CLI does, wording and scope included; the code reads only the URL. */
	const registered = (url: string) =>
		`vayu:\n  Scope: User config (available in all your projects)\n  Status: Connected\n  Type: http\n  URL: ${url}\n`;

	/** Resolve to BIN, answer `get` with `get`, and every later call with `rest`. */
	function scenario(
		get: (child: FakeChild) => void,
		rest: (child: FakeChild, args: readonly string[]) => void
	) {
		return recorder((call, child, index) => {
			if (index === 0) finish(child, `${BIN}\n`);
			else if (index === 1) get(child);
			else rest(child, call.args);
		});
	}

	it("spawns no add when the same endpoint is already registered", async () => {
		const { spawnImpl, calls } = scenario(
			(child) => finish(child, registered(URL)),
			(child) => finish(child, "unexpected")
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res).toEqual({ ok: true, alreadyConnected: true });
		expect(calls.map((c) => c.args)).toEqual([
			["-lc", "command -v claude 2>/dev/null"],
			["mcp", "get", "vayu"],
		]);
	});

	it("reads the endpoint from stderr too, in case the CLI prints there", async () => {
		const { spawnImpl, calls } = scenario(
			(child) => finish(child, "", 0, registered(URL)),
			(child) => finish(child, "unexpected")
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res).toEqual({ ok: true, alreadyConnected: true });
		expect(calls).toHaveLength(2);
	});

	it("replaces a registration that points elsewhere: remove, then add, in that order", async () => {
		const { spawnImpl, calls } = scenario(
			(child) => finish(child, registered("http://127.0.0.1:9876/mcp")),
			(child) => finish(child, "ok")
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res.ok).toBe(true);
		expect(res.alreadyConnected).toBeUndefined();
		expect(calls.slice(1).map((c) => c.args)).toEqual([["mcp", "get", "vayu"], REMOVE, ADD]);
	});

	it.each([
		["a longer port", "http://127.0.0.1:98770/mcp"],
		["a longer path", "http://127.0.0.1:9877/mcp2"],
		["a deeper path", "http://127.0.0.1:9877/mcp/extra"],
		["a prefixed host", "http://x127.0.0.1:9877/mcp"],
	])("does not count %s as the same endpoint", async (_label, other) => {
		const { spawnImpl, calls } = scenario(
			(child) => finish(child, registered(other)),
			(child) => finish(child, "ok")
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res.alreadyConnected).toBeUndefined();
		expect(calls.slice(2).map((c) => c.args)).toEqual([REMOVE, ADD]);
	});

	it("adds once, with no remove, when `get` fails", async () => {
		const { spawnImpl, calls } = scenario(
			(child) => finish(child, "", 1, "No MCP server found with name: vayu"),
			(child) => finish(child, "Added vayu.")
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res).toEqual({ ok: true, message: "Added vayu." });
		expect(calls.slice(1).map((c) => c.args)).toEqual([["mcp", "get", "vayu"], ADD]);
	});

	it("says the earlier registration is gone when the add fails after a remove", async () => {
		const { spawnImpl } = scenario(
			(child) => finish(child, registered("http://127.0.0.1:9876/mcp")),
			(child, args) =>
				args[1] === "remove"
					? finish(child, "Removed.")
					: finish(child, "", 1, "add refused")
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res.ok).toBe(false);
		expect(res.reason).toBe("error");
		expect(res.message).toContain("add refused");
		expect(res.message).toMatch(/earlier Vayu registration was removed/);
	});

	it("does not claim a removal when the remove itself failed", async () => {
		const { spawnImpl } = scenario(
			(child) => finish(child, registered("http://127.0.0.1:9876/mcp")),
			(child, args) =>
				args[1] === "remove"
					? finish(child, "", 1, "No user-scoped server")
					: finish(child, "", 1, "add refused")
		);

		const res = await connectClient("claude", URL, spawnImpl);

		expect(res.ok).toBe(false);
		expect(res.message).toBe("add refused");
	});
});

describe("connectClient rejects an unknown client", () => {
	it("names the client rather than spawning anything", async () => {
		const { spawnImpl, calls } = recorder((call, child) => finish(child, ""));

		const res = await connectClient(
			"cursor" as Parameters<typeof connectClient>[0],
			URL,
			spawnImpl
		);

		expect(res).toMatchObject({ ok: false, reason: "unsupported" });
		expect(res.message).toContain("cursor");
		expect(calls).toHaveLength(0);
	});
});
