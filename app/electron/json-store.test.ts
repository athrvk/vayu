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
 * (a store read at startup that threw left the app with no window), a write
 * never leaves the file half-written, and an unreadable file is kept as a
 * `.corrupt-<ms>` copy before the first write replaces it (#2433). Driven against a real temp directory, for
 * the reason the store's callers' tests give: the defects are in what happens
 * to a file on disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("electron", () => ({ app: { getPath: () => "/nonexistent-userData" } }));

/** Makes the set-aside rename (and only that one) fail, as a locked file would. */
const renameFault = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: (from: string, to: string) => {
			if (renameFault.on && to.includes(".corrupt-")) throw new Error("EBUSY");
			return actual.renameSync(from, to);
		},
	};
});

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
	renameFault.on = false;
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

describe("an unreadable file", () => {
	const copiesIn = (name: string) =>
		readdirSync(dir).filter((entry) => entry.startsWith(`${name}.json.corrupt-`));

	it.each([
		["corrupt JSON", '{ "safety": { "allowlist": ["api.example.com"'],
		["an array", "[1, 2, 3]"],
		["a bare value", "42"],
		["null", "null"],
		["an empty file", ""],
	])(
		"keeps %s as a .corrupt copy on the first set, and the new file parses",
		(_label, contents) => {
			writeFileSync(join(dir, "mcp-config.json"), contents);
			const store = createJsonStore<Shape>("mcp-config", () => dir);

			// Reading never moves it: a user can still repair the file by hand.
			expect(store.get("enabled")).toBeUndefined();
			expect(copiesIn("mcp-config")).toEqual([]);
			expect(store.corruptCopy()).toBeNull();

			store.set("enabled", true);

			const [copy] = copiesIn("mcp-config");
			expect(copiesIn("mcp-config")).toHaveLength(1);
			expect(readFileSync(join(dir, copy), "utf8")).toBe(contents);
			expect(store.corruptCopy()).toBe(join(dir, copy));
			expect(JSON.parse(readFileSync(join(dir, "mcp-config.json"), "utf8"))).toEqual({
				enabled: true,
			});
		}
	);

	it("renames it once: a second set leaves the copy and the new file alone", () => {
		writeFileSync(join(dir, "mcp-config.json"), "{ nope");
		const store = createJsonStore<Shape>("mcp-config", () => dir);
		store.set("enabled", true);
		const [copy] = copiesIn("mcp-config");

		store.set("enabled", false);

		expect(copiesIn("mcp-config")).toEqual([copy]);
		expect(readFileSync(join(dir, copy), "utf8")).toBe("{ nope");
		expect(JSON.parse(readFileSync(join(dir, "mcp-config.json"), "utf8"))).toEqual({
			enabled: false,
		});
	});

	it("keeps one copy: a later corruption replaces the earlier one", () => {
		writeFileSync(join(dir, "mcp-config.json.corrupt-1"), "the first corruption");
		writeFileSync(join(dir, "mcp-config.json"), "the second corruption");
		const store = createJsonStore<Shape>("mcp-config", () => dir);

		store.set("enabled", true);

		const copies = copiesIn("mcp-config");
		expect(copies).toHaveLength(1);
		expect(copies).not.toContain("mcp-config.json.corrupt-1");
		expect(readFileSync(join(dir, copies[0]), "utf8")).toBe("the second corruption");
	});

	it("leaves another store's copy alone", () => {
		writeFileSync(join(dir, "window-state.json.corrupt-1"), "window geometry");
		writeFileSync(join(dir, "mcp-config.json"), "{ nope");

		createJsonStore<Shape>("mcp-config", () => dir).set("enabled", true);

		expect(copiesIn("window-state")).toEqual(["window-state.json.corrupt-1"]);
	});

	it("logs the copy it kept", () => {
		writeFileSync(join(dir, "mcp-config.json"), "{ nope");
		const log = vi.fn();
		const store = createJsonStore<Shape>("mcp-config", () => dir, log);

		store.set("enabled", true);

		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("kept"), {
			file: join(dir, "mcp-config.json"),
			copy: store.corruptCopy(),
		});
	});

	it("still writes, and reports no copy, when the rename fails", () => {
		writeFileSync(join(dir, "mcp-config.json"), "{ nope");
		const log = vi.fn();
		const store = createJsonStore<Shape>("mcp-config", () => dir, log);
		renameFault.on = true;

		store.set("enabled", true);

		expect(store.corruptCopy()).toBeNull();
		expect(copiesIn("mcp-config")).toEqual([]);
		expect(JSON.parse(readFileSync(join(dir, "mcp-config.json"), "utf8"))).toEqual({
			enabled: true,
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("could not keep"),
			expect.objectContaining({ file: join(dir, "mcp-config.json") })
		);
	});

	it("never renames a file it could read, or one that does not exist yet", () => {
		writeFileSync(join(dir, "mcp-config.json"), JSON.stringify({ enabled: false }));
		const valid = createJsonStore<Shape>("mcp-config", () => dir);
		const fresh = createJsonStore<Shape>("window-state", () => dir);

		valid.set("enabled", true);
		valid.set("enabled", false);
		fresh.set("enabled", true);
		fresh.set("enabled", false);

		expect(readdirSync(dir).sort()).toEqual(["mcp-config.json", "window-state.json"]);
		expect(valid.corruptCopy()).toBeNull();
		expect(fresh.corruptCopy()).toBeNull();
	});
});
