/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * An optional subsystem's config file must never be able to stop the app from
 * starting - the same rule window-state.ts is held to, for a worse blast radius.
 *
 * conf parses the file inside the Store constructor and rethrows a SyntaxError
 * unless told otherwise, and this store is first touched by the MCP lifecycle's
 * start during startup. A corrupt mcp-config.json therefore rejected the `whenReady`
 * handler before it ever reached `createWindow()`: no window, on every launch,
 * with the engine sidecar already running headless behind it.
 *
 * These drive the real store (`json-store.ts`) against a temp userData directory rather
 * than a mock, because the defect is in what the library does with a file we
 * hand it - a mocked store would have "passed" against the bug. `electron`
 * itself is faked, since that is the part vitest cannot provide.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_PORT } from "../constants.js";
import { DEFAULT_MCP_SAFETY_CONFIG } from "./config.js";

/** Mutable because the mock is hoisted above every test that retargets it. */
const fake = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => {
	const api = {
		app: {
			getPath: () => fake.userData,
			getVersion: () => "0.0.0-test",
		},
		ipcMain: { on: () => {} },
		shell: { openPath: async () => "" },
	};
	return api;
});

/** Seed the userData directory the next import will read, with raw file bytes. */
function seedStore(contents?: string): void {
	fake.userData = mkdtempSync(join(tmpdir(), "vayu-mcp-config-"));
	mkdirSync(fake.userData, { recursive: true });
	if (contents !== undefined) {
		writeFileSync(join(fake.userData, "mcp-config.json"), contents);
	}
}

function storeFile(): string {
	return readFileSync(join(fake.userData, "mcp-config.json"), "utf8");
}

/**
 * A fresh module instance, so the module's lazily-built `new Store(...)` runs
 * against the directory just seeded rather than reusing a cached store.
 */
async function importStore() {
	vi.resetModules();
	return import("./store.js");
}

afterEach(() => {
	if (fake.userData) rmSync(fake.userData, { recursive: true, force: true });
	fake.userData = "";
});

describe("a corrupt mcp-config.json", () => {
	it.each([
		["truncated JSON", '{"enabled": tr'],
		["not JSON at all", "this is not json at all"],
		["an empty file", ""],
	])("still resolves the default safety config when the file is %s", async (_label, contents) => {
		seedStore(contents);

		const { loadPersistedSafety } = await importStore();

		expect(loadPersistedSafety()).toEqual(DEFAULT_MCP_SAFETY_CONFIG);
	});

	it("leaves the server enabled rather than throwing on the preference read", async () => {
		seedStore('{"enabled": fal');

		const { loadMcpEnabled } = await importStore();

		expect(loadMcpEnabled()).toBe(true);
	});

	it("is replaced by a valid file on the next save", async () => {
		seedStore('{"safety": {"maxRps": 5');

		const { savePersistedSafety, loadPersistedSafety } = await importStore();
		savePersistedSafety({ ...DEFAULT_MCP_SAFETY_CONFIG, maxRps: 42 });

		expect(JSON.parse(storeFile())).toEqual({
			safety: { ...DEFAULT_MCP_SAFETY_CONFIG, maxRps: 42 },
		});
		expect(loadPersistedSafety().maxRps).toBe(42);
	});
});

describe("the copy of an unreadable mcp-config.json (#2433)", () => {
	it("is kept beside the new file by the first save, and reported", async () => {
		seedStore('{"safety": {"allowlist": ["api.example.com"');
		const { savePersistedSafety, mcpConfigCorruptCopy } = await importStore();
		expect(mcpConfigCorruptCopy()).toBeNull();

		savePersistedSafety({ ...DEFAULT_MCP_SAFETY_CONFIG, maxRps: 42 });

		const [kept] = readdirSync(fake.userData).filter((f) => f.includes(".corrupt-"));
		expect(mcpConfigCorruptCopy()).toBe(join(fake.userData, kept));
		expect(readFileSync(join(fake.userData, kept), "utf8")).toBe(
			'{"safety": {"allowlist": ["api.example.com"'
		);
		expect(JSON.parse(storeFile()).safety.maxRps).toBe(42);
	});

	it("is not made, or reported, for a readable file", async () => {
		seedStore(JSON.stringify({ enabled: false }));
		const { savePersistedSafety, mcpConfigCorruptCopy } = await importStore();

		savePersistedSafety({ ...DEFAULT_MCP_SAFETY_CONFIG, maxRps: 42 });

		expect(mcpConfigCorruptCopy()).toBeNull();
		expect(readdirSync(fake.userData).filter((f) => f.includes(".corrupt-"))).toEqual([]);
	});
});

