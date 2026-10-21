/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The main process's copy of the allowed folders (#2357): read once and reused,
 * re-read after anything that can change it, and empty - never guessed - when
 * the engine cannot be asked.
 */

import { describe, it, expect, vi } from "vitest";
import { createFileRoots } from "./file-roots";
import type { EngineWrite, FileTrustRow } from "./file-trust-client";

function row(path: string): FileTrustRow {
	return { id: `froot_${path}`, path, createdAt: 1 };
}

/** A client whose answer the test sets between calls. */
function fakeClient(initial: EngineWrite<FileTrustRow[]>) {
	const state = { answer: initial };
	const listFileRoots = vi.fn(async () => state.answer);
	return { state, client: { listFileRoots } };
}

const done = (...paths: string[]): EngineWrite<FileTrustRow[]> => ({
	outcome: "done",
	value: paths.map(row),
});
const unreachable: EngineWrite<FileTrustRow[]> = { outcome: "unreachable", message: "down" };

describe("createFileRoots", () => {
	it("reads the engine once and serves the copy until it is invalidated", async () => {
		const { client } = fakeClient(done("/a", "/b"));
		const roots = createFileRoots(client);

		await expect(roots.list()).resolves.toEqual(["/a", "/b"]);
		await expect(roots.list()).resolves.toEqual(["/a", "/b"]);
		expect(client.listFileRoots).toHaveBeenCalledOnce();
	});

	it("shares one read between questions asked while it is in flight", async () => {
		const { client } = fakeClient(done("/a"));
		const roots = createFileRoots(client);

		await Promise.all([roots.list(), roots.list(), roots.list()]);

		expect(client.listFileRoots).toHaveBeenCalledOnce();
	});

	it("re-reads after invalidate, so an added or removed folder shows", async () => {
		const { client, state } = fakeClient(done("/a"));
		const roots = createFileRoots(client);
		await roots.list();

		state.answer = done("/a", "/b");
		roots.invalidate();
		await expect(roots.list()).resolves.toEqual(["/a", "/b"]);

		state.answer = done();
		roots.invalidate();
		await expect(roots.list()).resolves.toEqual([]);
		expect(client.listFileRoots).toHaveBeenCalledTimes(3);
	});

	it("answers no folders when the engine cannot be asked, and asks again next time", async () => {
		const { client, state } = fakeClient(done("/a"));
		const roots = createFileRoots(client);
		await roots.list();

		state.answer = unreachable;
		roots.invalidate();
		await expect(roots.list()).resolves.toEqual([]);

		state.answer = done("/a");
		await expect(roots.list()).resolves.toEqual(["/a"]);
		expect(client.listFileRoots).toHaveBeenCalledTimes(3);
	});

	it("does not trust a read begun before an invalidate", async () => {
		let release: (value: EngineWrite<FileTrustRow[]>) => void = () => {};
		const held = new Promise<EngineWrite<FileTrustRow[]>>((resolve) => {
			release = resolve;
		});
		const listFileRoots = vi
			.fn<() => Promise<EngineWrite<FileTrustRow[]>>>()
			.mockResolvedValueOnce(done("/old"))
			.mockReturnValueOnce(held)
			.mockResolvedValue(done("/a", "/new"));
		const roots = createFileRoots({ listFileRoots });
		await expect(roots.list()).resolves.toEqual(["/old"]);

		roots.invalidate();
		const early = roots.list();
		roots.invalidate();
		release(done("/a"));
		// Neither the half-read list nor the copy from before the change.
		await expect(early).resolves.toEqual([]);

		await expect(roots.list()).resolves.toEqual(["/a", "/new"]);
		expect(listFileRoots).toHaveBeenCalledTimes(3);
	});
});
