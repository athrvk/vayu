/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `file:` builds' saved state reaches the app scheme's origin once, and
 * never at the cost of what that origin already holds (#2380).
 *
 * Main's half is driven through the module with an in-memory record; the
 * preload's half by running the real preload against a fake `electron` and a
 * fake `localStorage`; and the two together by routing the preload's IPC into
 * the handlers main registers. main.ts itself can only be read, as
 * `startup-order.test.ts` does.
 *
 * Mutation checks: drop the preload's `getItem(key) !== null` test and the
 * never-overwrite cases go red; move `markDone()` from `taken` into `prepare`
 * and the flag-after-hand-off cases go red.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transformWithOxc } from "vite";
import { STORAGE_KEYS } from "../src/constants/storage-keys";
import type { IpcSenderLike } from "./ipc-sender.js";
import {
	LEGACY_STORAGE_ARG,
	LEGACY_STORAGE_MAX_ATTEMPTS,
	LEGACY_STORAGE_TAKE_CHANNEL,
	LEGACY_STORAGE_TAKEN_CHANNEL,
	READ_ALL_LOCAL_STORAGE,
	STUB_VIEW_OPTIONS,
	createLegacyStorageMigration,
	isVayuStorageKey,
	readFileOriginStorage,
	registerLegacyStorageIpc,
	vayuEntries,
	type LegacyStorageMigrationDeps,
	type MigrationRecord,
	type StubView,
} from "./legacy-storage-migration.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const preloadSource = readFileSync(path.join(here, "preload.ts"), "utf8");
const mainSource = readFileSync(path.join(here, "main.ts"), "utf8");

/** What a `file:` build left behind, with one key that is not the app's. */
const OLD_ORIGIN = {
	"vayu-theme-source": "dark",
	"vayu.spec-files": '{"state":{"c1":{"path":"/home/ada/spec.yaml"}},"version":1}',
	"vayu:lastLoadTestConfig": '{"vus":10}',
	"other-app": "not ours",
};

/** The JSON file's object, in memory, with every write recorded. */
function memoryRecord(initial: MigrationRecord = {}) {
	const data: MigrationRecord = { ...initial };
	const writes: Array<[keyof MigrationRecord, unknown]> = [];
	return {
		data,
		writes,
		get: <K extends keyof MigrationRecord>(key: K) => data[key],
		set: <K extends keyof MigrationRecord>(key: K, value: MigrationRecord[K]) => {
			writes.push([key, value]);
			data[key] = value;
		},
	};
}

type MemoryRecord = ReturnType<typeof memoryRecord>;

function migrationWith(
	overrides: Partial<Omit<LegacyStorageMigrationDeps, "record">> & { record?: MemoryRecord } = {}
) {
	const deps = {
		record: memoryRecord(),
		hasLegacyStore: () => true,
		read: vi.fn(async (): Promise<unknown> => ({ ...OLD_ORIGIN })),
		log: vi.fn(),
		...overrides,
	};
	return { migration: createLegacyStorageMigration(deps), ...deps };
}

describe("vayuEntries", () => {
	it("keeps the app's string entries and nothing else", () => {
		expect(
			vayuEntries({
				...OLD_ORIGIN,
				vayuish: "no separator",
				"VAYU-theme-source": "wrong case",
				"vayu.number": 5,
			})
		).toEqual({
			"vayu-theme-source": "dark",
			"vayu.spec-files": OLD_ORIGIN["vayu.spec-files"],
			"vayu:lastLoadTestConfig": '{"vus":10}',
		});
	});

	it.each([null, undefined, "text", 3, ["vayu.tabs", "x"]])("refuses %j", (answer) => {
		expect(() => vayuEntries(answer)).toThrow(/file: origin answered/);
	});

	it("passes every key the renderer persists", () => {
		const keys = Object.values(STORAGE_KEYS);
		expect(keys.length).toBeGreaterThan(15);
		expect(keys.filter((key) => !isVayuStorageKey(key))).toEqual([]);
	});
});

