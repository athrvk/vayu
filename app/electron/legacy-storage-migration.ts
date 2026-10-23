/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The one-time hand-off of what a `file:` build persisted to the
 * `vayu-app://app` origin (#2380).
 *
 * localStorage is keyed by origin, so a build that loads its renderer from the
 * app scheme starts with none of what the `file:` builds saved: the theme and
 * appearance keys `index.html` reads before first paint, every zustand
 * `persist` store, and the spec and data-file bindings that cost the user a
 * re-pick each. On the first packaged launch that finds the old store, main
 * reads every entry from a hidden view on the `file://` origin and holds the
 * `vayu*` ones until the new window's preload, which runs before any page
 * script, asks for them and writes each key the new origin does not have yet.
 *
 * Retirement: this module, its two channels, the preload's
 * `adoptLegacyStorage` and the wiring in main.ts go together, in the first
 * release cut six months after the one that ships them (0.46.0 is expected).
 * It is the one place the app loads a `file:` URL. Tracked under #2380.
 *
 * Kept free of Electron so the decisions are tested directly; main.ts hands in
 * the hidden view, the record and the logger.
 */

import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import type { IpcSenderLike } from "./ipc-sender.js";

/**
 * Appended to the window's command line while a hand-off is pending, so the
 * preload asks only then rather than blocking every launch's first script on
 * a synchronous round trip. The preload spells all three again (it is a
 * CommonJS script with no imports); `legacy-storage-migration.test.ts` holds
 * the spellings together.
 */
export const LEGACY_STORAGE_ARG = "--vayu-legacy-storage";
/** `sendSync`: the preload asks for the held entries, or null. */
export const LEGACY_STORAGE_TAKE_CHANNEL = "legacy-storage:take";
/** `send`: the preload reports what it wrote, which is what completes the hand-off. */
export const LEGACY_STORAGE_TAKEN_CHANNEL = "legacy-storage:taken";

/**
 * Launches that may start a hand-off before it is given up. A launch counts
 * when it starts, so a read that fails, a window that crashes before it
 * reports and a write the new origin refuses all use one up. The old origin
 * is never written again, so a retry loses nothing, and the cap keeps a
 * failure that repeats from costing every launch a hidden page load.
 */
export const LEGACY_STORAGE_MAX_ATTEMPTS = 3;

/**
 * How long the hidden view has to load the stub and answer. A healthy read
 * is a local file and one script, about 100-300 ms; this exists so a load that
 * never settles cannot hold the main window back.
 */
export const LEGACY_STORAGE_READ_TIMEOUT_MS = 10_000;

/** Every key the renderer persists starts with `vayu-`, `vayu.` or `vayu:`. */
const VAYU_KEY = /^vayu[-.:]/;

/** What the stub page answers: every localStorage entry on its origin. */
export const READ_ALL_LOCAL_STORAGE = `(() => {
	const all = {};
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		all[key] = localStorage.getItem(key);
	}
	return all;
})()`;

/**
 * A document with no script and no subresource, and a policy that refuses
 * both: only an origin to read from. `executeJavaScript` is not page script and
 * is not subject to it.
 */
const STUB_HTML =
	'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title></title>';

export type LegacyEntries = Record<string, string>;

export function isVayuStorageKey(key: string): boolean {
	return VAYU_KEY.test(key);
}

/** The `vayu*` string entries of what the stub answered. Throws on anything but an object. */
export function vayuEntries(answer: unknown): LegacyEntries {
	if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
		throw new Error(
			`The file: origin answered ${Array.isArray(answer) ? "an array" : typeof answer}`
		);
	}
	const entries: LegacyEntries = {};
	for (const [key, value] of Object.entries(answer)) {
		if (isVayuStorageKey(key) && typeof value === "string") entries[key] = value;
	}
	return entries;
}

/**
 * The stub's view: a `WebContentsView` that is never attached to a window, so
 * nothing can appear on screen and no window is created or closed (a hidden
 * `BrowserWindow` destroyed with no other window up raises
 * `window-all-closed`, which quits the app on Windows and Linux). No preload,
 * sandboxed, on the default session (no `partition`), which is where the
 * `file:` builds' window kept its storage.
 *
 * `webSecurity: false` is not optional. With the GrantFileProtocolExtraPrivileges
 * fuse off, Electron 44 refuses localStorage to a `file:` document ("Access is
 * denied for this document") unless web security is off for it; measured
 * against a fused 44.7.2 binary. The page has no script of its own and makes no
 * request, it only answers `READ_ALL_LOCAL_STORAGE`, and it is closed as soon
 * as it has.
 */
export const STUB_VIEW_OPTIONS = {
	webPreferences: {
		sandbox: true,
		contextIsolation: true,
		nodeIntegration: false,
		webSecurity: false,
		// Electron turns this on with `webSecurity: false` unless told otherwise.
		allowRunningInsecureContent: false,
		spellcheck: false,
	},
} as const;

/** The view main opens; structural so a test can stand in for it. */
export interface StubView {
	webContents: {
		loadURL(url: string): Promise<void>;
		executeJavaScript(code: string): Promise<unknown>;
		close(): void;
	};
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`No answer from the file: origin in ${ms} ms`)),
			ms
		);
	});
	return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Every localStorage entry on the `file://` origin, read by writing a stub
 * page to @p stubFile, loading it in the view @p openView returns and asking
 * it. Chromium keys every local `file:` document to the one `file://` origin,
 * so the stub reads what the old `dist/index.html` wrote wherever it lives.
 * The view is closed and the stub deleted before this settles, either way.
 */
