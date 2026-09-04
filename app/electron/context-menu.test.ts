/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The renderer's own detector, which parses whatever this menu offers to import.
// A leaf module by design, so reaching across the process boundary here costs
// nothing: see src/services/curl/detect-command.ts.
import { detectCommand } from "@/services/curl/detect-command";
import {
	commandOnClipboard,
	createContextTargetStore,
	installContextMenu,
	isBrowsableUrl,
	menuTemplateFor,
	readContextTarget,
	runContextCommand,
	toElectronTemplate,
	NO_CONTEXT_TARGET,
	type ContextMenuItem,
	type ContextMenuParams,
	type ContextTarget,
} from "./context-menu.js";

const ALL_FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
	return {
		isEditable: false,
		selectionText: "",
		linkURL: "",
		editFlags: { ...ALL_FLAGS },
		...overrides,
	};
}

function target(overrides: Partial<ContextTarget> = {}): ContextTarget {
	return { ...NO_CONTEXT_TARGET, ...overrides };
}

const noClipboard = () => "";

/** The roles a template offers, in order, with whether each is enabled. */
function roles(items: ContextMenuItem[]): Array<[string, boolean]> {
	return items.flatMap((item) => (item.kind === "role" ? [[item.role, item.enabled]] : []));
}

/** The labels of the command items, in order. */
function labels(items: ContextMenuItem[]): string[] {
	return items.flatMap((item) => (item.kind === "command" ? [item.label] : []));
}

const realPlatform = process.platform;