describe("READ_ALL_LOCAL_STORAGE", () => {
	it("answers every entry on the page's origin", () => {
		const entries = Object.entries(OLD_ORIGIN);
		const storage = {
			length: entries.length,
			key: (i: number) => entries[i][0],
			getItem: (key: string) => (OLD_ORIGIN as Record<string, string>)[key] ?? null,
		};
		const run = new Function("localStorage", `return ${READ_ALL_LOCAL_STORAGE};`);
		expect(run(storage)).toEqual(OLD_ORIGIN);
	});
});

describe("STUB_VIEW_OPTIONS", () => {
	it("is a sandboxed page with no preload, on the default session", () => {
		expect(STUB_VIEW_OPTIONS.webPreferences).not.toHaveProperty("preload");
		expect(STUB_VIEW_OPTIONS.webPreferences).not.toHaveProperty("partition");
		expect(STUB_VIEW_OPTIONS.webPreferences.sandbox).toBe(true);
		expect(STUB_VIEW_OPTIONS.webPreferences.nodeIntegration).toBe(false);
		// The fuse refuses a `file:` page localStorage otherwise; see the constant.
		expect(STUB_VIEW_OPTIONS.webPreferences.webSecurity).toBe(false);
	});
});

describe("readFileOriginStorage", () => {
	let tmp: string;
	let stubFile: string;

	beforeEach(() => {
		tmp = mkdtempSync(path.join(os.tmpdir(), "vayu-legacy-storage-"));
		stubFile = path.join(tmp, "stub.html");
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(tmp, { recursive: true, force: true });
	});

	function fakeView(
		loadURL: (url: string) => Promise<void>,
		executeJavaScript: (code: string) => Promise<unknown> = async () => ({ ...OLD_ORIGIN })
	) {
		const close = vi.fn();
		const view: StubView = { webContents: { loadURL, executeJavaScript, close } };
		return { view, close };
	}

	it("loads the stub from file:, answers what the page read, and cleans up", async () => {
		let stubAtLoad = "";
		const loaded: string[] = [];
		const ran: string[] = [];
		const { view, close } = fakeView(
			async (url) => {
				loaded.push(url);
				stubAtLoad = readFileSync(stubFile, "utf8");
			},
			async (code) => {
				ran.push(code);
				return { ...OLD_ORIGIN };
			}
		);

		await expect(readFileOriginStorage(() => view, stubFile)).resolves.toEqual(OLD_ORIGIN);

		expect(loaded).toEqual([pathToFileURL(stubFile).toString()]);
		expect(stubAtLoad).toMatch(/^<!doctype html>/);
		expect(stubAtLoad).not.toContain("<script");
		expect(ran).toEqual([READ_ALL_LOCAL_STORAGE]);
		expect(close).toHaveBeenCalledTimes(1);
		expect(existsSync(stubFile)).toBe(false);
	});

	it("rejects, closes the view and deletes the stub when the page refuses", async () => {
		const { view, close } = fakeView(
			async () => {},
			async () => {
				throw new Error("SecurityError: Access is denied for this document.");
			}
		);

		await expect(readFileOriginStorage(() => view, stubFile)).rejects.toThrow(
			/Access is denied/
		);
		expect(close).toHaveBeenCalledTimes(1);
		expect(existsSync(stubFile)).toBe(false);
	});

	it("gives up on a load that never settles", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { view, close } = fakeView(() => new Promise<void>(() => {}));
		// The deadline starts once the stub is on disk and the view is open; the
		// stub's write is real I/O, so the clock moves only after that.
		let opened!: () => void;
		const viewOpened = new Promise<void>((resolve) => (opened = resolve));

		const read = readFileOriginStorage(
			() => {
				opened();
				return view;
			},
			stubFile,
			5_000
		);
		const outcome = expect(read).rejects.toThrow(/No answer from the file: origin in 5000 ms/);
		await viewOpened;
		await vi.advanceTimersByTimeAsync(4_999);
		expect(close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await outcome;

		expect(close).toHaveBeenCalledTimes(1);
		expect(existsSync(stubFile)).toBe(false);
	});
});

