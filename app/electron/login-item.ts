/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether Vayu starts when the user logs in (issue #2098).
 *
 * The answer lives in the OS, never in the app's own settings: the user can
 * remove a login item from Windows' Task Manager, macOS' Login Items pane or a
 * desktop environment's startup list, and a stored copy of the flag would go on
 * claiming it is on. So the switch is read from the OS every time and written
 * through to it, and nothing about it is persisted here.
 *
 * Windows and macOS have an API for it (`app.setLoginItemSettings`). Linux has
 * none - Electron's call is a no-op there - so the XDG autostart entry is
 * written by hand, and read back the same way. An entry whose `Exec` names a
 * different binary than the one running (the AppImage was moved, or this is a
 * second copy) reads as off: the entry exists but would not launch this app, and
 * turning the switch on rewrites it to point here. So does an entry a desktop
 * environment has disabled in place (`Hidden=true`, or
 * `X-GNOME-Autostart-enabled=false`): it keeps its `Exec` and no longer starts.
 *
 * Only a packaged build registers anything. A dev run's `process.execPath` is
 * Electron's own binary, and a login item pointing at it would launch a bare
 * Electron shell with no app.
 *
 * Launching at login is an ordinary launch: the window opens and the
 * single-instance lock is taken like any other (`docs/architecture.md`).
 *
 * Kept out of main.ts so it can be tested - main.ts creates windows and starts
 * the engine at import time, which no unit test can do. The Electron surfaces it
 * needs arrive as arguments for the same reason; the autostart file is real
 * filesystem I/O, which a test points at a scratch directory through
 * `configHome`.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoginItemSettings, Settings } from "electron";

export const LOGIN_ITEM_GET_CHANNEL = "loginItem:get";
export const LOGIN_ITEM_SET_CHANNEL = "loginItem:set";

/** The autostart entry's file name. Matches the launcher entry `install.sh` writes. */
const AUTOSTART_FILE = "vayu.desktop";

export interface LoginItemDeps {
	platform: NodeJS.Platform;
	/** `app.isPackaged`. An unpackaged run has nothing worth registering. */
	isPackaged: boolean;
	/** What an autostart entry must launch: `process.env.APPIMAGE ?? process.execPath`. Linux only. */
	binaryPath: string;
	/** `$XDG_CONFIG_HOME`, or `~/.config`. Linux only. */
	configHome: string;
	get: () => LoginItemSettings;
	set: (settings: Settings) => void;
	/** Where a change is reported. Category `"main"`. */
	log: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface LoginItemState {
	/** `false` when this build or platform cannot register a login item. */
	supported: boolean;
	/** Why not, in a sentence the UI can print. `null` when supported. */
	reason: string | null;
	openAtLogin: boolean;
	/** macOS holds the item until the user approves it in System Settings. */
	needsApproval: boolean;
}

export interface LoginItem {
	read(): LoginItemState;
	/** Turn it on or off, then report what the OS now says. A no-op when unsupported. */
	write(on: boolean): LoginItemState;
}

const NOT_PACKAGED_REASON = "Start at login is available in the installed app.";
const UNSUPPORTED_PLATFORM_REASON = "Start at login is not available on this platform.";

function unsupported(reason: string): LoginItemState {
	return { supported: false, reason, openAtLogin: false, needsApproval: false };
}

/**
 * The `Exec` value for a binary, quoted per the Desktop Entry spec: the spec
 * word-splits an unquoted value, so a path with a space would launch its first
 * word. Inside quotes `"`, `` ` ``, `$` and `\` take a backslash, and a `%` is
 * written `%%` because a bare one opens a field code.
 */
function quotedExec(binaryPath: string): string {
	const escaped = binaryPath.replace(/["`$\\]/g, "\\$&").replace(/%/g, "%%");
	return `"${escaped}"`;
}

/**
 * The `Key=Value` pairs of the `[Desktop Entry]` group; other groups (an
 * `[Desktop Action ...]` with an `Exec` of its own) are ignored. Lines are
 * trimmed so the CRLF endings or trailing blanks a rewriting tool leaves do not
 * change what a value reads as.
 */
function desktopEntryFields(text: string): Map<string, string> {
	const fields = new Map<string, string>();
	let inDesktopEntry = false;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("[")) {
			inDesktopEntry = line === "[Desktop Entry]";
			continue;
		}
		const separator = line.indexOf("=");
		if (!inDesktopEntry || line.startsWith("#") || separator < 0) continue;
		const key = line.slice(0, separator).trimEnd();
		if (!fields.has(key)) fields.set(key, line.slice(separator + 1).trimStart());
	}
	return fields;
}

function fieldEquals(fields: Map<string, string>, key: string, expected: string): boolean {
	return fields.get(key)?.toLowerCase() === expected;
}

function autostartEntry(binaryPath: string): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=Vayu",
		`Exec=${quotedExec(binaryPath)}`,
		"X-GNOME-Autostart-enabled=true",
		"",
	].join("\n");
}