describe("a readable mcp-config.json", () => {
	it("is not discarded - a saved override survives", async () => {
		seedStore(
			JSON.stringify({
				safety: {
					...DEFAULT_MCP_SAFETY_CONFIG,
					allowlist: ["api.example.com"],
					maxRps: 25,
				},
				enabled: false,
			})
		);

		const { loadPersistedSafety, loadMcpEnabled } = await importStore();

		expect(loadPersistedSafety()).toMatchObject({
			allowlist: ["api.example.com"],
			maxRps: 25,
		});
		expect(loadMcpEnabled()).toBe(false);
	});

	/*
	 * Syntactically valid but wrong-shaped: the store's empty-on-unreadable rule
	 * cannot see this, only the sanitizer can, so it is the half of the guard that
	 * does not move when the store does.
	 */
	it.each([
		["a string cap", { maxRps: "abc" }],
		["a negative cap", { maxRps: -5 }],
		["a non-array allowlist", { allowlist: "api.example.com" }],
		["a null safety block", null],
	])("falls back to the defaults for %s", async (_label, safety) => {
		seedStore(JSON.stringify({ safety }));

		const { loadPersistedSafety } = await importStore();

		expect(loadPersistedSafety()).toEqual(DEFAULT_MCP_SAFETY_CONFIG);
	});

	it("coerces a non-boolean enabled to on", async () => {
		seedStore(JSON.stringify({ enabled: "yes" }));

		const { loadMcpEnabled } = await importStore();

		expect(loadMcpEnabled()).toBe(true);
	});
});

/*
 * #3580: the MCP port is configurable, and the engine refuses to start on an
 * `--mcp-port` equal to its own `--port`. So the store refuses the engine's
 * candidates and anything that is not an unprivileged port, on write and again
 * on read, since the file is hand-editable. Mutation check: drop the candidate
 * check in `validateMcpPort` and 9885 is accepted.
 */
