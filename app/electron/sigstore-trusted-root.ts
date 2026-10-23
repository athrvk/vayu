/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The Sigstore public-good trusted root, refreshed over TUF through an
 * injected `fetch` (#2738).
 *
 * `@sigstore/tuf`'s `getTrustedRoot` would do the same, but the client behind
 * it downloads with Node's global `fetch`, which ignores the system proxy; on a
 * network that only reaches the internet through one, every refresh failed and
 * every update was refused. This builds the same `tuf-js` `Updater` itself
 * (what `@sigstore/tuf` does in `client.js` and `target.js`) with a fetcher
 * backed by the caller's `fetch` - Electron's `net.fetch` in the app - and the
 * same cache layout, so a cache an earlier build wrote stays valid.
 *
 * Imported on first use, with the TUF packages it pulls in.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { BaseFetcher, Updater } from "tuf-js";
import { DownloadHTTPError } from "tuf-js/dist/error.js";
import { UPDATE_TUF_REQUEST_RETRIES, UPDATE_TUF_REQUEST_TIMEOUT_MS } from "./constants.js";
import type { AttestationFetch } from "./update-attestation.js";

export const SIGSTORE_TUF_MIRROR = "https://tuf-repo-cdn.sigstore.dev";
const SERVER_ERROR_STATUS = 500;
const TRUSTED_ROOT_TARGET = "trusted_root.json";
const TARGETS_DIR = "targets";

type Seeds = Record<string, { "root.json": string; targets: Record<string, string> }>;

/** The roots `@sigstore/tuf` ships, which a cache is seeded from; `require` is how Node reads JSON. */
const require = createRequire(import.meta.url);

/**
 * Downloads TUF metadata and targets through `fetch`, retrying a thrown error
 * or a 5xx like `tuf-js`'s own fetcher does. A non-2xx answer is a
 * `DownloadHTTPError` because `Updater.loadRoot` reads a 403 or 404 on
 * `<n+1>.root.json` as "the root we hold is the newest" and stops there; any
 * other error type would fail every refresh at the first probe.
 */
class InjectedFetcher extends BaseFetcher {
	constructor(private readonly fetchUrl: AttestationFetch) {
		super();
	}

	async fetch(url: string): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
		for (let retriesLeft = UPDATE_TUF_REQUEST_RETRIES; ; retriesLeft--) {
			const response = await this.attempt(url, retriesLeft === 0);
			if (response) return bodyOf(url, response);
		}
	}

	/** The answer to settle on, or `undefined` for a transient failure to try again. */
	private async attempt(url: string, last: boolean): Promise<Response | undefined> {
		let response: Response;
		try {
			response = await this.fetchUrl(url, {
				signal: AbortSignal.timeout(UPDATE_TUF_REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			if (last) throw error;
			return undefined;
		}
		if (response.status < SERVER_ERROR_STATUS || last) return response;
		// An unread body would hold its connection open.
		await response.body?.cancel();
		return undefined;
	}
}

function bodyOf(url: string, response: Response): ReadableStream<Uint8Array<ArrayBuffer>> {
	if (!response.ok || !response.body) {
		throw new DownloadHTTPError(`GET ${url} answered HTTP ${response.status}`, response.status);
	}
	return response.body as ReadableStream<Uint8Array<ArrayBuffer>>;
}

/**
 * Refreshes the TUF metadata under `cachePath` and returns the trusted root it
 * attests. Throws on any failure: the caller refuses the update.
 */
export async function loadTrustedRoot(
	cachePath: string,
	fetch: AttestationFetch
): Promise<TrustedRoot> {
	// The directory name `@sigstore/tuf` derives from the mirror's host.
	const repoDir = path.join(cachePath, encodeURIComponent(new URL(SIGSTORE_TUF_MIRROR).host));
	seedCache(repoDir);

	const updater = new Updater({
		metadataBaseUrl: SIGSTORE_TUF_MIRROR,
		metadataDir: repoDir,
		targetBaseUrl: `${SIGSTORE_TUF_MIRROR}/${TARGETS_DIR}`,
		targetDir: path.join(repoDir, TARGETS_DIR),
		fetcher: new InjectedFetcher(fetch),
	});
	const file = await targetFile(updater);
	return TrustedRoot.fromJSON(JSON.parse(await readFile(file, "utf8")));
}

/**
 * `root.json` is the trust anchor and is written only when absent: a cache
 * holds the newest root the client has verified, which the embedded seed
 * predates. It is written last, so a seed interrupted midway is redone rather
 * than mistaken for a complete one.
 */
function seedCache(repoDir: string): void {
	const targetsDir = path.join(repoDir, TARGETS_DIR);
	mkdirSync(targetsDir, { recursive: true });
	const rootFile = path.join(repoDir, "root.json");
	if (existsSync(rootFile)) return;

	const seed = (require("@sigstore/tuf/seeds.json") as Seeds)[SIGSTORE_TUF_MIRROR];
	if (!seed) throw new Error(`no embedded root.json for ${SIGSTORE_TUF_MIRROR}`);
	for (const [name, base64] of Object.entries(seed.targets)) {
		writeFileSync(path.join(targetsDir, name), Buffer.from(base64, "base64"));
	}
	writeFileSync(rootFile, Buffer.from(seed["root.json"], "base64"));
}

/** The local path of the verified `trusted_root.json`, downloaded when the cache lacks it or holds a stale one. */
async function targetFile(updater: Updater): Promise<string> {
	const info = await step("refreshing the TUF metadata", () =>
		updater.getTargetInfo(TRUSTED_ROOT_TARGET)
	);
	if (!info) throw new Error(`the TUF repository has no ${TRUSTED_ROOT_TARGET}`);

	const cached = await updater.findCachedTarget(info);
	if (cached) return cached;
	return step(`downloading ${TRUSTED_ROOT_TARGET}`, () => updater.downloadTarget(info));
}

async function step<T>(doing: string, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`error ${doing}: ${reason}`, { cause: error });
	}
}