export async function readFileOriginStorage(
	openView: () => StubView,
	stubFile: string,
	timeoutMs: number = LEGACY_STORAGE_READ_TIMEOUT_MS
): Promise<unknown> {
	await fs.writeFile(stubFile, STUB_HTML);
	let view: StubView | null = null;
	try {
		view = openView();
		const { webContents } = view;
		const read = webContents
			.loadURL(pathToFileURL(stubFile).toString())
			.then(() => webContents.executeJavaScript(READ_ALL_LOCAL_STORAGE));
		return await withTimeout(read, timeoutMs);
	} finally {
		view?.webContents.close();
		await fs.rm(stubFile, { force: true });
	}
}

/** `legacy-storage-migration.json` under userData. */
export interface MigrationRecord {
	done?: boolean;
	attempts?: number;
}

export interface MigrationRecordStore {
	get<K extends keyof MigrationRecord>(key: K): MigrationRecord[K] | undefined;
	set<K extends keyof MigrationRecord>(key: K, value: MigrationRecord[K]): void;
}

export interface LegacyStorageMigrationDeps {
	record: MigrationRecordStore;
	/**
	 * Whether Chromium's Local Storage directory existed before this launch
	 * opened the profile, which creates it; absent on a fresh install.
	 */
	hasLegacyStore: () => boolean;
	/** `readFileOriginStorage` against a hidden view. */
	read: () => Promise<unknown>;
	log: (level: "info" | "warn", msg: string, fields?: Record<string, unknown>) => void;
}

/** What the preload reports once it has written; anything else counts as a failure. */
interface TakenReport {
	written: number;
	kept: number;
	failed: number;
}

function parseReport(report: unknown): TakenReport {
	const field = (name: keyof TakenReport): number => {
		const value = (report as Record<string, unknown> | null)?.[name];
		return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : -1;
	};
	const parsed = { written: field("written"), kept: field("kept"), failed: field("failed") };
	return parsed.written < 0 || parsed.kept < 0 || parsed.failed < 0
		? { written: 0, kept: 0, failed: 1 }
		: parsed;
}

export interface LegacyStorageMigration {
	/** Reads the old origin when a hand-off is due. Never rejects. */
	prepare(): Promise<void>;
	/** Whether entries are held for the window; main then adds `LEGACY_STORAGE_ARG`. */
	hasPending(): boolean;
	/** The held entries, or null. Held until `taken`, so a reload before the report asks again. */
	take(): LegacyEntries | null;
	/** The preload's report: the hand-off is done, unless a write failed. */
	taken(report: unknown): void;
}

export function createLegacyStorageMigration(
	deps: LegacyStorageMigrationDeps
): LegacyStorageMigration {
	let pending: LegacyEntries | null = null;

	const markDone = (): void => deps.record.set("done", true);

	/** Starts an attempt; false when none is due. */
	const beginAttempt = (): boolean => {
		if (deps.record.get("done") === true) return false;
		const attempts = deps.record.get("attempts") ?? 0;
		if (attempts >= LEGACY_STORAGE_MAX_ATTEMPTS) return false;
		if (!deps.hasLegacyStore()) {
			// Nothing was ever persisted on file://, and nothing will be now.
			markDone();
			return false;
		}
		deps.record.set("attempts", attempts + 1);
		return true;
	};

	const nextLaunch = (): string =>
		(deps.record.get("attempts") ?? 0) >= LEGACY_STORAGE_MAX_ATTEMPTS
			? "giving up"
			: "retrying next launch";

	return {
		async prepare() {
			try {
				if (!beginAttempt()) return;
				const entries = vayuEntries(await deps.read());
				if (Object.keys(entries).length === 0) {
					markDone();
					return;
				}
				pending = entries;
			} catch (error) {
				deps.log("warn", `Could not read the file: origin's saved state; ${nextLaunch()}`, {
					error: String(error),
				});
			}
		},
		hasPending: () => pending !== null,
		take: () => pending,
		taken(report) {
			if (pending === null) return;
			pending = null;
			const result = parseReport(report);
			try {
				if (result.failed > 0) {
					deps.log("warn", `Some saved state did not carry over; ${nextLaunch()}`, {
						...result,
					});
					return;
				}
				markDone();
				deps.log("info", "Carried saved state over from the file: origin", { ...result });
			} catch (error) {
				deps.log("warn", "Could not record the saved-state hand-off", {
					error: String(error),
				});
			}
		},
	};
}

interface IpcSyncEvent extends IpcSenderLike {
	returnValue?: unknown;
}

interface IpcOnLike {
	on(channel: string, listener: (event: IpcSyncEvent, ...args: unknown[]) => void): unknown;
}

/**
 * The two channels, answered only for the app window's main frame: the
 * entries are the user's whole saved state. `returnValue` is set on every
 * path, because a `sendSync` whose handler leaves it unset blocks the renderer
 * for good.
 */
export function registerLegacyStorageIpc(
	ipc: IpcOnLike,
	migration: Pick<LegacyStorageMigration, "take" | "taken">,
	isAppFrame: (event: IpcSenderLike) => boolean
): void {
	ipc.on(LEGACY_STORAGE_TAKE_CHANNEL, (event) => {
		event.returnValue = isAppFrame(event) ? migration.take() : null;
	});
	ipc.on(LEGACY_STORAGE_TAKEN_CHANNEL, (event, report) => {
		if (isAppFrame(event)) migration.taken(report);
	});
}
