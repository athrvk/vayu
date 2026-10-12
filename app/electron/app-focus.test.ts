/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main process's copy of what the renderer has open (issue #2045): what a
 * published payload may put in it, and that the channel between the renderer
 * and the MCP server is wired end to end.
 */

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

import { AppFocusStore, FOCUS_TAB_TYPES, normalizeAppFocus } from "./app-focus.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const RUN_FOCUS = {
	activeTab: { type: "run", entityId: "run_1", label: "Design run" },
	activeEnvironment: { id: "env_1", name: "Staging" },
};

describe("normalizeAppFocus", () => {
	it("round-trips a valid snapshot", () => {
		expect(normalizeAppFocus(RUN_FOCUS)).toEqual(RUN_FOCUS);
	});

	it("keeps a singleton tab, whose entity id is null", () => {
		const focus = normalizeAppFocus({
			activeTab: { type: "settings", entityId: null, label: "Settings" },
			activeEnvironment: null,
		});
		expect(focus?.activeTab).toEqual({ type: "settings", entityId: null, label: "Settings" });
	});

	it("rebuilds field by field, so an extra key never survives", () => {
		const focus = normalizeAppFocus({
			activeTab: { ...RUN_FOCUS.activeTab, url: "https://x/?token=s3cret" },
			activeEnvironment: { ...RUN_FOCUS.activeEnvironment, variables: { token: "s3cret" } },
			variables: { token: "s3cret" },
		});
		expect(focus).toEqual(RUN_FOCUS);
		expect(JSON.stringify(focus)).not.toContain("s3cret");
	});

	it.each([
		["an unknown tab type", { type: "terminal", entityId: "x", label: "x" }],
		["a non-string entity id", { type: "run", entityId: 7, label: "x" }],
		["an empty entity id", { type: "run", entityId: "", label: "x" }],
		["an over-long entity id", { type: "run", entityId: "r".repeat(300), label: "x" }],
		["a non-string label", { type: "run", entityId: "run_1", label: { text: "x" } }],
		["null", null],
		["a string", "run_1"],
	])("drops a tab with %s", (_label, activeTab) => {
		const focus = normalizeAppFocus({ ...RUN_FOCUS, activeTab });
		expect(focus?.activeTab).toBeNull();
		expect(focus?.activeEnvironment).toEqual(RUN_FOCUS.activeEnvironment);
	});

	it.each([
		["a missing name", { id: "env_1" }],
		["a non-string id", { id: 1, name: "Staging" }],
		["an array", ["env_1", "Staging"]],
	])("drops an environment with %s", (_label, activeEnvironment) => {
		const focus = normalizeAppFocus({ ...RUN_FOCUS, activeEnvironment });
		expect(focus?.activeEnvironment).toBeNull();
		expect(focus?.activeTab).toEqual(RUN_FOCUS.activeTab);
	});

	it("caps a label at its length limit rather than repeating it whole", () => {
		const focus = normalizeAppFocus({
			...RUN_FOCUS,
			activeTab: { ...RUN_FOCUS.activeTab, label: "x".repeat(5000) },
		});
		expect(focus?.activeTab?.label).toHaveLength(256);
	});

	it.each([[null], [undefined], [[]], ["focus"], [{}], [{ activeTab: null }], [{ extra: 1 }]])(
		"answers undefined for a payload of %j",
		(payload) => {
			expect(normalizeAppFocus(payload)).toBeUndefined();
		}
	);
});

describe("FOCUS_TAB_TYPES", () => {
	it("names exactly the renderer's tab types", () => {
		const source = readFileSync(path.join(here, "../src/stores/tabs-store.ts"), "utf8");
		const union = /export type TabType =([^;]+);/.exec(source)?.[1] ?? "";
		const declared = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
		// An empty match would make the equality below trivially about nothing.
		expect(declared.length).toBeGreaterThan(0);
		expect([...FOCUS_TAB_TYPES].sort()).toEqual(declared.sort());
	});
});

describe("AppFocusStore", () => {
	it("is empty until a window publishes", () => {
		expect(new AppFocusStore().get()).toBeUndefined();
	});

	it("replaces the whole copy, and a malformed publish empties it", () => {
		const store = new AppFocusStore();
		store.replace(RUN_FOCUS);
		expect(store.get()).toEqual(RUN_FOCUS);
		store.replace({ activeTab: null, activeEnvironment: null });
		expect(store.get()).toEqual({ activeTab: null, activeEnvironment: null });
		store.replace("garbage");
		expect(store.get()).toBeUndefined();
	});
});

describe("the wiring", () => {
	const main = readFileSync(path.join(here, "main.ts"), "utf8");
	const preload = readFileSync(path.join(here, "preload.ts"), "utf8");

	it("sends and receives on the same channel", () => {
		expect(preload).toContain('ipcRenderer.send("app:focus"');
		expect(main).toContain('ipcMain.on("app:focus"');
	});

	it("hands the copy to the MCP service, which is its only reader", () => {
		// Written but never read: a snapshot main holds and no MCP context is
		// given is a focus no agent ever sees.
		expect(main).toContain("appFocus: () => appFocus.get()");
	});

	it("is mounted in the app, which is its only writer", () => {
		const app = readFileSync(path.join(here, "../src/App.tsx"), "utf8");
		expect(app).toContain("useAppFocusMirror();");
	});
});