describe("createLegacyStorageMigration", () => {
	it("holds the app's entries for the window after reading the old origin", async () => {
		const { migration, record, read } = migrationWith();

		await migration.prepare();

		expect(read).toHaveBeenCalledTimes(1);
		expect(migration.hasPending()).toBe(true);
		expect(migration.take()).toEqual({
			"vayu-theme-source": "dark",
			"vayu.spec-files": OLD_ORIGIN["vayu.spec-files"],
			"vayu:lastLoadTestConfig": '{"vus":10}',
		});
		// Taking is not the hand-off: the window has not written anything yet.
		expect(record.data.done).toBeUndefined();
		expect(record.data.attempts).toBe(1);
	});

	it("records the hand-off once, when the window reports it, and lets the entries go", async () => {
		const { migration, record, log } = migrationWith();
		await migration.prepare();

		migration.taken({ written: 3, kept: 0, failed: 0 });
		migration.taken({ written: 3, kept: 0, failed: 0 });

		expect(record.writes.filter(([key]) => key === "done")).toEqual([["done", true]]);
		expect(migration.hasPending()).toBe(false);
		expect(migration.take()).toBeNull();
		expect(log).toHaveBeenCalledWith(
			"info",
			expect.stringContaining("Carried saved state over"),
			{ written: 3, kept: 0, failed: 0 }
		);
	});

	it("ignores a report when nothing was handed out", () => {
		const { migration, record } = migrationWith();
		migration.taken({ written: 1, kept: 0, failed: 0 });
		expect(record.writes).toEqual([]);
	});

	it.each([
		["a write that failed", { written: 2, kept: 0, failed: 1 }],
		["a report that is not one", { written: "3" }],
		["no report", undefined],
	])("leaves the hand-off open after %s", async (_name, report) => {
		const { migration, record, log } = migrationWith();
		await migration.prepare();

		migration.taken(report);

		expect(record.data.done).toBeUndefined();
		expect(migration.hasPending()).toBe(false);
		expect(log).toHaveBeenCalledWith(
			"warn",
			expect.stringContaining("retrying next launch"),
			expect.objectContaining({ failed: expect.any(Number) })
		);
	});

	it("does not throw, set the flag or hold anything when the read fails", async () => {
		const { migration, record, log } = migrationWith({
			read: vi.fn(async () => {
				throw new Error("SecurityError: Access is denied for this document.");
			}),
		});

		await expect(migration.prepare()).resolves.toBeUndefined();

		expect(record.data.done).toBeUndefined();
		expect(migration.hasPending()).toBe(false);
		expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("retrying next launch"), {
			error: expect.stringContaining("Access is denied"),
		});
	});

	it(`retries a failed read on the next launch, ${LEGACY_STORAGE_MAX_ATTEMPTS} launches in all`, async () => {
		const record = memoryRecord();
		const read = vi.fn(async (): Promise<unknown> => {
			throw new Error("no answer");
		});
		const log = vi.fn();
		for (let launch = 0; launch < LEGACY_STORAGE_MAX_ATTEMPTS + 2; launch++) {
			await createLegacyStorageMigration({
				record,
				hasLegacyStore: () => true,
				read,
				log,
			}).prepare();
		}

		expect(read).toHaveBeenCalledTimes(LEGACY_STORAGE_MAX_ATTEMPTS);
		expect(record.data.attempts).toBe(LEGACY_STORAGE_MAX_ATTEMPTS);
		expect(record.data.done).toBeUndefined();
		expect(log.mock.calls[log.mock.calls.length - 1][1]).toContain("giving up");
	});

	it("is a no-op on the launch after a hand-off", async () => {
		const { migration, record, read } = migrationWith({ record: memoryRecord({ done: true }) });

		await migration.prepare();

		expect(read).not.toHaveBeenCalled();
		expect(migration.hasPending()).toBe(false);
		expect(record.writes).toEqual([]);
	});

	it("marks a fresh install done without opening anything", async () => {
		const { migration, record, read } = migrationWith({ hasLegacyStore: () => false });

		await migration.prepare();

		expect(read).not.toHaveBeenCalled();
		expect(migration.hasPending()).toBe(false);
		expect(record.data).toEqual({ done: true });
	});

	it("marks an old origin with none of the app's keys done without a hand-off", async () => {
		const { migration, record } = migrationWith({
			read: vi.fn(async () => ({ "other-app": "not ours" })),
		});

		await migration.prepare();

		expect(migration.hasPending()).toBe(false);
		expect(record.data.done).toBe(true);
	});

	it("does not reject when the record cannot be written", async () => {
		const record = memoryRecord();
		record.set = () => {
			throw new Error("ENOSPC");
		};
		const { migration, read, log } = migrationWith({ record });

		await expect(migration.prepare()).resolves.toBeUndefined();

		expect(read).not.toHaveBeenCalled();
		expect(migration.hasPending()).toBe(false);
		expect(log).toHaveBeenCalledWith("warn", expect.any(String), {
			error: expect.stringContaining("ENOSPC"),
		});
	});
});

