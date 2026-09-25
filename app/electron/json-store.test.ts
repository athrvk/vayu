/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `createJsonStore` replaced `electron-store` for the main process's three
 * settings files. What it must keep: the file an existing install already has
 * reads as it is, a file it cannot use is an empty store rather than a throw
 * (a store read at startup that threw left the app with no window), and a write
 * never leaves the file half-written. Driven against a real temp directory, for
 * the reason the store's callers' tests give: the defects are in what happens
 * to a file on disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent-userData" } }));

import { createJsonStore } from "./json-store.js";

interface Shape {
	windowState: { width: number; height: number };
	enabled: boolean;
}

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vayu-json-store-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("createJsonStore", () => {
	it("reads the file an electron-store install already wrote", () => {
		// electron-store's own format: a tab-indented object in `<name>.json`.
		writeFileSync(
			join(dir, "window-state.json"),
			JSON.stringify({ windowState: { width: 1200, height: 800 } }, undefined, "\t")
		);
		const store = createJsonStore<Shape>("window-state", () => dir);

		expect(store.get("windowState")).toEqual({ width: 1200, height: 800 });
	});

	it("writes that same format back, keeping the keys it did not touch", () => {
		writeFileSync(join(dir, "mcp-config.json"), JSON.stringify({ enabled: false }));
		const store = createJsonStore<Shape>("mcp-config", () => dir);

		store.set("windowState", { width: 10, height: 20 });

		const raw = readFileSync(join(dir, "mcp-config.json"), "utf8");
		expect(JSON.parse(raw)).toEqual({ enabled: false, windowState: { width: 10, height: 20 } });
		expect(raw).toContain("\n\t");
		expect(createJsonStore<Shape>("mcp-config", () => dir).get("enabled")).toBe(false);
	});

	it.each([
		["corrupt JSON", "{ this is not json"],
		["an array", "[1, 2, 3]"],
		["a bare value", "42"],
		["null", "null"],
	])("reads %s as an empty store rather than throwing", (_label, contents) => {
		writeFileSync(join(dir, "window-state.json"), contents);
		const store = createJsonStore<Shape>("window-state", () => dir);

		expect(store.get("windowState")).toBeUndefined();
		// And a write replaces the unusable file with a usable one.
		store.set("enabled", true);
		expect(JSON.parse(readFileSync(join(dir, "window-state.json"), "utf8"))).toEqual({
			enabled: true,
		});
	});

	it("is an empty store before the first launch has written anything", () => {
		const store = createJsonStore<Shape>("window-state", () => join(dir, "not-yet"));
		expect(store.get("enabled")).toBeUndefined();

		store.set("enabled", true);
		expect(
			createJsonStore<Shape>("window-state", () => join(dir, "not-yet")).get("enabled")
		).toBe(true);
	});

	it("leaves nothing but the file itself after a write", () => {
		// A write is a temp file renamed over the original - the rename, not a
		// truncate-and-write, is what keeps a crash mid-write from leaving a
		// half-written file. What must not survive it is the temp file.
		const store = createJsonStore<Shape>("window-state", () => dir);
		store.set("enabled", true);
		store.set("enabled", false);

		expect(readdirSync(dir)).toEqual(["window-state.json"]);
	});

	it("resolves its directory on first use, not at creation", () => {
		// `window-state.ts` creates its store at module scope, which main.ts
		// imports before anything else runs; creating one must cost nothing.
		const directory = vi.fn(() => dir);
		const store = createJsonStore<Shape>("window-state", directory);
		expect(directory).not.toHaveBeenCalled();

		store.get("enabled");
		store.get("enabled");
		expect(directory).toHaveBeenCalledTimes(1);
	});
});
