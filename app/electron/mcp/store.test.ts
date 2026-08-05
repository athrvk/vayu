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
 * unless told otherwise, and this store is first touched by main.ts's `startMcp`
 * during startup. A corrupt mcp-config.json therefore rejected the `whenReady`
 * handler before it ever reached `createWindow()`: no window, on every launch,
 * with the engine sidecar already running headless behind it.
 *
 * These drive the real electron-store against a temp userData directory rather
 * than a mock, because the defect is in what the library does with a file we
 * hand it - a mocked store would have "passed" against the bug. `electron`
 * itself is faked, since that is the part vitest cannot provide.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
	// electron-store reaches for the default export.
	return { ...api, default: api };
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
	 * Syntactically valid but wrong-shaped: clearInvalidConfig cannot see this,
	 * only the sanitizer can, so it is the half of the guard that does not move
	 * when the flag does.
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
		const start = main.indexOf("app.whenReady()");
		const end = main.indexOf('app.on("window-all-closed"', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return main.slice(start, end);
	}

	/** The body of `startMcp`, up to the next top-level function. */
	function startMcpBody(): string {
		const start = main.indexOf("async function startMcp()");
		const end = main.indexOf("async function stopMcp()", start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		return main.slice(start, end);
	}

	it("creates the window before starting MCP", () => {
		const body = whenReadyBody();
		const window = body.indexOf("createWindow();");
		const mcp = body.indexOf("await startMcp();");

		expect(window).toBeGreaterThan(-1);
		expect(mcp).toBeGreaterThan(-1);
		expect(window).toBeLessThan(mcp);
	});

	it("reads the enabled preference inside startMcp's try, not ahead of it", () => {
		const body = startMcpBody();
		const guard = body.indexOf("try {");
		const read = body.indexOf("loadMcpEnabled()");

		expect(guard).toBeGreaterThan(-1);
		expect(read).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(read);
	});
});
