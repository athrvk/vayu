/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `file:save` (#3246): the save dialog behind every export, which says
 * whether the file was written. The renderer picks the bytes and suggests a
 * name, so what is pinned is what it cannot do with them: name a folder, reach
 * the dialog from outside the app window, or hand over something that is
 * neither text nor bytes.
 *
 * Mutation checks: hand the dialog the renderer's name unreduced and the
 * traversal case reds; drop the `isAppFrame` gate and the refusal case reds.
 */

import { readFileSync } from "node:fs";
import path from "path";
import { describe, it, expect, vi } from "vitest";
import {
	registerSaveFileIpc,
	SAVE_FILE_CHANNEL,
	SAVE_FILE_MAX_BYTES,
	saveFile,
	saveableContents,
	suggestedFileName,
	type SaveFileIpcDeps,
} from "./save-file-ipc";
import type { IpcSenderLike } from "./ipc-sender";

const DOWNLOADS = "/home/ada/Downloads";

function depsWith(overrides: Partial<SaveFileIpcDeps> = {}) {
	return {
		showSaveDialog: vi.fn(async () => ({
			canceled: false,
			filePath: "/home/ada/out/report.json",
		})),
		defaultDirectory: () => DOWNLOADS,
		isAppFrame: vi.fn(() => true),
		log: vi.fn(),
		writeFile: vi.fn(async () => {}),
		...overrides,
	};
}

describe("saveFile", () => {
	it("writes the text where the user chose, and says where", async () => {
		const deps = depsWith();

		await expect(saveFile('{"a":1}', "report.json", deps)).resolves.toEqual({
			outcome: "saved",
			path: "/home/ada/out/report.json",
		});

		expect(deps.showSaveDialog).toHaveBeenCalledWith({
			defaultPath: path.join(DOWNLOADS, "report.json"),
		});
		expect(deps.writeFile).toHaveBeenCalledWith("/home/ada/out/report.json", '{"a":1}');
	});

	it("writes bytes as they are", async () => {
		const deps = depsWith();
		const bytes = new Uint8Array([0, 255, 7]);

		await saveFile(bytes, "body.bin", deps);

		expect(deps.writeFile).toHaveBeenCalledWith("/home/ada/out/report.json", bytes);
	});

	it("writes nothing when the user cancels", async () => {
		const deps = depsWith({
			showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: "" })),
		});

		await expect(saveFile("x", "a.txt", deps)).resolves.toEqual({ outcome: "cancelled" });

		expect(deps.writeFile).not.toHaveBeenCalled();
	});

	it("answers failed with the system's sentence when the write fails, and logs it", async () => {
		const deps = depsWith({
			writeFile: vi.fn(async () => {
				throw new Error("EACCES: permission denied, open '/home/ada/out/report.json'");
			}),
		});

		await expect(saveFile("x", "report.json", deps)).resolves.toEqual({
			outcome: "failed",
			message: "EACCES: permission denied, open '/home/ada/out/report.json'",
		});
		expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
	});

	it.each([
		["../../.ssh/authorized_keys", "authorized_keys"],
		["..\\..\\Windows\\System32\\drivers\\etc\\hosts", "hosts"],
		["C:report.json", "C-report.json"],
		["/etc/cron.d/job", "job"],
	])("opens the dialog in Downloads on the last segment of %j", async (name, expected) => {
		const deps = depsWith();

		await saveFile("x", name, deps);

		expect(deps.showSaveDialog).toHaveBeenCalledWith({
			defaultPath: path.join(DOWNLOADS, expected),
		});
	});

	it("refuses, before any dialog, contents that are neither text nor bytes", async () => {
		const deps = depsWith();

		await expect(saveFile({ text: "x" }, "a.txt", deps)).rejects.toThrow("text or bytes");
		await expect(saveFile(42, "a.txt", deps)).rejects.toThrow("text or bytes");

		expect(deps.showSaveDialog).not.toHaveBeenCalled();
	});

	it("refuses, before any dialog, a name that is not one", async () => {
		const deps = depsWith();

		await expect(saveFile("x", 7, deps)).rejects.toThrow("needs a name");
		await expect(saveFile("x", "a/..", deps)).rejects.toThrow("Not a file name");
		await expect(saveFile("x", "dir/", deps)).rejects.toThrow("Not a file name");

		expect(deps.showSaveDialog).not.toHaveBeenCalled();
	});
});

describe("suggestedFileName", () => {
	it("keeps an ordinary engine-chosen name as it is", () => {
		expect(suggestedFileName("Orders 2026-10-17 0841.run.json")).toBe(
			"Orders 2026-10-17 0841.run.json"
		);
	});

	it("replaces what Windows refuses in a name, and control characters", () => {
		expect(suggestedFileName('a<b>c"d|e?f*g\u0000h\nI.txt')).toBe("a-b-c-d-e-f-g-h-I.txt");
	});
});

describe("saveableContents", () => {
	it("takes text and bytes up to the cap, counting text as UTF-8", () => {
		expect(saveableContents("é")).toBe("é");
		const bytes = new Uint8Array(4);
		expect(saveableContents(bytes)).toBe(bytes);
	});

	it("refuses bytes over the cap", () => {
		// A view claiming more than the cap, without allocating a gigabyte.
		const oversized = Object.create(Uint8Array.prototype, {
			byteLength: { value: SAVE_FILE_MAX_BYTES + 1 },
		}) as Uint8Array;

		expect(() => saveableContents(oversized)).toThrow(`over the ${SAVE_FILE_MAX_BYTES}`);
	});
});

describe("registerSaveFileIpc", () => {
	function registered(deps: SaveFileIpcDeps) {
		const handlers = new Map<string, (event: IpcSenderLike, ...args: unknown[]) => unknown>();
		registerSaveFileIpc(
			{ handle: (channel, listener) => handlers.set(channel, listener) },
			deps
		);
		return handlers;
	}

	it("serves the one channel and saves for the app window", async () => {
		const deps = depsWith();
		const handlers = registered(deps);

		expect([...handlers.keys()]).toEqual([SAVE_FILE_CHANNEL]);
		await expect(
			handlers.get(SAVE_FILE_CHANNEL)!({ sender: {} }, "x", "a.txt")
		).resolves.toMatchObject({ outcome: "saved" });
	});

	it("refuses a sender that is not the app window, before any dialog", () => {
		const deps = depsWith({ isAppFrame: vi.fn(() => false) });
		const handler = registered(deps).get(SAVE_FILE_CHANNEL)!;

		expect(() => handler({ sender: {} }, "x", "a.txt")).toThrow("only from the Vayu window");

		expect(deps.showSaveDialog).not.toHaveBeenCalled();
		expect(deps.log).toHaveBeenCalledTimes(1);
	});
});

describe("the wiring", () => {
	const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
	const preload = read("./preload.ts");
	const main = read("./main.ts");

	it("is invoked by the preload and registered by main on the same channel", () => {
		expect(preload).toContain(
			`ipcRenderer.invoke("${SAVE_FILE_CHANNEL}", contents, suggestedName)`
		);
		expect(main).toContain("registerSaveFileIpc(ipcMain, {");
	});

	it("is declared to the renderer with the reply main gives", () => {
		const declarations = read("../src/types/electron.d.ts");
		expect(declarations).toContain(
			"saveFile: (contents: string | Uint8Array, suggestedName: string) => Promise<SaveFileReply>;"
		);
		for (const source of [preload, declarations]) {
			expect(source).toContain('{ outcome: "saved"; path: string }');
			expect(source).toContain('{ outcome: "cancelled" }');
			expect(source).toContain('{ outcome: "failed"; message: string }');
		}
	});
});