type Listener = (event: IpcSenderLike & { returnValue?: unknown }, ...args: unknown[]) => void;

/** The handlers main registers, and a way to deliver a message to one. */
function registeredIpc(
	migration: Parameters<typeof registerLegacyStorageIpc>[1],
	fromApp: boolean
) {
	const listeners = new Map<string, Listener>();
	registerLegacyStorageIpc(
		{ on: (channel: string, listener: Listener) => listeners.set(channel, listener) },
		migration,
		() => fromApp
	);
	const deliver = (channel: string, ...args: unknown[]) => {
		const event: IpcSenderLike & { returnValue?: unknown } = { sender: {}, senderFrame: {} };
		const listener = listeners.get(channel);
		if (!listener) throw new Error(`nothing listens on ${channel}`);
		listener(event, ...args);
		return event;
	};
	return { listeners, deliver };
}

describe("registerLegacyStorageIpc", () => {
	it("answers the app window with the held entries", () => {
		const migration = { take: () => ({ "vayu.tabs": "{}" }), taken: vi.fn() };
		const { listeners, deliver } = registeredIpc(migration, true);

		expect([...listeners.keys()]).toEqual([
			LEGACY_STORAGE_TAKE_CHANNEL,
			LEGACY_STORAGE_TAKEN_CHANNEL,
		]);
		expect(deliver(LEGACY_STORAGE_TAKE_CHANNEL).returnValue).toEqual({ "vayu.tabs": "{}" });
		deliver(LEGACY_STORAGE_TAKEN_CHANNEL, { written: 1, kept: 0, failed: 0 });
		expect(migration.taken).toHaveBeenCalledWith({ written: 1, kept: 0, failed: 0 });
	});

	it("answers anything else with null, still answering, and ignores its report", () => {
		const migration = { take: vi.fn(() => ({ "vayu.tabs": "{}" })), taken: vi.fn() };
		const { deliver } = registeredIpc(migration, false);

		const event = deliver(LEGACY_STORAGE_TAKE_CHANNEL);
		expect(event).toHaveProperty("returnValue", null);
		deliver(LEGACY_STORAGE_TAKEN_CHANNEL, { written: 0, kept: 0, failed: 0 });
		expect(migration.take).not.toHaveBeenCalled();
		expect(migration.taken).not.toHaveBeenCalled();
	});
});

