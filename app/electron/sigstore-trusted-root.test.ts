/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Sigstore trusted-root refresh (#2738): every request goes through the
 * `fetch` it is given, and the cache it keeps is the one `@sigstore/tuf` kept.
 *
 * The TUF repository is a signed throwaway (`tuf-repo.testkit.ts`) that
 * `tuf-js` verifies for real. Mutation check: make `InjectedFetcher.fetch`
 * call the global `fetch` instead of the one it was given and the cases that
 * stub the global to throw fail.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTrustedRoot } from "./sigstore-trusted-root.js";
import { buildTufRepo, TUF_MIRROR, TUF_REPO_DIR, type TufRepo } from "./tuf-repo.testkit.js";

const TARGET = "trusted_root.json";
// Not a real trusted root: the refresh hands the bytes to `TrustedRoot.fromJSON`,
// which reads the fields it knows and ignores the rest.
const TARGET_JSON = { mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1" };
const targetBytes = Buffer.from(JSON.stringify(TARGET_JSON));

let scratch: string;
let cachePath: string;
let repo: TufRepo;

beforeAll(() => {
	scratch = mkdtempSync(path.join(tmpdir(), "vayu-trusted-root-"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => {
	cachePath = mkdtempSync(path.join(scratch, "cache-"));
	repo = buildTufRepo({ [TARGET]: targetBytes });
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("the global fetch must not be used");
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

/** Records each request and answers from `repo`. */
function mirror() {
	return vi.fn(async (url: string, _init: RequestInit) => repo.respond(url));
}

const repoDir = () => path.join(cachePath, TUF_REPO_DIR);

describe("loadTrustedRoot", () => {
	it("downloads the root through the fetch it is given, never the global one", async () => {
		const fetch = mirror();
		repo.seedCache(cachePath);

		const root = await loadTrustedRoot(cachePath, fetch);

		expect(root.mediaType).toBe(TARGET_JSON.mediaType);
		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			`${TUF_MIRROR}/2.root.json`,
			`${TUF_MIRROR}/timestamp.json`,
			`${TUF_MIRROR}/snapshot.json`,
			`${TUF_MIRROR}/targets.json`,
			`${TUF_MIRROR}/targets/${TARGET}`,
		]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		// A request that never answers fails the refresh instead of holding the update.
		const [, init] = fetch.mock.calls[0];
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.signal?.aborted).toBe(false);
	});

	it("keeps the layout @sigstore/tuf used, so an existing cache stays valid", async () => {
		repo.seedCache(cachePath);
		const before = readFileSync(path.join(repoDir(), "root.json"));

		await loadTrustedRoot(cachePath, mirror());

		expect(readdirSync(repoDir()).sort()).toEqual([
			"root.json",
			"snapshot.json",
			"targets",
			"targets.json",
			"timestamp.json",
		]);
		expect(readdirSync(path.join(repoDir(), "targets"))).toEqual([TARGET]);
		// A cache that holds a root keeps it: the embedded seed is older.
		expect(readFileSync(path.join(repoDir(), "root.json"))).toEqual(before);
	});

	it("fetches only what changed when the cache is warm", async () => {
		repo.seedCache(cachePath);
		await loadTrustedRoot(cachePath, mirror());

		const fetch = mirror();
		await loadTrustedRoot(cachePath, fetch);

		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			`${TUF_MIRROR}/2.root.json`,
			`${TUF_MIRROR}/timestamp.json`,
		]);
	});

	describe("on an empty cache", () => {
		const { [TUF_MIRROR]: embedded } = createRequire(import.meta.url)(
			"@sigstore/tuf/seeds.json"
		) as Record<string, { "root.json": string; targets: Record<string, string> }>;
		const unreachable = vi.fn(async (_url: string, _init: RequestInit) => {
			throw new TypeError("fetch failed");
		});

		it("seeds root.json and the seed targets from @sigstore/tuf's embedded roots", async () => {
			await expect(loadTrustedRoot(cachePath, unreachable)).rejects.toThrow(
				"error refreshing the TUF metadata: fetch failed"
			);

			expect(readFileSync(path.join(repoDir(), "root.json"))).toEqual(
				Buffer.from(embedded["root.json"], "base64")
			);
			expect(readdirSync(path.join(repoDir(), "targets")).sort()).toEqual(
				Object.keys(embedded.targets).sort()
			);
			expect(Object.keys(embedded.targets).length).toBeGreaterThan(0);
		});

		it("seeds nothing outside the directory it was given", async () => {
			await loadTrustedRoot(cachePath, unreachable).catch(() => undefined);

			expect(readdirSync(cachePath)).toEqual([TUF_REPO_DIR]);
			expect(existsSync(path.join(repoDir(), "timestamp.json"))).toBe(false);
		});
	});

	it("rejects when the mirror has no trusted_root.json", async () => {
		repo = buildTufRepo({});
		repo.seedCache(cachePath);

		await expect(loadTrustedRoot(cachePath, mirror())).rejects.toThrow(
			"the TUF repository has no trusted_root.json"
		);
	});
});
