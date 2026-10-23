/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A TUF repository signed with a throwaway key, for tests of the Sigstore
 * trusted-root refresh. The real repository's metadata expires within days, so
 * a recording of it cannot be replayed; this one is genuine TUF to `tuf-js`
 * (every signature, hash and length is checked) and expires in 2099.
 *
 * One key signs every role, the consistent-snapshot flag is off so the files
 * keep their plain names, and the cache is pre-seeded with this repository's
 * root instead of the embedded Sigstore one - which is also how a cache an
 * earlier build wrote looks to the new code.
 */

export const TUF_MIRROR = "https://tuf-repo-cdn.sigstore.dev";
/** The directory `@sigstore/tuf` caches this mirror under, inside the cache path. */
export const TUF_REPO_DIR = "tuf-repo-cdn.sigstore.dev";

const EXPIRES = "2099-01-01T00:00:00Z";
const ED25519_SPKI_PREFIX_BYTES = 12;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** TUF's canonical JSON for the shapes used here: sorted keys, no whitespace. */
function canonical(value: Json): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const members = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
		return `{${members.join(",")}}`;
	}
	return JSON.stringify(value);
}

export interface TufRepo {
	/** The `root.json` a cache starts from. */
	rootJson: Buffer;
	/** The mirror's answer for a URL: the file, or a 404 when it has none. */
	respond(url: string): Response;
	/** Writes `rootJson` where the cache for `cachePath` expects it. */
	seedCache(cachePath: string): string;
}

/** `targets` maps a target name to its bytes, served under `<mirror>/targets/<name>`. */
export function buildTufRepo(targets: Record<string, Buffer>): TufRepo {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const keyval = {
		public: publicKey
			.export({ format: "der", type: "spki" })
			.subarray(ED25519_SPKI_PREFIX_BYTES)
			.toString("hex"),
	};
	const key = { keytype: "ed25519", scheme: "ed25519", keyval };
	const keyid = createHash("sha256").update(canonical(key)).digest("hex");
	const role = { keyids: [keyid], threshold: 1 };

	const signed = (body: { [field: string]: Json }): Buffer => {
		const payload = { spec_version: "1.0.31", version: 1, expires: EXPIRES, ...body };
		const sig = sign(null, Buffer.from(canonical(payload)), privateKey).toString("hex");
		return Buffer.from(JSON.stringify({ signatures: [{ keyid, sig }], signed: payload }));
	};

	const rootJson = signed({
		_type: "root",
		consistent_snapshot: false,
		keys: { [keyid]: key },
		roles: { root: role, timestamp: role, snapshot: role, targets: role },
	});
	const files = new Map<string, Buffer>([
		[
			"timestamp.json",
			signed({ _type: "timestamp", meta: { "snapshot.json": { version: 1 } } }),
		],
		["snapshot.json", signed({ _type: "snapshot", meta: { "targets.json": { version: 1 } } })],
		[
			"targets.json",
			signed({
				_type: "targets",
				targets: Object.fromEntries(
					Object.entries(targets).map(([name, bytes]) => [
						name,
						{
							length: bytes.length,
							hashes: { sha256: createHash("sha256").update(bytes).digest("hex") },
						},
					])
				),
			}),
		],
		...Object.entries(targets).map(([name, bytes]): [string, Buffer] => [
			`targets/${name}`,
			bytes,
		]),
	]);

	return {
		rootJson,
		respond: (url) => {
			const file = url.startsWith(`${TUF_MIRROR}/`)
				? files.get(url.slice(TUF_MIRROR.length + 1))
				: undefined;
			return file
				? new Response(new Uint8Array(file))
				: new Response("not found", { status: 404 });
		},
		seedCache: (cachePath) => {
			const repoDir = path.join(cachePath, TUF_REPO_DIR);
			mkdirSync(repoDir, { recursive: true });
			writeFileSync(path.join(repoDir, "root.json"), rootJson);
			return repoDir;
		},
	};
}
