/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The preload's report of a picked file (#2356), from both sides.
 *
 * Main records whatever arrives on `FILE_PICKED_CHANNEL` as a file a person
 * chose, and the engine then sends it. The one thing keeping a compromised
 * renderer from minting such a path is that only the preload sends on that
 * channel, and only with what `webUtils.getPathForFile` answered for a real
 * `File`. The behaviour is driven by running the preload against a fake
 * `electron`; the "only" is a source scan, because no behavioural test can
 * enumerate every method a future edit might add.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { transformWithOxc } from "vite";
import { FILE_PICKED_CHANNEL } from "./file-grants";

const preloadSource = readFileSync(new URL("./preload.ts", import.meta.url), "utf8");

interface PreloadApi {
	getFilePath: (file: unknown) => string;
}

/** Run the preload with a fake `electron`, answering what it exposed and what it sent. */
async function loadPreload(getPathForFile: (file: unknown) => string) {
	const { code } = await transformWithOxc(preloadSource, "preload.ts", { lang: "ts" });
	let api: PreloadApi | undefined;
	const ipcRenderer = {
		send: vi.fn(),
		sendSync: vi.fn(),
		invoke: vi.fn(),
		on: vi.fn(),
		removeListener: vi.fn(),
	};
	const electron = {
		contextBridge: {
			exposeInMainWorld: (_name: string, value: PreloadApi) => {
				api = value;
			},
		},
		ipcRenderer,
		webFrame: {},
		webUtils: { getPathForFile },
	};
	const requireElectron = (name: string) => {
		if (name !== "electron") throw new Error(`preload required ${name}`);
		return electron;
	};
	// The preload is a CommonJS script evaluated with these three in scope.
	new Function("require", "process", "window", code)(
		requireElectron,
		{ argv: [], platform: "linux" },
		{ addEventListener: () => {} }
	);
	if (!api) throw new Error("the preload exposed nothing");
	return { api, ipcRenderer };
}

/** Every `ipcRenderer.<send|sendSync|invoke>(` call's first argument, as written. */
function ipcChannelArguments(source: string): string[] {
	return [...source.matchAll(/ipcRenderer\.(?:send|sendSync|invoke)\(\s*([^,)]+)/g)].map((m) =>
		m[1].trim()
	);
}

describe("getFilePath reports a picked file to main", () => {
	it("sends the path webUtils answered on the grant channel, and returns it", async () => {
		const file = { name: "body.bin" };
		const { api, ipcRenderer } = await loadPreload(() => "/home/ada/body.bin");

		expect(api.getFilePath(file)).toBe("/home/ada/body.bin");

		expect(ipcRenderer.send.mock.calls).toEqual([[FILE_PICKED_CHANNEL, "/home/ada/body.bin"]]);
	});

	it("sends nothing for a File with no path on this machine", async () => {
		const { api, ipcRenderer } = await loadPreload(() => "");

		expect(api.getFilePath({})).toBe("");

		expect(ipcRenderer.send).not.toHaveBeenCalled();
	});

	it("sends nothing, and answers empty, when webUtils refuses the object", async () => {
		const { api, ipcRenderer } = await loadPreload(() => {
			throw new TypeError("not a File");
		});

		expect(api.getFilePath("/etc/passwd")).toBe("");

		expect(ipcRenderer.send).not.toHaveBeenCalled();
	});
});

/*
 * Mutation check: add an exposed method that forwards its argument -
 * `grantPath: (p: string) => ipcRenderer.send(FILE_PICKED_CHANNEL, p)` - or
 * send `file.name` instead of `picked`, or spell the channel as a literal at a
 * second site; each reddens a case below.
 */
describe("only the picked path ever reaches the grant channel", () => {
	it("read a preload that declares the channel main listens on", () => {
		expect(preloadSource.length).toBeGreaterThan(10_000);
		const declared = /const FILE_PICKED_CHANNEL = "([^"]+)";/.exec(preloadSource)?.[1];
		expect(declared).toBe(FILE_PICKED_CHANNEL);
	});

	it("spells the channel once, in its declaration", () => {
		expect(preloadSource.split(`"${FILE_PICKED_CHANNEL}"`).length - 1).toBe(1);
		expect(preloadSource.split(`'${FILE_PICKED_CHANNEL}'`).length - 1).toBe(0);
		expect(preloadSource.split(`\`${FILE_PICKED_CHANNEL}\``).length - 1).toBe(0);
	});

	it("sends on it from one site, with the variable webUtils filled", () => {
		const calls = [
			...preloadSource.matchAll(
				/ipcRenderer\.send\(\s*FILE_PICKED_CHANNEL\s*,\s*(\w+)\s*\)/g
			),
		];
		expect(calls.map((m) => m[1])).toEqual(["picked"]);
		// No other reference in code (an alias, a wrapper) - comments aside.
		const codeUses = [...preloadSource.matchAll(/\bFILE_PICKED_CHANNEL\b(?!\s*=)/g)].filter(
			(m) => {
				const lineStart = preloadSource.lastIndexOf("\n", m.index) + 1;
				return !/^\s*(\*|\/\/)/.test(preloadSource.slice(lineStart, m.index));
			}
		);
		expect(codeUses).toHaveLength(1);
	});

	it("fills that variable from webUtils.getPathForFile and nothing else", () => {
		const assignments = [...preloadSource.matchAll(/\bpicked\s*=(?!=)\s*([^;\n]+)/g)].map((m) =>
			m[1].trim()
		);
		expect(assignments).toEqual(["webUtils.getPathForFile(file)"]);
	});

	it("names every other IPC channel as a string literal", () => {
		const channels = ipcChannelArguments(preloadSource);
		expect(channels.length).toBeGreaterThan(20);
		const computed = channels.filter(
			(arg) => !/^"[^"]+"$/.test(arg) && arg !== "FILE_PICKED_CHANNEL"
		);
		expect(computed).toEqual([]);
	});

	it("is not declared to the renderer", () => {
		const declarations = readFileSync(
			new URL("../src/types/electron.d.ts", import.meta.url),
			"utf8"
		);
		expect(declarations.length).toBeGreaterThan(0);
		expect(declarations).not.toContain(FILE_PICKED_CHANNEL);
		expect(declarations).not.toContain("FILE_PICKED_CHANNEL");
	});
});