/** A `localStorage` over a Map, with every write recorded. */
function fakeStorage(initial: Record<string, string> = {}, refuse = new Set<string>()) {
	const items = new Map(Object.entries(initial));
	const setItem = vi.fn((key: string, value: string) => {
		if (refuse.has(key)) throw new DOMException("quota", "QuotaExceededError");
		items.set(key, value);
	});
	return {
		items,
		setItem,
		storage: { getItem: (key: string) => items.get(key) ?? null, setItem },
	};
}

/** Run the real preload with a fake `electron`, this argv and this storage. */
async function runPreload(options: {
	argv: string[];
	storage: ReturnType<typeof fakeStorage>["storage"];
	sendSync: (channel: string) => unknown;
	send?: (channel: string, ...args: unknown[]) => void;
}) {
	const { code } = await transformWithOxc(preloadSource, "preload.ts", { lang: "ts" });
	const ipcRenderer = {
		send: vi.fn(options.send ?? (() => {})),
		sendSync: vi.fn(options.sendSync),
		invoke: vi.fn(),
		on: vi.fn(),
		removeListener: vi.fn(),
	};
	const electron = {
		contextBridge: { exposeInMainWorld: () => {} },
		ipcRenderer,
		webFrame: {},
		webUtils: {},
	};
	new Function("require", "process", "window", code)(
		(name: string) => {
			if (name !== "electron") throw new Error(`preload required ${name}`);
			return electron;
		},
		{ argv: options.argv, platform: "linux" },
		{ addEventListener: () => {}, localStorage: options.storage }
	);
	return ipcRenderer;
}

describe("the preload's half", () => {
	it("asks for nothing unless main flagged a pending hand-off", async () => {
		const { storage, setItem } = fakeStorage();
		const ipc = await runPreload({ argv: [], storage, sendSync: () => ({ ...OLD_ORIGIN }) });

		expect(ipc.sendSync).not.toHaveBeenCalled();
		expect(setItem).not.toHaveBeenCalled();
	});

	it("writes each key the origin lacks and never overwrites one it has", async () => {
		const { storage, setItem, items } = fakeStorage({ "vayu-theme-source": "light" });
		const ipc = await runPreload({
			argv: [LEGACY_STORAGE_ARG],
			storage,
			sendSync: () => ({
				"vayu-theme-source": "dark",
				"vayu.spec-files": OLD_ORIGIN["vayu.spec-files"],
			}),
		});

		expect(ipc.sendSync.mock.calls).toEqual([[LEGACY_STORAGE_TAKE_CHANNEL]]);
		expect(setItem.mock.calls).toEqual([["vayu.spec-files", OLD_ORIGIN["vayu.spec-files"]]]);
		expect(items.get("vayu-theme-source")).toBe("light");
		expect(ipc.send.mock.calls).toEqual([
			[LEGACY_STORAGE_TAKEN_CHANNEL, { written: 1, kept: 1, failed: 0 }],
		]);
	});

	it("counts a refused write and carries on", async () => {
		const { storage, items } = fakeStorage({}, new Set(["vayu.spec-files"]));
		const ipc = await runPreload({
			argv: [LEGACY_STORAGE_ARG],
			storage,
			sendSync: () => ({ "vayu.spec-files": "{}", "vayu-theme-source": "dark" }),
		});

		expect(items.get("vayu-theme-source")).toBe("dark");
		expect(ipc.send.mock.calls).toEqual([
			[LEGACY_STORAGE_TAKEN_CHANNEL, { written: 1, kept: 0, failed: 1 }],
		]);
	});

	it("reports nothing when main holds nothing", async () => {
		const { storage } = fakeStorage();
		const ipc = await runPreload({ argv: [LEGACY_STORAGE_ARG], storage, sendSync: () => null });

		expect(ipc.send).not.toHaveBeenCalled();
	});

	it("spells the flag and both channels the way main does", () => {
		expect(preloadSource.length).toBeGreaterThan(10_000);
		expect(preloadSource).toContain(`argv.includes("${LEGACY_STORAGE_ARG}")`);
		expect(preloadSource).toContain(`ipcRenderer.sendSync("${LEGACY_STORAGE_TAKE_CHANNEL}")`);
		expect(preloadSource).toContain(
			`ipcRenderer.send("${LEGACY_STORAGE_TAKEN_CHANNEL}", report)`
		);
	});
});

