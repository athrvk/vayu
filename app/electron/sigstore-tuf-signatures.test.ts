/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The embedded Sigstore root verifies under Electron's crypto, not only Node's.
 *
 * Every Sigstore TUF role is signed `ecdsa-sha2-nistp256`. `@tufjs/models`
 * 5.0.0 verified those with `crypto.verify(undefined, ...)`: OpenSSL (Node)
 * defaults the digest to SHA-256 for an EC key, BoringSSL (Electron) throws
 * `NO_DEFAULT_DIGEST`, `tuf-js` reads the throw as a bad signature, and the
 * updater refused every update with "root was signed by 0/3 keys". Vitest
 * runs under Node, so this stands in for BoringSSL by refusing the same call.
 *
 * Mutation check: pin `@tufjs/models` back to 5.0.0 (it passes `undefined`)
 * and the case fails with "root was signed by 0/3 keys".
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Updater } from "tuf-js";
import { SIGSTORE_TUF_MIRROR } from "./sigstore-trusted-root.js";

type Seeds = Record<string, { "root.json": string }>;
type TufRoot = { signed: { keys: Record<string, { keytype: string }> } };

const seeds = createRequire(import.meta.url)("@sigstore/tuf/seeds.json") as Seeds;
const embeddedRoot = Buffer.from(seeds[SIGSTORE_TUF_MIRROR]["root.json"], "base64");

const realVerify = crypto.verify;
let scratch: string | undefined;

afterEach(() => {
	vi.restoreAllMocks();
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = undefined;
});

/** BoringSSL's behaviour: a digest-less `verify` over an EC key is an error. */
function refuseDefaultDigest() {
	return vi.spyOn(crypto, "verify").mockImplementation(((algorithm, data, key, signature) => {
		// tuf-js passes `{ key: KeyObject, hashAlgorithm }`, not the KeyObject itself.
		const keyObject = (key as { key?: crypto.KeyObject }).key ?? (key as crypto.KeyObject);
		if (algorithm == null && keyObject.asymmetricKeyType === "ec") {
			throw new Error(
				"error:06000077:public key routines:OPENSSL_internal:NO_DEFAULT_DIGEST"
			);
		}
		return realVerify(algorithm, data, key, signature);
	}) as typeof crypto.verify);
}

describe("the embedded Sigstore root", () => {
	it("is signed with ECDSA keys, which is what the digest-less call broke", () => {
		const { keys } = (JSON.parse(embeddedRoot.toString()) as TufRoot).signed;

		const keyTypes = Object.values(keys).map((key) => key.keytype);

		expect(keyTypes.length).toBeGreaterThan(0);
		expect(keyTypes.every((type) => type.startsWith("ecdsa"))).toBe(true);
	});

	it("passes tuf-js's signature check when crypto.verify refuses a missing digest", () => {
		const verify = refuseDefaultDigest();
		const dir = mkdtempSync(path.join(tmpdir(), "vayu-tuf-signatures-"));
		scratch = dir;
		mkdirSync(path.join(dir, "targets"));
		writeFileSync(path.join(dir, "root.json"), embeddedRoot);

		// The constructor verifies the root against its own keys, the check that failed.
		expect(
			() =>
				new Updater({
					metadataBaseUrl: SIGSTORE_TUF_MIRROR,
					metadataDir: dir,
					targetBaseUrl: `${SIGSTORE_TUF_MIRROR}/targets`,
					targetDir: path.join(dir, "targets"),
				})
		).not.toThrow();
		expect(verify).toHaveBeenCalled();
		expect(verify.mock.calls.every(([algorithm]) => algorithm != null)).toBe(true);
	});
});
