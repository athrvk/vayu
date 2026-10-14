/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Start at login (issue #2098), one platform at a time. Every case names its
 * platform through the injected `platform`, never the host's, so the suite
 * answers the same on the three CI runners.
 *
 * The OS is the source of truth, so the assertions are about what `read()`
 * reports after a `write()`, and about what is never called: an unpackaged run
 * must not register anything, because its `execPath` is Electron's own binary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginItemSettings } from "electron";
import {
	createLoginItem,
	registerLoginItemIpc,
	LOGIN_ITEM_GET_CHANNEL,
	LOGIN_ITEM_SET_CHANNEL,
	type LoginItemDeps,
} from "./login-item.js";

const BINARY = "/opt/Vayu/Vayu.AppImage";

let configHome: string;

beforeEach(() => {
	configHome = mkdtempSync(join(tmpdir(), "vayu-login-item-"));
});

afterEach(() => {
	rmSync(configHome, { recursive: true, force: true });
});

/** An OS login item that remembers what `set` was given, as the real one does. */
function fakeOs(initial: Partial<LoginItemSettings> = {}) {
	let current = { openAtLogin: false, status: "not-registered", ...initial } as LoginItemSettings;
	return {
		get: vi.fn(() => current),
		set: vi.fn((settings: { openAtLogin?: boolean }) => {
			current = { ...current, openAtLogin: settings.openAtLogin ?? false };
		}),
		force(next: Partial<LoginItemSettings>) {
			current = { ...current, ...next };
		},
	};
}

function build(overrides: Partial<LoginItemDeps> & { os?: ReturnType<typeof fakeOs> } = {}) {
	const os = overrides.os ?? fakeOs();
	const log = vi.fn();
	const loginItem = createLoginItem({
		platform: "linux",
		isPackaged: true,
		binaryPath: BINARY,
		configHome,
		get: os.get,
		set: os.set,
		log,
		...overrides,
	});
	return { loginItem, os, log };
}

const autostartFile = () => join(configHome, "autostart", "vayu.desktop");

describe.each(["darwin", "win32"] as const)("%s", (platform) => {
	it("registers with openAtLogin alone and reads the answer back from the OS", () => {
		const { loginItem, os } = build({ platform });

		expect(loginItem.read()).toMatchObject({ supported: true, openAtLogin: false });
		const after = loginItem.write(true);

		// No `openAsHidden`, no `args`: a login launch is an ordinary one.
		expect(os.set).toHaveBeenCalledExactlyOnceWith({ openAtLogin: true });
		expect(after).toEqual({
			supported: true,
			reason: null,
			openAtLogin: true,
			needsApproval: false,
		});
	});

	it("turns it off the same way", () => {
		const { loginItem, os } = build({ platform, os: fakeOs({ openAtLogin: true }) });

		const after = loginItem.write(false);

		expect(os.set).toHaveBeenCalledExactlyOnceWith({ openAtLogin: false });
		expect(after.openAtLogin).toBe(false);
	});

	it("reports what the OS says even when the user changed it outside the app", () => {
		const os = fakeOs({ openAtLogin: true });
		const { loginItem } = build({ platform, os });
		expect(loginItem.read().openAtLogin).toBe(true);

		os.force({ openAtLogin: false });

		expect(loginItem.read().openAtLogin).toBe(false);
	});

	it("never touches the autostart directory", () => {
		const { loginItem } = build({ platform });
		loginItem.write(true);
		expect(existsSync(join(configHome, "autostart"))).toBe(false);
	});
});

describe("darwin approval", () => {
	it("flags an item the user has yet to approve", () => {
		const os = fakeOs();
		os.set.mockImplementation(() =>
			os.force({ openAtLogin: false, status: "requires-approval" })
		);
		const { loginItem } = build({ platform: "darwin", os });

		const after = loginItem.write(true);

		expect(after).toMatchObject({ openAtLogin: false, needsApproval: true });
	});

	it.each(["not-registered", "enabled", "not-found"] as const)(
		"does not flag status %s",
		(status) => {
			const { loginItem } = build({ platform: "darwin", os: fakeOs({ status }) });
			expect(loginItem.read().needsApproval).toBe(false);
		}
	);
});

describe("linux", () => {
	it("writes an autostart entry that launches the quoted binary", () => {
		const { loginItem, os } = build();

		const after = loginItem.write(true);

		const entry = readFileSync(autostartFile(), "utf8");
		expect(entry).toContain("[Desktop Entry]");
		expect(entry).toContain("Type=Application");
		expect(entry).toContain("Name=Vayu");
		expect(entry).toContain(`Exec="${BINARY}"`);
		expect(entry).toContain("X-GNOME-Autostart-enabled=true");
		expect(after.openAtLogin).toBe(true);
		// Electron's login item API does nothing on Linux.
		expect(os.set).not.toHaveBeenCalled();
		expect(os.get).not.toHaveBeenCalled();
	});

	it("removes the entry when turned off, and tolerates there being none", () => {
		const { loginItem } = build();
		loginItem.write(true);

		expect(loginItem.write(false).openAtLogin).toBe(false);
		expect(existsSync(autostartFile())).toBe(false);
		expect(() => loginItem.write(false)).not.toThrow();
	});

	it("quotes a path with a space or a shell metacharacter", () => {
		const { loginItem } = build({ binaryPath: "/home/a b/$HOME/Vayu.AppImage" });

		expect(loginItem.write(true).openAtLogin).toBe(true);

		expect(readFileSync(autostartFile(), "utf8")).toContain(
			'Exec="/home/a b/\\$HOME/Vayu.AppImage"'
		);
	});

	it("reads an entry naming another binary as off", () => {
		mkdirSync(join(configHome, "autostart"), { recursive: true });
		writeFileSync(
			autostartFile(),
			'[Desktop Entry]\nType=Application\nName=Vayu\nExec="/old/place/Vayu.AppImage"\n'
		);
		const { loginItem } = build();

		expect(loginItem.read()).toMatchObject({ supported: true, openAtLogin: false });
	});

	it("rewrites a stale entry to point here when turned on", () => {
		mkdirSync(join(configHome, "autostart"), { recursive: true });
		writeFileSync(autostartFile(), 'Exec="/old/place/Vayu.AppImage"\n');
		const { loginItem } = build();

		expect(loginItem.write(true).openAtLogin).toBe(true);
		expect(readFileSync(autostartFile(), "utf8")).not.toContain("/old/place");
	});

	describe("an entry the desktop environment rewrote", () => {
		const exec = `Exec="${BINARY}"`;
		function seed(content: string) {
			mkdirSync(join(configHome, "autostart"), { recursive: true });
			writeFileSync(autostartFile(), content);
		}

		it.each([
			["X-GNOME-Autostart-enabled=false", "X-GNOME-Autostart-enabled=false"],
			["a differently cased false", "X-GNOME-Autostart-enabled=False"],
			["Hidden=true", "Hidden=true"],
			["a differently cased true", "Hidden=TRUE"],
		])("reads as off with %s although its Exec still names us", (_name, line) => {
			seed(`[Desktop Entry]\nType=Application\nName=Vayu\n${exec}\n${line}\n`);

			expect(build().loginItem.read().openAtLogin).toBe(false);
		});

		it.each(["Hidden=false", "X-GNOME-Autostart-enabled=true"])(
			"still reads as on with %s",
			(line) => {
				seed(`[Desktop Entry]\nType=Application\n${exec}\n${line}\n`);

				expect(build().loginItem.read().openAtLogin).toBe(true);
			}
		);

		it("reads a CRLF file with trailing blanks and a matching Exec as on", () => {
			seed(`[Desktop Entry]\r\nType=Application\r\n${exec}  \r\nHidden=false\r\n`);

			expect(build().loginItem.read().openAtLogin).toBe(true);
		});

		it("ignores a disabling key or an Exec in another group", () => {
			seed(
				`[Desktop Entry]\n${exec}\n\n[Desktop Action later]\nExec="/elsewhere"\nHidden=true\n`
			);
			expect(build().loginItem.read().openAtLogin).toBe(true);

			seed(`[Desktop Action first]\n${exec}\n`);
			expect(build().loginItem.read().openAtLogin).toBe(false);
		});

		it("is switched back on by writing it again", () => {
			seed(`[Desktop Entry]\n${exec}\nHidden=true\n`);
			const { loginItem } = build();

			expect(loginItem.write(true).openAtLogin).toBe(true);
		});
	});

	it("writes a % as %% so it is not read as a field code, and reads that back as on", () => {
		const { loginItem } = build({ binaryPath: "/opt/100%/Vayu.AppImage" });

		expect(loginItem.write(true).openAtLogin).toBe(true);

		expect(readFileSync(autostartFile(), "utf8")).toContain('Exec="/opt/100%%/Vayu.AppImage"');
	});

	it("does not take a binary whose path merely starts like ours", () => {
		const { loginItem } = build({ binaryPath: "/opt/Vayu/Vayu.AppImage" });
		mkdirSync(join(configHome, "autostart"), { recursive: true });
		writeFileSync(autostartFile(), 'Exec="/opt/Vayu/Vayu.AppImage.old"\n');

		expect(loginItem.read().openAtLogin).toBe(false);
	});
});

describe("where it is not offered", () => {
	it.each(["darwin", "win32", "linux"] as const)(
		"%s unpackaged reads unsupported and never writes anything",
		(platform) => {
			const { loginItem, os } = build({ platform, isPackaged: false });

			const state = loginItem.read();
			const after = loginItem.write(true);

			expect(state.supported).toBe(false);
			expect(state.reason).toMatch(/installed app/i);
			expect(after).toEqual(state);
			expect(os.set).not.toHaveBeenCalled();
			expect(existsSync(join(configHome, "autostart"))).toBe(false);
		}
	);

	it("reads unsupported on a platform with no login item", () => {
		const { loginItem, os } = build({ platform: "freebsd" });

		const after = loginItem.write(true);

		expect(after.supported).toBe(false);
		expect(after.reason).toMatch(/platform/i);
		expect(os.set).not.toHaveBeenCalled();
		expect(existsSync(join(configHome, "autostart"))).toBe(false);
	});
});

describe("the IPC channels", () => {
	function register() {
		const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
		const { loginItem } = build();
		registerLoginItemIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, loginItem);
		return handlers;
	}

	it("answers get with the state and set with the state after the write", () => {
		const handlers = register();

		expect(handlers.get(LOGIN_ITEM_GET_CHANNEL)?.({})).toMatchObject({ openAtLogin: false });
		expect(handlers.get(LOGIN_ITEM_SET_CHANNEL)?.({}, true)).toMatchObject({
			openAtLogin: true,
		});
		expect(handlers.get(LOGIN_ITEM_GET_CHANNEL)?.({})).toMatchObject({ openAtLogin: true });
	});

	it.each([["yes"], [1], [null], [undefined]])("refuses %j as the value to set", (value) => {
		const handlers = register();

		expect(() => handlers.get(LOGIN_ITEM_SET_CHANNEL)?.({}, value)).toThrow(
			/Invalid start-at-login value/
		);
		expect(existsSync(autostartFile())).toBe(false);
	});
});
