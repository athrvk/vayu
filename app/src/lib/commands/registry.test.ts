/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The registry's guards.
 *
 * Three things can go wrong with a registry nobody renders in a test: an entry
 * that says nothing (no title, no keywords), an entry that does nothing
 * (`perform` pointing at a surface the caller cannot open), and a roster that
 * has quietly stopped covering what it generates from. Each has a test here.
 *
 * jsdom because a `perform` reaches the real stores, and the tabs store
 * persists - a node environment has no `localStorage` for it to seed from.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { COMMANDS, availableCommands, commandById } from "./registry";
import { baseCommandContext } from "./context";
import { commandTitle, type Command, type CommandContext, type CommandSurfaces } from "./types";
import { useImportModalStore, useTabsStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";
import type { Collection } from "@/types";

const COLLECTION: Collection = { id: "c1", name: "Payments" } as Collection;

function surfaces(): CommandSurfaces {
	return { newRequest: () => {}, runCollection: () => {}, toggleThemeMode: () => {} };
}

/** A context with a host and a collection open - everything is available. */
function fullContext(): CommandContext {
	return {
		activeTab: { id: "t1", type: "collection", entityId: "c1" },
		activeTabLabel: "Payments",
		activeCollection: COLLECTION,
		surfaces: surfaces(),
	};
}

/**
 * The rule every entry has to satisfy. Written as a predicate rather than
 * inline assertions so the same rule can be turned on a deliberately broken
 * command below - a walk that only ever sees good data proves nothing.
 */
function isWellFormed(command: Command, ctx: CommandContext): boolean {
	return (
		command.id.trim() !== "" &&
		commandTitle(command, ctx).trim() !== "" &&
		command.keywords.length > 0 &&
		command.keywords.every((keyword) => keyword.trim() !== "") &&
		typeof command.perform === "function"
	);
}

beforeEach(() => {
	useTabsStore.setState({ openTabs: [], activeTabId: null, tabFocusedAt: {} });
	useSettingsStore.setState({ selectedCategory: "appearance", highlightedKey: null });
	useImportModalStore.setState({ isOpen: false });
});

describe("the roster", () => {
	it("walks something, and every entry says what it is", () => {
		// The scanned-something-non-empty rule: a walk over an empty array is a
		// green test that checked nothing.
		expect(COMMANDS.length).toBeGreaterThan(10);
		const ctx = fullContext();
		for (const command of COMMANDS) {
			expect(isWellFormed(command, ctx), `command "${command.id}"`).toBe(true);
		}
	});

	it("rejects an entry with a blank title or no keywords", () => {
		const ctx = fullContext();
		const [good] = COMMANDS;
		expect(isWellFormed({ ...good, title: "   " }, ctx)).toBe(false);
		expect(isWellFormed({ ...good, title: () => "" }, ctx)).toBe(false);
		expect(isWellFormed({ ...good, keywords: [] }, ctx)).toBe(false);
		expect(isWellFormed({ ...good, id: "" }, ctx)).toBe(false);
	});

	it("gives every entry a unique id", () => {
		const ids = COMMANDS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("covers every settings section the sidebar renders", () => {
		const ids = new Set(COMMANDS.map((c) => c.id));
		for (const panel of APP_SETTINGS_PANELS) {
			expect(ids.has(`settings:${panel.id}`), panel.label).toBe(true);
		}
		for (const category of ENGINE_SETTINGS_CATEGORIES) {
			expect(ids.has(`settings:${category.id}`), category.label).toBe(true);
		}
	});
});

describe("availability", () => {
	it("hides everything that needs a host the caller has not offered", () => {
		const ids = availableCommands(baseCommandContext()).map((c) => c.id);
		expect(ids).not.toContain("new-request");
		expect(ids).not.toContain("run-collection");
		expect(ids).not.toContain("toggle-theme");
		// Nothing is open, so there is no tab to close either.
		expect(ids).not.toContain("close-tab");
		// These two need only stores, so the menu bridge can offer them.
		expect(ids).toContain("open-settings");
		expect(ids).toContain("import-collection");
	});

	it("hides the collection command until a collection tab is open", () => {
		const withHost: CommandContext = {
			activeTab: null,
			activeTabLabel: null,
			activeCollection: null,
			surfaces: surfaces(),
		};
		expect(availableCommands(withHost).map((c) => c.id)).not.toContain("run-collection");
		expect(availableCommands(fullContext()).map((c) => c.id)).toContain("run-collection");
	});

	it("names the target of a contextual command, so Enter holds no surprise", () => {
		const ctx = fullContext();
		expect(commandTitle(commandById("run-collection"), ctx)).toBe('Run "Payments"');
		expect(commandTitle(commandById("close-tab"), ctx)).toBe('Close "Payments"');
	});

	it("falls back to a generic close title when nothing knows the label", () => {
		const ctx: CommandContext = {
			activeTab: { id: "t1", type: "request", entityId: "r1" },
			activeTabLabel: null,
			activeCollection: null,
		};
		expect(commandTitle(commandById("close-tab"), ctx)).toBe("Close tab");
	});
});

describe("performing", () => {
	it("opens the settings tab, the way the menu's Preferences… item does", () => {
		commandById("open-settings").perform(baseCommandContext());
		expect(useTabsStore.getState().openTabs).toHaveLength(1);
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ type: "settings" });
	});

	it("reveals a settings section by selecting it before opening the tab", () => {
		commandById("settings:mcp").perform(baseCommandContext());
		expect(useSettingsStore.getState().selectedCategory).toBe("mcp");
		expect(useTabsStore.getState().openTabs[0]).toMatchObject({ type: "settings" });
	});

	it("reveals an engine category through the same command shape", () => {
		commandById("settings:database_performance").perform(baseCommandContext());
		expect(useSettingsStore.getState().selectedCategory).toBe("database_performance");
	});

	it("opens the import modal through its store, not a copy of it", () => {
		commandById("import-collection").perform(baseCommandContext());
		expect(useImportModalStore.getState().isOpen).toBe(true);
	});

	it("closes the active tab", () => {
		useTabsStore.getState().openTab({ type: "settings", entityId: null });
		const ctx = baseCommandContext();
		expect(ctx.activeTab).not.toBeNull();

		commandById("close-tab").perform(ctx);
		expect(useTabsStore.getState().openTabs).toHaveLength(0);
	});

	it("hands the collection to the host rather than running it itself", () => {
		const runs: Collection[] = [];
		const ctx: CommandContext = {
			...fullContext(),
			surfaces: { ...surfaces(), runCollection: (c) => runs.push(c) },
		};
		commandById("run-collection").perform(ctx);
		expect(runs).toEqual([COLLECTION]);
	});
});

describe("commandById", () => {
	it("throws on an id nothing declares, so a dead menu item cannot be silent", () => {
		expect(() => commandById("open-the-pod-bay-doors")).toThrow(/Unknown command id/);
	});
});