describe("the MCP port", () => {
	const REFUSED: Array<[string, unknown, RegExp]> = [
		["a privileged port", 80, /between 1024 and 65535/],
		["the engine's default port", 9876, /reserved for Vayu's engine/],
		["an engine fallback port", 9885, /reserved for Vayu's engine/],
		["a port past the range", 70000, /between 1024 and 65535/],
		["a fraction", 9877.5, /whole number/],
		["a numeric string", "9877", /whole number/],
		["null", null, /whole number/],
	];

	it("is the default on a fresh install, with nothing to report", async () => {
		seedStore();
		const { readMcpPort } = await importStore();

		expect(readMcpPort()).toEqual({ port: MCP_PORT, storedError: null });
	});

	it.each([
		["the default", MCP_PORT],
		["another free port", 19_877],
		["the bottom of the range", 1024],
		["the top of the range", 65535],
	])("persists %s", async (_label, port) => {
		seedStore();
		const { saveMcpPort, readMcpPort } = await importStore();

		expect(saveMcpPort(port)).toEqual({ ok: true, port });

		expect(JSON.parse(storeFile()).port).toBe(port);
		expect(readMcpPort()).toEqual({ port, storedError: null });
	});

	it.each(REFUSED)("refuses %s on write, and keeps what was saved", async (_l, value, reason) => {
		seedStore(JSON.stringify({ port: 19_877 }));
		const { saveMcpPort, readMcpPort } = await importStore();

		const verdict = saveMcpPort(value);

		expect(verdict.ok).toBe(false);
		expect(verdict.ok ? "" : verdict.message).toMatch(reason);
		expect(JSON.parse(storeFile()).port).toBe(19_877);
		expect(readMcpPort().port).toBe(19_877);
	});

	it.each(REFUSED)(
		"reads %s stored by hand back as the default, and says so",
		async (_l, value) => {
			seedStore(JSON.stringify({ port: value }));
			const { readMcpPort } = await importStore();

			const reading = readMcpPort();

			expect(reading.port).toBe(MCP_PORT);
			expect(reading.storedError).toContain(JSON.stringify(value));
			expect(reading.storedError).toContain(String(MCP_PORT));
		}
	);

	it("reads an unreadable file as the default, leaving the report to corruptCopy", async () => {
		seedStore('{"port": 198');
		const { readMcpPort } = await importStore();

		expect(readMcpPort()).toEqual({ port: MCP_PORT, storedError: null });
	});
});

/*
 * What Settings is shown when the server is not running. Reverting the fallback
 * to DEFAULT_MCP_SAFETY_CONFIG turns the first two of these red, which is the
 * whole point: the panel commits whole fields computed from what it displays,
 * so defaults shown here become defaults persisted on the next edit.
 */
describe("effectiveSafety", () => {
	const persisted = {
		...DEFAULT_MCP_SAFETY_CONFIG,
		allowlist: ["api.example.com", "internal.test"],
		maxRps: 25,
		disabledTools: ["start_load_run"],
	};

	it.each([
		["null", null],
		["undefined", undefined],
	])(
		"returns the persisted config, not the defaults, when the service is %s",
		async (_l, svc) => {
			seedStore(JSON.stringify({ safety: persisted }));

			const { effectiveSafety } = await importStore();

			expect(effectiveSafety(svc)).toEqual(persisted);
			expect(effectiveSafety(svc)).not.toEqual(DEFAULT_MCP_SAFETY_CONFIG);
		}
	);

	it("prefers the running server's live config over the persisted one", async () => {
		seedStore(JSON.stringify({ safety: persisted }));
		const live = { ...DEFAULT_MCP_SAFETY_CONFIG, allowlist: ["live.example.com"] };

		const { effectiveSafety } = await importStore();

		expect(effectiveSafety({ getSafety: () => live })).toEqual(live);
	});

	it("still resolves the defaults when nothing has been persisted", async () => {
		seedStore();

		const { effectiveSafety } = await importStore();

		expect(effectiveSafety(null)).toEqual(DEFAULT_MCP_SAFETY_CONFIG);
	});
});

/*
 * main.ts creates windows and starts the engine at import time, so the startup
 * ordering it encodes can only be read - the same constraint (and the same
 * remedy) as renderer-recovery.test.ts.
 */
describe("main.ts startup ordering", () => {
	const main = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "..", "main.ts"),
		"utf8"
	);

	/** The `app.whenReady()` handler body, up to the first listener after it. */
	function whenReadyBody(): string {
		const start = main.indexOf("app.whenReady().then(");
		const end = main.indexOf('app.on("window-all-closed"', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return main.slice(start, end);
	}

	/** The `createMcpLifecycle({...})` call, up to the status helper after it. */
	function lifecycleWiring(): string {
		const start = main.indexOf("createMcpLifecycle<");
		const end = main.indexOf("function currentMcpStatus(", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return main.slice(start, end);
	}

	it("creates the window before starting MCP", () => {
		const body = whenReadyBody();
		const window = body.indexOf("createWindow();");
		const mcp = body.indexOf("await mcpLifecycle.start();");

		expect(window).toBeGreaterThan(-1);
		expect(mcp).toBeGreaterThan(-1);
		expect(window).toBeLessThan(mcp);
	});

	/*
	 * The lifecycle reads `isEnabled` inside its own guard and records a throw
	 * as a failed start (lifecycle.test.ts). That only protects launch if the
	 * store read is what it is handed, and if launch does not read it first.
	 */
	it("leaves the enabled preference to the lifecycle's guarded start", () => {
		expect(lifecycleWiring()).toContain("isEnabled: loadMcpEnabled,");
		expect(whenReadyBody()).not.toContain("loadMcpEnabled(");
	});

	/*
	 * The helper above only matters if the handler calls it, and nothing else can
	 * observe that: main.ts cannot be imported. Scanned rather than executed, so
	 * the slice is asserted non-empty first.
	 */
	it("answers mcp:getSafety through effectiveSafety, not the bare defaults", () => {
		const start = main.indexOf('ipcMain.handle("mcp:getSafety"');
		const end = main.indexOf('ipcMain.handle("mcp:getTools"', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const body = main.slice(start, end);

		expect(body).toContain("effectiveSafety(mcpLifecycle.service())");
		expect(body).not.toContain("DEFAULT_MCP_SAFETY_CONFIG");
	});

	/*
	 * #3580. The listener binds the port the running engine guards, never the
	 * constant, and a restart moves it there. Mutation check: drop the
	 * `followEndpoint` call from `restartEngine`, or bind `MCP_PORT` again, and
	 * this reds.
	 */
	it("binds the engine's MCP port and moves onto it after an engine restart", () => {
		const wiring = lifecycleWiring();
		expect(wiring).toContain("endpoint: () => ({ host: MCP_HOST, port: mcpEnginePort() }),");
		expect(wiring).toContain("new McpListener({ ...endpoint,");
		expect(main).not.toMatch(/\bMCP_PORT\b/);

		const start = main.indexOf("async function restartEngine()");
		const end = main.indexOf("\n}\n", start);
		expect(start).toBeGreaterThan(-1);
		const body = main.slice(start, end);
		const restartAt = body.indexOf("await engineSidecar.restart();");
		const followAt = body.indexOf("await mcpLifecycle.followEndpoint();");
		expect(restartAt).toBeGreaterThan(-1);
		expect(followAt).toBeGreaterThan(restartAt);
		expect(body.slice(body.indexOf("} finally {"))).toContain(
			"await mcpLifecycle.followEndpoint();"
		);
	});

	it("saves mcp:setPort through the validating store and answers with the status", () => {
		const start = main.indexOf('ipcMain.handle("mcp:setPort"');
		const end = main.indexOf("});", start);
		expect(start).toBeGreaterThan(-1);
		const body = main.slice(start, end);

		expect(body).toContain("saveMcpPort(port)");
		expect(body).toContain("currentMcpStatus(");
		// Persist only: the listener moves with the engine, not with the save.
		expect(body).not.toContain("mcpLifecycle.");

		const preload = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "..", "preload.ts"),
			"utf8"
		);
		expect(preload).toContain(
			'setMcpPort: (port: number) => ipcRenderer.invoke("mcp:setPort", port),'
		);
	});
});