export function createLoginItem(deps: LoginItemDeps): LoginItem {
	const autostartPath = join(deps.configHome, "autostart", AUTOSTART_FILE);

	function readAutostartEntry(): string | null {
		try {
			return readFileSync(autostartPath, "utf8");
		} catch (error) {
			// Absent is the ordinary "off". Anything else (a directory where the
			// file should be, no permission) is also not an entry that launches us.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				deps.log("Could not read the autostart entry", {
					path: autostartPath,
					error: String(error),
				});
			}
			return null;
		}
	}

	function readLinux(): LoginItemState {
		const entry = readAutostartEntry();
		const fields = desktopEntryFields(entry ?? "");
		const launchesUs = fields.get("Exec") === quotedExec(deps.binaryPath);
		const enabled =
			!fieldEquals(fields, "Hidden", "true") &&
			!fieldEquals(fields, "X-GNOME-Autostart-enabled", "false");
		return {
			supported: true,
			reason: null,
			openAtLogin: launchesUs && enabled,
			needsApproval: false,
		};
	}

	function readNative(): LoginItemState {
		const settings = deps.get();
		return {
			supported: true,
			reason: null,
			openAtLogin: settings.openAtLogin,
			needsApproval: settings.status === "requires-approval",
		};
	}

	function writeLinux(on: boolean): void {
		if (!on) {
			rmSync(autostartPath, { force: true });
			return;
		}
		mkdirSync(join(deps.configHome, "autostart"), { recursive: true });
		writeFileSync(autostartPath, autostartEntry(deps.binaryPath));
	}

	function unsupportedReason(): string | null {
		if (!deps.isPackaged) return NOT_PACKAGED_REASON;
		if (deps.platform === "darwin" || deps.platform === "win32" || deps.platform === "linux") {
			return null;
		}
		return UNSUPPORTED_PLATFORM_REASON;
	}

	function read(): LoginItemState {
		const reason = unsupportedReason();
		if (reason) return unsupported(reason);
		return deps.platform === "linux" ? readLinux() : readNative();
	}

	function write(on: boolean): LoginItemState {
		const reason = unsupportedReason();
		if (reason) return unsupported(reason);
		if (deps.platform === "linux") writeLinux(on);
		else deps.set({ openAtLogin: on });
		deps.log(on ? "Start at login turned on" : "Start at login turned off", {
			platform: deps.platform,
		});
		return read();
	}

	return { read, write };
}

/** The slice of `ipcMain` the channels need. */
export interface LoginItemIpcLike {
	handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown;
}

/** Wire the two channels. `set` refuses anything but a boolean, as `theme:set` does for its source. */
export function registerLoginItemIpc(ipc: LoginItemIpcLike, loginItem: LoginItem): void {
	ipc.handle(LOGIN_ITEM_GET_CHANNEL, () => loginItem.read());
	ipc.handle(LOGIN_ITEM_SET_CHANNEL, (_event, on: unknown) => {
		if (typeof on !== "boolean") {
			throw new Error(`Invalid start-at-login value: ${String(on)}`);
		}
		return loginItem.write(on);
	});
}
