/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main process's copy of the picked-file grants (#2356): what it sends,
 * what it remembers, and what it does with an engine that is not there yet.
 */

import { describe, it, expect, vi } from "vitest";
import {
	FILE_PICKED_CHANNEL,
	createFileGrants,
	isRecordablePath,
	registerFilePickedIpc,
} from "./file-grants";
import type { EngineWrite, FileTrustRow } from "./file-trust-client";

const posixAbsolute = (p: string) => p.startsWith("/");
const windowsAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p);

function row(filePath: string): FileTrustRow {
	return { id: `fgrant_${filePath.length}`, path: filePath, createdAt: 1 };
}

/**
 * A fake engine holding a grant table. `canonical` maps a spelling to the path
 * the engine stores; `reachable` is whether it answers at all.
 */
function fakeEngine(initial: string[] = []) {
	const table = new Set(initial);
	const state = { reachable: true, refuse: null as number | null };
	const canonical = vi.fn(async (filePath: string) => {
		if (filePath.includes("missing")) throw new Error("ENOENT");
		return filePath.replace("/link/", "/real/");
	});
	const unreachable = { outcome: "unreachable", message: "fetch failed" } as const;
	const client = {
		createFileGrant: vi.fn(async (filePath: string): Promise<EngineWrite<FileTrustRow>> => {
			if (!state.reachable) return unreachable;
			if (state.refuse !== null) {
				return {
					outcome: "refused",
					status: state.refuse,
					code: "bad_request",
					message: "no",
				};
			}
			const stored = await canonical(filePath);
			if (table.has(stored)) {
				return { outcome: "refused", status: 409, code: "conflict", message: "already" };
			}
			table.add(stored);
			return { outcome: "done", value: row(stored) };
		}),
		listFileGrants: vi.fn(async (): Promise<EngineWrite<FileTrustRow[]>> => {
			if (!state.reachable) return unreachable;
			return { outcome: "done", value: [...table].map(row) };
		}),
	};
	const log = vi.fn();
	const grants = createFileGrants({ client, canonical, log });
	return { grants, client, state, table, log };
}

describe("createFileGrants", () => {
	it("records a picked path and answers it granted without asking the engine again", async () => {
		const { grants, client } = fakeEngine();
		await grants.sync();

		await expect(grants.record("/data/body.bin")).resolves.toBe(true);
		await expect(grants.isGranted("/data/body.bin")).resolves.toBe(true);

		expect(client.listFileGrants).toHaveBeenCalledOnce();
	});

	it("reads what earlier sessions granted from the engine", async () => {
		const { grants } = fakeEngine(["/data/old.bin"]);

		await expect(grants.isGranted("/data/old.bin")).resolves.toBe(true);
		await expect(grants.isGranted("/data/other.bin")).resolves.toBe(false);
	});

	it("compares canonical paths, the spelling the engine stores", async () => {
		const { grants } = fakeEngine();

		await grants.record("/link/body.bin");

		await expect(grants.isGranted("/real/body.bin")).resolves.toBe(true);
		await expect(grants.isGranted("/link/body.bin")).resolves.toBe(true);
	});

	it("takes the engine's 409 as granted, learning the stored spelling by a re-read", async () => {
		const { grants, client } = fakeEngine(["/real/body.bin"]);
		await grants.sync();

		await expect(grants.record("/link/body.bin")).resolves.toBe(true);
		await expect(grants.isGranted("/link/body.bin")).resolves.toBe(true);
		expect(client.listFileGrants).toHaveBeenCalledTimes(2);
	});

	it("answers false, without throwing, when the engine is down, and sends the path once it is up", async () => {
		const { grants, state, client } = fakeEngine();
		state.reachable = false;

		await expect(grants.record("/data/body.bin")).resolves.toBe(false);
		await expect(grants.isGranted("/data/body.bin")).resolves.toBe(false);

		state.reachable = true;
		await expect(grants.isGranted("/data/body.bin")).resolves.toBe(true);
		expect(client.createFileGrant).toHaveBeenCalledTimes(3);
	});

	it("drops a path the engine refuses, and does not send it again", async () => {
		const { grants, state, client, log } = fakeEngine();
		state.refuse = 400;

		await expect(grants.record("/data/dir")).resolves.toBe(false);
		state.refuse = null;
		await expect(grants.isGranted("/data/dir")).resolves.toBe(false);

		expect(client.createFileGrant).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			"The engine refused to record a picked file",
			expect.objectContaining({ status: 400 })
		);
	});

	it("re-reads the grants after an engine start", async () => {
		const { grants, client, table } = fakeEngine();
		await grants.sync();
		table.add("/data/migrated.bin");

		await expect(grants.isGranted("/data/migrated.bin")).resolves.toBe(false);
		grants.invalidate();
		await expect(grants.isGranted("/data/migrated.bin")).resolves.toBe(true);
		expect(client.listFileGrants).toHaveBeenCalledTimes(2);
	});

	it("answers false for a file that is no longer there", async () => {
		const { grants } = fakeEngine(["/data/missing.bin"]);

		await expect(grants.isGranted("/data/missing.bin")).resolves.toBe(false);
	});
});

describe("isRecordablePath", () => {
	it("follows the host's absolute-path rule, whichever host it is", () => {
		expect(isRecordablePath("C:\\data\\a.bin", windowsAbsolute)).toBe(true);
		expect(isRecordablePath("C:\\data\\a.bin", posixAbsolute)).toBe(false);
		expect(isRecordablePath("/data/a.bin", posixAbsolute)).toBe(true);
	});

	it("refuses an empty, relative, NUL-carrying or non-string path", () => {
		for (const candidate of ["", "a.bin", "/a\0b", 42, null, undefined, { path: "/a" }]) {
			expect(isRecordablePath(candidate, posixAbsolute), String(candidate)).toBe(false);
		}
	});
});

describe("registerFilePickedIpc", () => {
	function registered(isAppFrame: boolean) {
		let listener: ((event: unknown, ...args: unknown[]) => void) | undefined;
		const ipc = {
			on: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => void) => {
				expect(channel).toBe(FILE_PICKED_CHANNEL);
				listener = fn;
			}),
		};
		const record = vi.fn(async () => true);
		const log = vi.fn();
		registerFilePickedIpc(ipc, {
			grants: { record },
			isAppFrame: () => isAppFrame,
			isAbsolute: posixAbsolute,
			log,
		});
		const send = (...args: unknown[]) => listener?.({ sender: {} }, ...args);
		return { send, record, log };
	}

	it("records an absolute path the app window reports", () => {
		const { send, record } = registered(true);

		send("/data/body.bin");

		expect(record).toHaveBeenCalledWith("/data/body.bin");
	});

	it("records nothing reported from outside the app window's main frame", () => {
		const { send, record, log } = registered(false);

		send("/data/body.bin");

		expect(record).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledOnce();
	});

	it("records nothing that is not an absolute path", () => {
		const { send, record } = registered(true);

		for (const candidate of ["", "relative.bin", "/a\0b", 7, undefined]) send(candidate);

		expect(record).not.toHaveBeenCalled();
	});
});
