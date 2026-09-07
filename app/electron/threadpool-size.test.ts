/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const electronDir = path.dirname(fileURLToPath(import.meta.url));

describe("threadpool size", () => {
	const inherited = process.env.UV_THREADPOOL_SIZE;

	beforeEach(() => {
		// The module runs once per import; a fresh registry lets each case see it run.
		vi.resetModules();
		delete process.env.UV_THREADPOOL_SIZE;
	});

	afterEach(() => {
		if (inherited === undefined) delete process.env.UV_THREADPOOL_SIZE;
		else process.env.UV_THREADPOOL_SIZE = inherited;
	});

	it("sizes the pool to one worker when nothing else did", async () => {
		await import("./threadpool-size.js");
		expect(process.env.UV_THREADPOOL_SIZE).toBe("1");
	});

	it("leaves a size the environment already carries", async () => {
		process.env.UV_THREADPOOL_SIZE = "3";
		await import("./threadpool-size.js");
		expect(process.env.UV_THREADPOOL_SIZE).toBe("3");
	});

	// libuv reads the variable once, at the pool's first use, and a module that
	// touches the filesystem while loading would fix the size before a later
	// import could set it. So the position is the guarantee, not the value.
	it("is main.ts's first import", () => {
		const main = readFileSync(path.join(electronDir, "main.ts"), "utf8");
		const firstImport = main.split("\n").find((line) => /^import\b/.test(line));
		expect(firstImport).toBe('import "./threadpool-size.js";');
	});
});
