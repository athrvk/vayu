/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The installer attestation gate (#2372), against a real bundle and no network.
 *
 * Fixtures under `__fixtures__/update-attestation/`, both fetched once on
 * 2026-10-22: GitHub's attestations response for the v0.44.0 AppImage
 * (`sha256:16f717c3…`, with the expiring `bundle_url` dropped) and the Sigstore
 * public-good `trusted_root.json` that `@sigstore/tuf` returned that day. The
 * cryptography runs for real against them.
 *
 * The AppImage itself (145 MB) is not checked in. A small stand-in file is
 * written instead, and `node:crypto`'s `createHash` is wrapped so that a digest
 * equal to the stand-in's real SHA-256 reads as the AppImage's. Every other
 * file hashes truly, so the mismatch cases go through the real path.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Verifier, type Signer } from "@sigstore/verify";

const { netFetch, getTrustedRoot, STAND_IN_SHA256, APPIMAGE_SHA256 } = vi.hoisted(() => ({
	netFetch: vi.fn(),
	getTrustedRoot: vi.fn(),
	/** sha256 of `STAND_IN_BYTES` below. */
	STAND_IN_SHA256: "dcc59f1768c11486293d38fbcc7c1c1d3be6003fa7ce7883e387eda7b61ca030",
	/** `Vayu-0.44.0-x86_64.AppImage`, as the v0.44.0 release lists it. */
	APPIMAGE_SHA256: "16f717c37afe492a215db2e0c2530891c9f0ce864604bd8bb10df9e1984b6eb3",
}));

vi.mock("electron", () => ({ net: { fetch: netFetch } }));
vi.mock("@sigstore/tuf", () => ({ getTrustedRoot }));
vi.mock("node:crypto", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:crypto")>();
	return {
		...real,
		createHash: (...args: Parameters<typeof real.createHash>) => {
			const hash = real.createHash(...args);
			const digest = hash.digest.bind(hash) as (encoding: "hex") => string;
			Object.assign(hash, {
				digest: (encoding: "hex") => {
					const hex = digest(encoding);
					return hex === STAND_IN_SHA256 ? APPIMAGE_SHA256 : hex;
				},
			});
			return hash;
		},
	};
});

import {
	verifyInstallerAttestation,
	type InstallerAttestationCheck,
	type SigstoreTrustedRoot,
} from "./update-attestation.js";

const STAND_IN_BYTES = "Vayu-0.44.0-x86_64.AppImage stand-in\n";
/** sha256("abc"), the FIPS 180-2 example: a file no attestation names. */
const OTHER_BYTES = "abc";
const OTHER_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const fixtures = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"__fixtures__",
	"update-attestation"
);
const readFixture = (name: string): unknown =>
	JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));

/*
 * The decoder from the very copy of `@sigstore/protobuf-specs` that
 * `@sigstore/verify` resolves. It is a transitive dependency, not one this
 * package lists, so it is reached through verify's own resolution.
 */
const { TrustedRoot } = createRequire(createRequire(import.meta.url).resolve("@sigstore/verify"))(
	"@sigstore/protobuf-specs"
) as { TrustedRoot: { fromJSON(json: unknown): SigstoreTrustedRoot } };
const trustedRoot = TrustedRoot.fromJSON(readFixture("sigstore-trusted-root.json"));

type AttestationsBody = { attestations: { bundle: Record<string, unknown> }[] };
const attestationsBody = () => readFixture("vayu-0.44.0-attestations.json") as AttestationsBody;
const realBundle = () => attestationsBody().attestations[0].bundle;

let scratch: string;
let standIn: string;
let other: string;
let cacheDir: string;