afterEach(() => {
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("menuTemplateFor - editable fields", () => {
	it("offers the four edit roles, Select All behind a separator", () => {
		const items = menuTemplateFor(params({ isEditable: true }), target(), noClipboard);

		expect(roles(items)).toEqual([
			["cut", true],
			["copy", true],
			["paste", true],
			["selectAll", true],
		]);
		expect(items[3]).toEqual({ kind: "separator" });
	});

	it("disables the items the edit flags say cannot act", () => {
		const items = menuTemplateFor(
			params({
				isEditable: true,
				editFlags: { ...ALL_FLAGS, canPaste: false, canCut: false },
			}),
			target(),
			noClipboard
		);

		expect(roles(items)).toEqual([
			["cut", false],
			["copy", true],
			["paste", false],
			["selectAll", true],
		]);
	});
});

describe("menuTemplateFor - the URL bar's Paste as offer", () => {
	it("offers the import when the clipboard holds a curl command", () => {
		const items = menuTemplateFor(
			params({ isEditable: true }),
			target({ kind: "url-bar" }),
			() => "curl https://api.example.com -H 'X-Key: 1'"
		);

		expect(labels(items)).toEqual(["Paste as curl"]);
		const offer = items.find((item) => item.kind === "command");
		expect(offer).toMatchObject({
			command: { type: "import-command", text: "curl https://api.example.com -H 'X-Key: 1'" },
		});
	});

	it("names wget when that is what the clipboard holds", () => {
		const items = menuTemplateFor(
			params({ isEditable: true }),
			target({ kind: "url-bar" }),
			() => "wget https://api.example.com"
		);

		expect(labels(items)).toEqual(["Paste as wget"]);
	});

	it("offers nothing extra for ordinary clipboard text", () => {
		const items = menuTemplateFor(
			params({ isEditable: true }),
			target({ kind: "url-bar" }),
			() => "https://api.example.com"
		);

		expect(labels(items)).toEqual([]);
	});

	it("does not read the clipboard at all outside the URL bar", () => {
		const readClipboardText = vi.fn(() => "curl https://api.example.com");

		const items = menuTemplateFor(params({ isEditable: true }), target(), readClipboardText);

		expect(readClipboardText).not.toHaveBeenCalled();
		expect(labels(items)).toEqual([]);
	});
});

describe("menuTemplateFor - variable tokens", () => {
	it("offers Edit variable for the token under the pointer", () => {
		const items = menuTemplateFor(
			params({ isEditable: true }),
			target({ kind: "url-bar", variable: "baseUrl" }),
			noClipboard
		);

		expect(labels(items)).toEqual(["Edit variable"]);
		expect(items[items.length - 1]).toMatchObject({
			command: { type: "edit-variable", name: "baseUrl" },
		});
	});

	it("offers it in any editable field, not only the URL bar", () => {
		const items = menuTemplateFor(
			params({ isEditable: true }),
			target({ variable: "token" }),
			noClipboard
		);

		expect(labels(items)).toEqual(["Edit variable"]);
	});
});

describe("menuTemplateFor - read-only surfaces", () => {
	it("offers Copy for selected text", () => {
		const items = menuTemplateFor(params({ selectionText: "200 OK" }), target(), noClipboard);

		expect(roles(items)).toEqual([["copy", true]]);
	});

	it("shows nothing on empty chrome", () => {
		expect(menuTemplateFor(params(), target(), noClipboard)).toEqual([]);
	});

	it("shows nothing inside a Monaco editor, which draws its own", () => {
		const items = menuTemplateFor(
			params({ isEditable: true, selectionText: "{}", linkURL: "https://example.com" }),
			target({ kind: "monaco" }),
			noClipboard
		);

		expect(items).toEqual([]);
	});
});

describe("menuTemplateFor - links", () => {
	it("offers both link actions, separated from the edit items", () => {
		const items = menuTemplateFor(
			params({ isEditable: true, linkURL: "https://vayu.sh/docs" }),
			target(),
			noClipboard
		);

		expect(labels(items)).toEqual(["Copy Link", "Open in Browser"]);
		const last = items.length - 1;
		expect(items[last - 1]).toMatchObject({
			command: { type: "copy-link", url: "https://vayu.sh/docs" },
		});
		expect(items[last]).toMatchObject({
			command: { type: "open-link", url: "https://vayu.sh/docs" },
		});
		expect(items[last - 2]).toEqual({ kind: "separator" });
	});

	it("offers a link on a read-only surface with no selection", () => {
		const items = menuTemplateFor(
			params({ linkURL: "http://localhost:9876" }),
			target(),
			noClipboard
		);

		expect(labels(items)).toEqual(["Copy Link", "Open in Browser"]);
		expect(items[0]).not.toEqual({ kind: "separator" });
	});

	it("does not offer to open a scheme a browser does not answer for", () => {
		const items = menuTemplateFor(
			params({ linkURL: "file:///etc/passwd", selectionText: "x" }),
			target(),
			noClipboard
		);

		expect(labels(items)).toEqual([]);
	});

	it("judges browsable schemes and nothing else", () => {
		expect(isBrowsableUrl("https://example.com")).toBe(true);
		expect(isBrowsableUrl("http://example.com")).toBe(true);
		expect(isBrowsableUrl("vayu://open")).toBe(false);
		expect(isBrowsableUrl("javascript:alert(1)")).toBe(false);
		expect(isBrowsableUrl("not a url")).toBe(false);
	});
});

describe("menuTemplateFor - platform", () => {
	/*
	 * The edit items are roles, so the accelerator printed beside each label is
	 * the OS's own (⌘X on macOS, Ctrl+X elsewhere) and the template holds no
	 * platform branch to get wrong. Driving both platforms is what proves that:
	 * an app-drawn accelerator would show up here as a difference.
	 */
	function templateOn(platform: NodeJS.Platform): ContextMenuItem[] {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		return menuTemplateFor(
			params({ isEditable: true, linkURL: "https://vayu.sh" }),
			target({ kind: "url-bar", variable: "host" }),
			() => "curl https://vayu.sh"
		);
	}

	it("builds the same menu on macOS and on Windows", () => {
		expect(templateOn("darwin")).toEqual(templateOn("win32"));
	});

	it("leaves every edit item a role rather than a hand-drawn accelerator", () => {
		for (const platform of ["darwin", "win32", "linux"] as const) {
			const editItems = templateOn(platform).filter((item) => item.kind === "role");
			expect(editItems.map((item) => (item.kind === "role" ? item.role : ""))).toEqual([
				"cut",
				"copy",
				"paste",
				"selectAll",
			]);
		}
	});
});

describe("commandOnClipboard", () => {
	it("agrees with the renderer's detector, which parses what this offers", () => {
		const clipboards = [
			"curl https://example.com",
			"CURL https://example.com",
			"  curl -X POST https://example.com  ",
			"$ curl https://example.com",
			"> wget https://example.com",
			"wget --header 'X-Key: 1' https://example.com",
			"https://example.com",
			"curling https://example.com",
			"echo curl",
			"",
			"   ",
		];

		for (const text of clipboards) {
			// Paired with the text so a failure names the clipboard that drifted.
			expect([text, commandOnClipboard(text)]).toEqual([text, detectCommand(text)]);
		}
	});
});

describe("readContextTarget", () => {
	it("keeps the two markers it knows", () => {
		expect(readContextTarget({ kind: "url-bar", variable: "baseUrl" })).toEqual({
			kind: "url-bar",
			variable: "baseUrl",
		});
		expect(readContextTarget({ kind: "monaco", variable: null })).toEqual({
			kind: "monaco",
			variable: null,
		});
	});

	it("falls back to the plain menu for anything it does not recognise", () => {
		expect(readContextTarget({ kind: "sidebar", variable: 7 })).toEqual(NO_CONTEXT_TARGET);
		expect(readContextTarget("url-bar")).toEqual(NO_CONTEXT_TARGET);
		expect(readContextTarget(null)).toEqual(NO_CONTEXT_TARGET);
		expect(readContextTarget(undefined)).toEqual(NO_CONTEXT_TARGET);
		expect(readContextTarget({ kind: "url-bar", variable: "" })).toEqual({
			kind: "url-bar",
			variable: null,
		});
	});
});

describe("createContextTargetStore", () => {
	it("hands the announcement to the one menu it belongs to", () => {
		const store = createContextTargetStore();

		store.announce({ kind: "url-bar", variable: "baseUrl" });

		expect(store.take()).toEqual({ kind: "url-bar", variable: "baseUrl" });
		expect(store.take()).toEqual(NO_CONTEXT_TARGET);
	});

	it("answers with the plain menu when nothing was announced", () => {
		expect(createContextTargetStore().take()).toEqual(NO_CONTEXT_TARGET);
	});
});

describe("runContextCommand", () => {
	function effects() {
		return {
			writeClipboard: vi.fn(),
			openExternal: vi.fn(),
			sendToRenderer: vi.fn(),
		};
	}

	it("copies a link without leaving the main process", () => {
		const spies = effects();

		runContextCommand({ type: "copy-link", url: "https://vayu.sh" }, spies);

		expect(spies.writeClipboard).toHaveBeenCalledWith("https://vayu.sh");
		expect(spies.sendToRenderer).not.toHaveBeenCalled();
	});

	it("opens a link through the OS", () => {
		const spies = effects();

		runContextCommand({ type: "open-link", url: "https://vayu.sh" }, spies);

		expect(spies.openExternal).toHaveBeenCalledWith("https://vayu.sh");
	});

	it("forwards the two offers the renderer owns", () => {
		const spies = effects();

		runContextCommand({ type: "import-command", text: "curl https://vayu.sh" }, spies);
		runContextCommand({ type: "edit-variable", name: "baseUrl" }, spies);

		expect(spies.sendToRenderer).toHaveBeenNthCalledWith(1, {
			type: "import-command",
			text: "curl https://vayu.sh",
		});
		expect(spies.sendToRenderer).toHaveBeenNthCalledWith(2, {
			type: "edit-variable",
			name: "baseUrl",
		});
		expect(spies.writeClipboard).not.toHaveBeenCalled();
		expect(spies.openExternal).not.toHaveBeenCalled();
	});
});

describe("toElectronTemplate", () => {
	it("carries roles and separators through, and binds each command to its click", () => {
		const run = vi.fn();
		const template = toElectronTemplate(
			[
				{ kind: "role", role: "paste", enabled: false },
				{ kind: "separator" },
				{
					kind: "command",
					label: "Edit variable",
					command: { type: "edit-variable", name: "baseUrl" },
				},
			],
			run
		);

		expect(template[0]).toEqual({ role: "paste", enabled: false });
		expect(template[1]).toEqual({ type: "separator" });
		expect(template[2]?.label).toBe("Edit variable");

		template[2]?.click?.();

		expect(run).toHaveBeenCalledWith({ type: "edit-variable", name: "baseUrl" });
	});
});

describe("installContextMenu", () => {
	function fakeContents() {
		const listeners: Array<(event: unknown, params: ContextMenuParams) => void> = [];
		return {
			on(
				_event: "context-menu",
				listener: (event: unknown, params: ContextMenuParams) => void
			) {
				listeners.push(listener);
				return this;
			},
			rightClick(value: ContextMenuParams) {
				for (const listener of listeners) listener({}, value);
			},
		};
	}

	it("pops the menu the pointer's context earns", () => {
		const contents = fakeContents();
		const showMenu = vi.fn();
		installContextMenu(contents, {
			takeTarget: () => target({ kind: "url-bar" }),
			readClipboardText: () => "curl https://vayu.sh",
			showMenu,
		});

		contents.rightClick(params({ isEditable: true }));

		expect(showMenu).toHaveBeenCalledTimes(1);
		expect(labels(showMenu.mock.calls[0][0])).toEqual(["Paste as curl"]);
	});

	it("pops nothing where the template is empty", () => {
		const contents = fakeContents();
		const showMenu = vi.fn();
		installContextMenu(contents, {
			takeTarget: () => target({ kind: "monaco" }),
			readClipboardText: () => "",
			showMenu,
		});

		contents.rightClick(params({ isEditable: true }));

		expect(showMenu).not.toHaveBeenCalled();
	});
});

/**
 * main.ts creates windows and starts the engine at import time, so the wiring
 * can only be read - the characterization approach `startup-order.test.ts` and
 * `renderer-recovery.test.ts` take to the same file. What is driven for real is
 * everything above; what is asserted here is that it is reached at all.
 */
describe("the wiring in main.ts", () => {
	const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

	it("installs the handler on the window's own web contents", () => {
		expect(main).toContain("installContextMenu(menuWindow.webContents");
	});

	it("takes the announcement over an IPC channel that always answers", () => {
		const handlerAt = main.indexOf('ipcMain.on("context-menu:target"');
		expect(handlerAt).toBeGreaterThan(-1);

		// A `sendSync` whose handler returns without a `returnValue` blocks the
		// renderer for good, so it is set before anything that could throw.
		const body = main.slice(handlerAt, handlerAt + 400);
		expect(body.indexOf("event.returnValue = true;")).toBeLessThan(
			body.indexOf("contextTargets.announce(")
		);
	});
});