describe("main and the preload together", () => {
	it("hands the old origin over once and records it only after the window wrote it", async () => {
		const { migration, record } = migrationWith();
		await migration.prepare();
		const { deliver } = registeredIpc(migration, true);
		const { storage, items } = fakeStorage({ "vayu-theme-source": "light" });
		let doneWhenAsked: boolean | undefined;

		await runPreload({
			argv: migration.hasPending() ? [LEGACY_STORAGE_ARG] : [],
			storage,
			sendSync: (channel) => {
				doneWhenAsked = record.data.done;
				return deliver(channel).returnValue;
			},
			send: (channel, ...args) => void deliver(channel, ...args),
		});

		expect(doneWhenAsked).toBeUndefined();
		expect(record.data.done).toBe(true);
		expect(Object.fromEntries(items)).toEqual({
			"vayu-theme-source": "light",
			"vayu.spec-files": OLD_ORIGIN["vayu.spec-files"],
			"vayu:lastLoadTestConfig": '{"vus":10}',
		});
		expect(migration.hasPending()).toBe(false);
	});
});

describe("main.ts wiring", () => {
	it("read the real main.ts", () => {
		expect(mainSource.length).toBeGreaterThan(1000);
		expect(mainSource).toContain("app.whenReady().then(");
	});

	it("reads the old origin before it creates the window, packaged only", () => {
		const readyAt = mainSource.indexOf("app.whenReady().then(");
		const prepareAt = mainSource.indexOf(
			"const legacyStorageRead = isDev ? Promise.resolve() : legacyStorage.prepare();"
		);
		const awaitAt = mainSource.indexOf("\n\tawait legacyStorageRead;\n\tcreateWindow();");

		expect(prepareAt).toBeGreaterThan(readyAt);
		expect(awaitAt).toBeGreaterThan(prepareAt);
		// The first window is the startup one; the macOS activate rebuild comes later.
		expect(awaitAt).toBeLessThan(mainSource.indexOf("\n\tcreateWindow();"));
	});

	it("looks for the old store at module scope, before the profile creates it", () => {
		// Measured: the directory exists by `whenReady` even on a fresh install,
		// so a check made there would open the stub on every first launch.
		const lookAt = mainSource.indexOf(
			'\nconst hadLocalStorage = existsSync(path.join(app.getPath("userData"), "Local Storage"));'
		);

		expect(lookAt).toBeGreaterThan(mainSource.indexOf('app.setPath("userData"'));
		expect(lookAt).toBeLessThan(mainSource.indexOf("app.whenReady().then("));
		expect(mainSource).toContain("hasLegacyStore: () => hadLocalStorage,");
	});

	it("registers the channels ahead of the window that sends on them", () => {
		const setupAt = mainSource.indexOf("\nfunction setupIpcHandlers()");
		const setupEnd = mainSource.indexOf("\n}\n", setupAt);
		const setupBody = mainSource.slice(setupAt, setupEnd);

		expect(setupBody).toContain(
			"registerLegacyStorageIpc(ipcMain, legacyStorage, isAppFrame);"
		);
		expect(mainSource.indexOf("\n\tsetupIpcHandlers();")).toBeLessThan(
			mainSource.indexOf("\n\tcreateWindow();")
		);
	});

	it("flags the window only while entries are held", () => {
		expect(mainSource).toContain(
			"...(legacyStorage.hasPending() ? [LEGACY_STORAGE_ARG] : []),"
		);
	});

	it("reads through a view that is no window, on the stub options", () => {
		expect(mainSource).toContain("() => new WebContentsView(STUB_VIEW_OPTIONS),");
		expect(mainSource.split("STUB_VIEW_OPTIONS")).toHaveLength(3);
	});
});