beforeAll(() => {
	scratch = mkdtempSync(path.join(tmpdir(), "vayu-attestation-"));
	standIn = path.join(scratch, "Vayu-0.44.0-x86_64.AppImage");
	other = path.join(scratch, "other.AppImage");
	cacheDir = path.join(scratch, "sigstore");
	writeFileSync(standIn, STAND_IN_BYTES);
	writeFileSync(other, OTHER_BYTES);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

afterEach(() => {
	vi.restoreAllMocks();
	netFetch.mockReset();
	getTrustedRoot.mockReset();
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

function answering(response: () => Response | Promise<Response>) {
	return vi.fn(async (_url: string, _init: RequestInit) => response());
}

function check(overrides: Partial<InstallerAttestationCheck> = {}): InstallerAttestationCheck {
	return {
		file: standIn,
		version: "0.44.0",
		sigstoreCacheDir: cacheDir,
		fetch: answering(() => json(attestationsBody())),
		trustedRoot,
		...overrides,
	};
}

const FULCIO_OID_ARC = "1.3.6.1.4.1.57264.1.";

/** A DER UTF8String, the form Fulcio writes its v2 extensions in (all short here). */
function der(text: string): Buffer {
	const body = Buffer.from(text, "utf8");
	return Buffer.concat([Buffer.from([0x0c, body.length]), body]);
}

/**
 * Lets the real verification run, then reports a different certificate
 * identity, as if a genuine Sigstore certificate had named another workflow,
 * repository or issuer. Only such a certificate can reach the policy, and none
 * exists for this repository to check in.
 */
function reportIdentity(
	rewrite: (identity: NonNullable<Signer["identity"]>) => Signer["identity"]
) {
	const original = Verifier.prototype.verify;
	vi.spyOn(Verifier.prototype, "verify").mockImplementation(function (this: Verifier, ...args) {
		const signer = original.apply(this, args);
		return { ...signer, identity: rewrite(signer.identity ?? {}) };
	});
}

function withExtension(arc: number, value: string) {
	return (identity: NonNullable<Signer["identity"]>) => ({
		...identity,
		oids: (identity.oids ?? []).map((entry) =>
			entry.oid?.id.join(".") === `${FULCIO_OID_ARC}${arc}`
				? { ...entry, value: der(value) }
				: entry
		),
	});
}

describe("verifyInstallerAttestation", () => {
	it("accepts the installer release.yml attested for the release it was offered under", async () => {
		const fetch = answering(() => json(attestationsBody()));

		await expect(verifyInstallerAttestation(check({ fetch }))).resolves.toEqual({ ok: true });

		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe(
			`https://api.github.com/repos/athrvk/vayu/attestations/sha256:${APPIMAGE_SHA256}`
		);
		expect(new Headers(init.headers).get("Accept")).toBe("application/vnd.github+json");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		// An injected root leaves the TUF cache alone.
		expect(getTrustedRoot).not.toHaveBeenCalled();
		expect(readdirSync(scratch)).not.toContain("sigstore");
	});

	it("asks Electron's net.fetch when no fetch is injected", async () => {
		netFetch.mockResolvedValue(json(attestationsBody()));

		await expect(verifyInstallerAttestation(check({ fetch: undefined }))).resolves.toEqual({
			ok: true,
		});
		expect(netFetch).toHaveBeenCalledWith(
			`https://api.github.com/repos/athrvk/vayu/attestations/sha256:${APPIMAGE_SHA256}`,
			expect.anything()
		);
	});

	it("loads the trusted root through @sigstore/tuf, cached in the directory it is given", async () => {
		getTrustedRoot.mockResolvedValue(trustedRoot);

		await expect(
			verifyInstallerAttestation(check({ trustedRoot: undefined }))
		).resolves.toEqual({ ok: true });
		expect(getTrustedRoot).toHaveBeenCalledWith({ cachePath: cacheDir });
	});

	it("refuses when the trusted root cannot be refreshed", async () => {
		getTrustedRoot.mockRejectedValue(new Error("error refreshing TUF metadata"));

		const result = await verifyInstallerAttestation(check({ trustedRoot: undefined }));
		expect(result).toEqual({
			ok: false,
			reason: "Couldn't load the Sigstore trusted root (error refreshing TUF metadata).",
		});
	});

	it("refuses a file the attestation does not name, after looking up that file's own digest", async () => {
		const fetch = answering(() => json(attestationsBody()));

		const result = await verifyInstallerAttestation(check({ file: other, fetch }));
		expect(result).toEqual({
			ok: false,
			reason: "The attestation does not name this installer's SHA-256.",
		});
		expect(fetch.mock.calls[0][0]).toBe(
			`https://api.github.com/repos/athrvk/vayu/attestations/sha256:${OTHER_SHA256}`
		);
	});

	it.each(["0.45.0", "0.43.0"])(
		"refuses the v0.44.0 installer offered as v%s",
		async (version) => {
			const result = await verifyInstallerAttestation(check({ version }));
			expect(result).toEqual({
				ok: false,
				reason: `The attestation was not signed by release.yml at v${version}.`,
			});
		}
	);

	it("refuses a certificate from another workflow in the repository", async () => {
		reportIdentity(
			withExtension(
				9,
				"https://github.com/athrvk/vayu/.github/workflows/docs.yml@refs/tags/v0.44.0"
			)
		);

		const result = await verifyInstallerAttestation(check());
		expect(result).toEqual({
			ok: false,
			reason: "The attestation was not signed by release.yml at v0.44.0.",
		});
	});

	it("refuses a certificate whose source repository is another one", async () => {
		reportIdentity(withExtension(12, "https://github.com/someone-else/vayu"));

		const result = await verifyInstallerAttestation(check());
		expect(result).toEqual({ ok: false, reason: "The attestation is not from athrvk/vayu." });
	});

	it("refuses a certificate issued to anything but GitHub Actions", async () => {
		reportIdentity((identity) => ({
			...identity,
			extensions: { issuer: "https://accounts.google.com" },
		}));

		const result = await verifyInstallerAttestation(check());
		expect(result).toEqual({
			ok: false,
			reason: "The attestation was not issued by GitHub Actions.",
		});
	});

	it("refuses a certificate that carries the build-signer extension twice", async () => {
		reportIdentity((identity) => ({
			...identity,
			oids: [
				...(identity.oids ?? []),
				{
					oid: { id: `${FULCIO_OID_ARC}9`.split(".").map(Number) },
					value: der(
						"https://github.com/athrvk/vayu/.github/workflows/docs.yml@refs/heads/x"
					),
				},
			],
		}));

		const result = await verifyInstallerAttestation(check());
		expect(result).toEqual({
			ok: false,
			reason: "The attestation was not signed by release.yml at v0.44.0.",
		});
	});

	it("refuses a statement rewritten to name another file", async () => {
		const body = attestationsBody();
		const envelope = body.attestations[0].bundle.dsseEnvelope as { payload: string };
		const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
		statement.subject.push({ name: "other.AppImage", digest: { sha256: OTHER_SHA256 } });
		envelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");

		const result = await verifyInstallerAttestation(
			check({ file: other, fetch: answering(() => json(body)) })
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toMatch(/^The attestation does not verify \(.+\)\.$/);
	});

	it("refuses a bundle that is not a Sigstore bundle", async () => {
		const result = await verifyInstallerAttestation(
			check({
				fetch: answering(() => json({ attestations: [{ bundle: { mediaType: "x" } }] })),
			})
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toMatch(/^The attestation does not verify/);
	});

	it("accepts when any one of several bundles passes", async () => {
		const body = { attestations: [{ bundle: { mediaType: "x" } }, { bundle: realBundle() }] };

		await expect(
			verifyInstallerAttestation(check({ fetch: answering(() => json(body)) }))
		).resolves.toEqual({ ok: true });
	});

	it("refuses an empty attestations list", async () => {
		const result = await verifyInstallerAttestation(
			check({ fetch: answering(() => json({ attestations: [] })) })
		);
		expect(result).toEqual({
			ok: false,
			reason: "GitHub has no attestation for this installer.",
		});
	});

	it("refuses on HTTP 404", async () => {
		const result = await verifyInstallerAttestation(
			check({ fetch: answering(() => json({ message: "Not Found" }, 404)) })
		);
		expect(result).toEqual({
			ok: false,
			reason: "GitHub has no attestation for this installer (HTTP 404).",
		});
	});

	it("refuses on HTTP 500", async () => {
		const result = await verifyInstallerAttestation(
			check({ fetch: answering(() => json({}, 500)) })
		);
		expect(result).toEqual({
			ok: false,
			reason: "Couldn't look up the installer's attestation (HTTP 500).",
		});
	});

	it("refuses on a network error", async () => {
		const fetch = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});

		const result = await verifyInstallerAttestation(check({ fetch }));
		expect(result).toEqual({
			ok: false,
			reason: "Couldn't reach GitHub for the installer's attestation (fetch failed).",
		});
	});

	it("refuses a response body that is not JSON", async () => {
		const result = await verifyInstallerAttestation(
			check({ fetch: answering(() => new Response("<html>", { status: 200 })) })
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toMatch(/^Couldn't read GitHub's attestation response/);
	});

	it("refuses an installer it cannot read, without asking GitHub", async () => {
		const fetch = answering(() => json(attestationsBody()));

		const result = await verifyInstallerAttestation(
			check({ file: path.join(scratch, "missing.AppImage"), fetch })
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toMatch(/^Couldn't read the downloaded installer \(/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses a version that is not a release version, without asking GitHub", async () => {
		const fetch = answering(() => json(attestationsBody()));

		const result = await verifyInstallerAttestation(
			check({ version: "0.44.0@refs/heads/master", fetch })
		);
		expect(result.ok).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});
});
