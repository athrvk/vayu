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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { COMMANDS, availableCommands, commandById } from "./registry";
import { baseCommandContext } from "./context";
import { commandTitle, type Command, type CommandContext, type CommandSurfaces } from "./types";
import { SEND_CHORD, TOGGLE_DRAWER_CHORD } from "@/constants/shortcuts";
import { useImportModalStore, useTabsStore, useSaveStore } from "@/stores";
import { useSettingsStore } from "@/modules/settings/settings-store";
import { APP_SETTINGS_PANELS } from "@/modules/settings/main/app-panels";
import { ENGINE_SETTINGS_CATEGORIES } from "@/modules/settings/engine-categories";
import { runExportActions, type RunExportAction } from "@/lib/run-export-formats";
import type { Collection } from "@/types";

const COLLECTION: Collection = { id: "c1", name: "Payments" } as Collection;
const PAYMENTS_REFERENCE = 'Vayu collection "Payments" (c1)';

function surfaces(): CommandSurfaces {
	return {
		newRequest: () => {},
		runCollection: () => {},
		toggleThemeMode: () => {},
		copy: async () => {},
	};
}

/** A context with a host and a collection open - everything is available. */
function fullContext(): CommandContext {
	return {
		activeTab: { id: "t1", type: "collection", entityId: "c1" },
		activeTabLabel: "Payments",
		activeTabReference: PAYMENTS_REFERENCE,
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
	useSaveStore.setState({ contexts: new Map() });
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
		expect(ids).not.toContain("run-load-test");
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
			activeTabReference: null,
			activeCollection: null,
			surfaces: surfaces(),
		};
		expect(availableCommands(withHost).map((c) => c.id)).not.toContain("run-collection");
		expect(availableCommands(fullContext()).map((c) => c.id)).toContain("run-collection");
	});

	/*
	 * The load-test command is the one entry a host cannot satisfy by mounting a
	 * dialog: it needs the request builder's live draft, contributed while that
	 * builder is on screen. So a palette host offering everything it *owns* is
	 * still not enough - which is the mount race, tested here as a state rather
	 * than as a timing.
	 */
	it("hides the load-test command until a mounted builder contributes it", () => {
		const requestTab: CommandContext = {
			activeTab: { id: "t1", type: "request", entityId: "r1" },
			activeTabLabel: "Charge card",
			activeTabReference: null,
			activeCollection: null,
			surfaces: surfaces(),
		};
		expect(availableCommands(requestTab).map((c) => c.id)).not.toContain("run-load-test");

		const contributed: CommandContext = {
			...requestTab,
			surfaces: { ...surfaces(), startLoadTest: () => {} },
		};
		expect(availableCommands(contributed).map((c) => c.id)).toContain("run-load-test");
	});

	/*
	 * Send is the second such entry (#1243), and its contribution is narrower
	 * still: the builder withdraws it while a send would be refused, so the row
	 * follows the Send button rather than the builder's mere presence.
	 */
	it("hides the send command until a mounted builder contributes it", () => {
		const requestTab: CommandContext = {
			activeTab: { id: "t1", type: "request", entityId: "r1" },
			activeTabLabel: "Charge card",
			activeTabReference: null,
			activeCollection: null,
			surfaces: surfaces(),
		};
		expect(availableCommands(requestTab).map((c) => c.id)).not.toContain("send-request");

		const contributed: CommandContext = {
			...requestTab,
			surfaces: { ...surfaces(), sendRequest: () => {} },
		};
		expect(availableCommands(contributed).map((c) => c.id)).toContain("send-request");
	});

	/*
	 * The tab menu's "Copy for agent", for the tab on screen (#2047). The
	 * reference is the descriptor's, so a tab that names no entity - welcome,
	 * settings, variables, the dashboard - has none, and neither has a tab whose
	 * entity is still loading.
	 */
	it("hides the copy command until a tab with a reference is active", () => {
		const settingsTab: CommandContext = {
			activeTab: { id: "t1", type: "settings", entityId: null },
			activeTabLabel: "Settings",
			activeTabReference: null,
			activeCollection: null,
			surfaces: surfaces(),
		};
		expect(availableCommands(settingsTab).map((c) => c.id)).not.toContain("copy-for-agent");
		expect(availableCommands(fullContext()).map((c) => c.id)).toContain("copy-for-agent");
	});

	it("hides the copy command from a caller with no clipboard host", () => {
		const { surfaces: _omitted, ...withoutHost } = fullContext();
		expect(availableCommands(withoutHost).map((c) => c.id)).not.toContain("copy-for-agent");
	});

	it("names the target of a contextual command, so Enter holds no surprise", () => {
		const ctx = fullContext();
		expect(commandTitle(commandById("run-collection"), ctx)).toBe('Run "Payments"');
		expect(commandTitle(commandById("close-tab"), ctx)).toBe('Close "Payments"');
		expect(commandTitle(commandById("run-load-test"), ctx)).toBe('Load test "Payments"');
		expect(commandTitle(commandById("send-request"), ctx)).toBe('Send "Payments"');
		expect(commandTitle(commandById("copy-for-agent"), ctx)).toBe('Copy "Payments" for agent');
	});

	it("prints the send chord on the row, from the chord itself", () => {
		// Not a second spelling of ⌘↵ (#938): the row and the handler read one
		// definition, so a chord that moves moves on both.
		expect(commandById("send-request").shortcut).toBe(SEND_CHORD);
	});

	it("falls back to a generic close title when nothing knows the label", () => {
		const ctx: CommandContext = {
			activeTab: { id: "t1", type: "request", entityId: "r1" },
			activeTabLabel: null,
			activeTabReference: null,
			activeCollection: null,
		};
		expect(commandTitle(commandById("close-tab"), ctx)).toBe("Close tab");
		expect(commandTitle(commandById("run-load-test"), ctx)).toBe("Load test this request");
		expect(commandTitle(commandById("send-request"), ctx)).toBe("Send this request");
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
		commandById("settings:data_retention").perform(baseCommandContext());
		expect(useSettingsStore.getState().selectedCategory).toBe("data_retention");
	});

	it("opens the import modal through its store, not a copy of it", () => {
		commandById("import-collection").perform(baseCommandContext());
		expect(useImportModalStore.getState().isOpen).toBe(true);
	});

	it("copies the active tab's reference through the host's copy, as a Reference", () => {
		const copy = vi.fn(async () => {});
		const ctx: CommandContext = { ...fullContext(), surfaces: { ...surfaces(), copy } };

		commandById("copy-for-agent").perform(ctx);

		expect(copy).toHaveBeenCalledExactlyOnceWith(PAYMENTS_REFERENCE, "Reference");
	});

	it("closes the active tab", () => {
		useTabsStore.getState().openTab({ type: "settings", entityId: null });
		const ctx = baseCommandContext();
		expect(ctx.activeTab).not.toBeNull();

		commandById("close-tab").perform(ctx);
		expect(useTabsStore.getState().openTabs).toHaveLength(0);
	});

	/*
	 * The strip's bulk closes (#1360). The tab menu names the tab under the
	 * pointer and these name the one on screen, but both reach the same store
	 * action - so what is asserted here is that the command is a pointer to it,
	 * not a second way to close a set of tabs.
	 */
	it("closes every tab but the active one", () => {
		for (const type of ["welcome", "settings", "variables"] as const) {
			useTabsStore.getState().openTab({ type, entityId: null });
		}
		const ctx = baseCommandContext();

		commandById("close-other-tabs").perform(ctx);

		const { openTabs } = useTabsStore.getState();
		expect(openTabs.map((t) => t.type)).toEqual(["variables"]); // the last opened is active
	});

	it("offers neither bulk close where it would do nothing", () => {
		useTabsStore.getState().openTab({ type: "settings", entityId: null });
		const ids = availableCommands(baseCommandContext()).map((c) => c.id);

		// One tab open, and it is the rightmost: nothing else to close, nothing
		// to its right. An item that is offered and inert is worse than absent.
		expect(ids).not.toContain("close-other-tabs");
		expect(ids).not.toContain("close-tabs-to-right");
		expect(ids).toContain("close-saved-tabs");
	});

	/*
	 * The palette rows act on the active tab, where the chord acts on the focused
	 * one - so a row is offered only where the active tab has somewhere to go.
	 */
	describe("move tab left / right", () => {
		const types = ["welcome", "settings", "variables"] as const;
		const order = () => useTabsStore.getState().openTabs.map((t) => t.type);

		function openAll(): string[] {
			for (const type of types) useTabsStore.getState().openTab({ type, entityId: null });
			return useTabsStore.getState().openTabs.map((t) => t.id);
		}

		const offered = () => availableCommands(baseCommandContext()).map((c) => c.id);

		it("withholds Move left from the first tab and Move right from the last", () => {
			const [first, , last] = openAll();

			useTabsStore.getState().focusTab(first);
			expect(offered()).not.toContain("move-tab-left");
			expect(offered()).toContain("move-tab-right");

			useTabsStore.getState().focusTab(last);
			expect(offered()).toContain("move-tab-left");
			expect(offered()).not.toContain("move-tab-right");
		});

		it("offers both from a middle tab", () => {
			const [, middle] = openAll();
			useTabsStore.getState().focusTab(middle);

			expect(offered()).toEqual(expect.arrayContaining(["move-tab-left", "move-tab-right"]));
		});

		it("offers neither with no tab open", () => {
			expect(offered()).not.toContain("move-tab-left");
			expect(offered()).not.toContain("move-tab-right");
		});

		it("moves the active tab one place along the strip", () => {
			const [, middle] = openAll();
			useTabsStore.getState().focusTab(middle);

			commandById("move-tab-left").perform(baseCommandContext());
			expect(order()).toEqual(["settings", "welcome", "variables"]);

			commandById("move-tab-right").perform(baseCommandContext());
			commandById("move-tab-right").perform(baseCommandContext());
			expect(order()).toEqual(["welcome", "variables", "settings"]);
			expect(useTabsStore.getState().activeTabId).toBe(middle);
		});

		it("names the active tab in its title", () => {
			const ctx: CommandContext = { ...baseCommandContext(), activeTabLabel: "Orders" };
			expect(commandTitle(commandById("move-tab-left"), ctx)).toBe('Move "Orders" left');
			expect(commandTitle(commandById("move-tab-right"), ctx)).toBe('Move "Orders" right');
		});
	});

	it("keeps a tab with unsaved edits when closing the saved ones", () => {
		useTabsStore.getState().openTab({ type: "welcome", entityId: null });
		useTabsStore.getState().openTab({ type: "settings", entityId: null });
		useSaveStore.getState().registerContext({
			id: "settings",
			name: "settings",
			save: () => Promise.resolve(),
			hasPendingChanges: true,
		});

		commandById("close-saved-tabs").perform(baseCommandContext());

		expect(useTabsStore.getState().openTabs.map((t) => t.type)).toEqual(["settings"]);
	});

	it("starts a load test through the contributed handler, never a copy of one", () => {
		let started = 0;
		const ctx: CommandContext = {
			...fullContext(),
			surfaces: { ...surfaces(), startLoadTest: () => started++ },
		};
		commandById("run-load-test").perform(ctx);
		expect(started).toBe(1);
	});

	it("sends through the contributed handler, never a copy of one", () => {
		let sent = 0;
		const ctx: CommandContext = {
			...fullContext(),
			surfaces: { ...surfaces(), sendRequest: () => sent++ },
		};
		commandById("send-request").perform(ctx);
		expect(sent).toBe(1);
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

/*
 * The run-export commands (#2139), generated from the export menu's own action
 * list and delivered through the mounted menu's handler. Mutation check: drop
 * the `available` gate and the first case reds; give one a chord and the third
 * does.
 */
describe("the run-export commands", () => {
	const exportIds = runExportActions().map((action) => `export-run-${action.id}`);
	const runTab: CommandContext = {
		activeTab: { id: "t1", type: "run", entityId: "run_1" },
		activeTabLabel: "/orders",
		activeTabReference: null,
		activeCollection: null,
		surfaces: surfaces(),
	};

	it("exist only while a finished run's menu contributes the export slot", () => {
		expect(exportIds).toEqual([
			"export-run-save-json",
			"export-run-save-markdown",
			"export-run-save-html",
			"export-run-copy-markdown",
		]);
		const ids = (ctx: CommandContext) => availableCommands(ctx).map((c) => c.id);
		for (const id of exportIds) {
			expect(ids(runTab)).not.toContain(id);
			expect(ids({ ...runTab, surfaces: { ...surfaces(), exportRun: () => {} } })).toContain(
				id
			);
		}
	});

	it("name the run tab they export, and fall back when nothing knows its label", () => {
		const command = commandById("export-run-save-json");
		expect(commandTitle(command, runTab)).toBe('Save "/orders" as JSON');
		expect(commandTitle(command, { ...runTab, activeTabLabel: null })).toBe(
			"Save this run as JSON"
		);
	});

	it("say copy for the clipboard and save for the file", () => {
		expect(commandTitle(commandById("export-run-copy-markdown"), runTab)).toBe(
			'Copy "/orders" as Markdown'
		);
		expect(commandTitle(commandById("export-run-save-markdown"), runTab)).toBe(
			'Save "/orders" as Markdown'
		);
		expect(commandTitle(commandById("export-run-save-html"), runTab)).toBe(
			'Save "/orders" as HTML report'
		);
	});

	it("declare no chord", () => {
		for (const id of exportIds) expect(commandById(id).shortcut).toBeUndefined();
	});

	it("deliver through the contributed handler, with the action they stand for", () => {
		const delivered: RunExportAction[] = [];
		const ctx: CommandContext = {
			...runTab,
			surfaces: { ...surfaces(), exportRun: (action) => delivered.push(action) },
		};
		commandById("export-run-save-json").perform(ctx);
		commandById("export-run-copy-markdown").perform(ctx);
		expect(delivered.map((action) => action.id)).toEqual(["save-json", "copy-markdown"]);
	});
});

describe("the sidebar toggle", () => {
	it("is titled in the user's word, matching its chord's label", () => {
		const title = commandTitle(commandById("toggle-drawer"), fullContext());
		expect(title).toBe("Show or hide the sidebar");
		expect(title).toBe(TOGGLE_DRAWER_CHORD.label);
	});
});

describe("commandById", () => {
	it("throws on an id nothing declares, so a dead menu item cannot be silent", () => {
		expect(() => commandById("open-the-pod-bay-doors")).toThrow(/Unknown command id/);
	});
});
