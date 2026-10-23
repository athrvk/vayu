/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Whether a downloaded installer is one `release.yml` built for this exact
 * release (#2372).
 *
 * The updater otherwise installs whatever the release's `latest*.yml` names,
 * and nothing is code-signed. The publish job attests every installer with
 * `actions/attest-build-provenance`, so the check is the one
 * `gh attestation verify --signer-workflow` makes (`install.sh` pins the same
 * workflow): look the file's SHA-256 up in GitHub's attestations API, verify
 * each Sigstore bundle against the public-good trusted root, then hold the
 * verified certificate to `release.yml` at tag `v<version>`. Pinning the tag,
 * not just the workflow, is what refuses an older genuine installer
 * re-uploaded under a newer release.
 *
 * The Sigstore packages are imported on first use: only the silent-install
 * platforms ever verify, and never before a download has finished.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { net } from "electron";
import type { Bundle } from "@sigstore/bundle";
import type { Signer, toTrustMaterial } from "@sigstore/verify";
import { REPO, UPDATE_ATTESTATION_REQUEST_TIMEOUT_MS } from "./constants.js";

export type AttestationResult = { ok: true } | { ok: false; reason: string };

/** The Sigstore trusted root as `@sigstore/verify` consumes it. */
export type SigstoreTrustedRoot = Parameters<typeof toTrustMaterial>[0];

export type AttestationFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface InstallerAttestationCheck {
	/** The downloaded installer. */
	file: string;
	/** The release it was downloaded for, without the `v`: `"0.44.0"`. */
	version: string;
	/**
	 * Where the TUF metadata and trusted root refreshed from the Sigstore CDN
	 * are cached (`sigstore-trusted-root.ts`); a directory under the app's
	 * `userData`. Laid out as `@sigstore/tuf` laid it out, so a cache an earlier
	 * build wrote is read as it stands.
	 */
	sigstoreCacheDir: string;
	/**
	 * Defaults to Electron's `net.fetch`, which follows the system proxy. One
	 * function serves the attestation lookup and the TUF refresh, so neither
	 * can bypass the proxy on its own.
	 */
	fetch?: AttestationFetch;
	/** Skips the TUF refresh entirely; tests inject a snapshot. */
	trustedRoot?: SigstoreTrustedRoot;
}

const REPOSITORY_URL = `https://github.com/${REPO}`;
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

/** Fulcio certificate extensions (github.com/sigstore/fulcio, docs/oid-info.md). */
const BUILD_SIGNER_URI_OID = [1, 3, 6, 1, 4, 1, 57264, 1, 9];
const SOURCE_REPOSITORY_URI_OID = [1, 3, 6, 1, 4, 1, 57264, 1, 12];

/** The tags `release.yml` publishes; nothing that could add a path or a ref to the identity. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Never throws: every failure, including one this module did not anticipate,
 * is a refusal with a reason, and there is no path that accepts after a
 * failure.
 */
export async function verifyInstallerAttestation(
	check: InstallerAttestationCheck
): Promise<AttestationResult> {
	try {
		return await verify(check);
	} catch (error) {
		return refuse(`Couldn't verify the update's attestation (${messageOf(error)}).`);
	}
}

async function verify(check: InstallerAttestationCheck): Promise<AttestationResult> {
	if (!RELEASE_VERSION.test(check.version)) {
		return refuse(`The update's version "${check.version}" is not a release version.`);
	}
	const digest = await attempt(
		() => sha256Hex(check.file),
		"Couldn't read the downloaded installer"
	);
	if (!digest.ok) return digest;

	const fetch = check.fetch ?? defaultFetch;
	const listed = await fetchBundles(digest.value, fetch);
	if (!listed.ok) return listed;

	const trustedRoot = check.trustedRoot
		? { ok: true as const, value: check.trustedRoot }
		: await attempt(
				() => loadTrustedRoot(check.sigstoreCacheDir, fetch),
				"Couldn't load the Sigstore trusted root"
			);
	if (!trustedRoot.ok) return trustedRoot;

	const verifyBundle = await bundleVerifier(trustedRoot.value);
	const reasons = new Set<string>();
	for (const json of listed.value) {
		const reason = bundleProblem(json, verifyBundle, digest.value, check.version);
		if (reason === undefined) return { ok: true };
		reasons.add(reason);
	}
	return refuse([...reasons].join(" "));
}

type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

async function attempt<T>(work: () => Promise<T>, failure: string): Promise<Attempt<T>> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		return refuse(`${failure} (${messageOf(error)}).`);
	}
}

function refuse(reason: string): { ok: false; reason: string } {
	return { ok: false, reason };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
	return net.fetch(url, init);
}

async function sha256Hex(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

async function fetchBundles(digest: string, fetch: AttestationFetch): Promise<Attempt<unknown[]>> {
	const url = `https://api.github.com/repos/${REPO}/attestations/sha256:${digest}`;
	const response = await attempt(
		() =>
			fetch(url, {
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: AbortSignal.timeout(UPDATE_ATTESTATION_REQUEST_TIMEOUT_MS),
			}),
		"Couldn't reach GitHub for the installer's attestation"
	);
	if (!response.ok) return response;
	if (response.value.status === 404) {
		return refuse("GitHub has no attestation for this installer (HTTP 404).");
	}
	if (!response.value.ok) {
		return refuse(
			`Couldn't look up the installer's attestation (HTTP ${response.value.status}).`
		);
	}
	const body = await attempt<unknown>(
		() => response.value.json(),
		"Couldn't read GitHub's attestation response"
	);
	if (!body.ok) return body;

	const attestations = (body.value as { attestations?: unknown } | null)?.attestations;
	if (!Array.isArray(attestations) || attestations.length === 0) {
		return refuse("GitHub has no attestation for this installer.");
	}
	return {
		ok: true,
		value: attestations.map((entry) => (entry as { bundle?: unknown } | null)?.bundle),
	};
}

async function loadTrustedRoot(
	cachePath: string,
	fetch: AttestationFetch
): Promise<SigstoreTrustedRoot> {
	const { loadTrustedRoot: refresh } = await import("./sigstore-trusted-root.js");
	return refresh(cachePath, fetch);
}

type VerifiedBundle = { bundle: Bundle; signer: Signer };
type BundleVerifier = (json: unknown) => VerifiedBundle;

/** Parses and cryptographically verifies one bundle; throws on any defect. */
async function bundleVerifier(trustedRoot: SigstoreTrustedRoot): Promise<BundleVerifier> {
	const [{ bundleFromJSON }, { Verifier, toSignedEntity, toTrustMaterial }] = await Promise.all([
		import("@sigstore/bundle"),
		import("@sigstore/verify"),
	]);
	// The default thresholds: one transparency-log entry, one SCT, one
	// timestamp. The certificate lives ten minutes, so it is checked at the
	// Rekor entry's integrated time, not now.
	const verifier = new Verifier(toTrustMaterial(trustedRoot));
	return (json) => {
		const bundle = bundleFromJSON(json);
		return { bundle, signer: verifier.verify(toSignedEntity(bundle)) };
	};
}

function bundleProblem(
	json: unknown,
	verifyBundle: BundleVerifier,
	digest: string,
	version: string
): string | undefined {
	let verified: VerifiedBundle;
	try {
		verified = verifyBundle(json);
	} catch (error) {
		return `The attestation does not verify (${messageOf(error)}).`;
	}
	return signerProblem(verified.signer, version) ?? statementProblem(verified.bundle, digest);
}

/** The verified certificate must be `release.yml`, in this repository, at `v<version>`. */
function signerProblem(signer: Signer, version: string): string | undefined {
	const identity = signer.identity;
	// The OIDC issuer extension: 1.3.6.1.4.1.57264.1.8, or the legacy .1.1.
	if (identity?.extensions?.issuer !== GITHUB_ACTIONS_ISSUER) {
		return "The attestation was not issued by GitHub Actions.";
	}
	if (!hasExtension(identity, SOURCE_REPOSITORY_URI_OID, REPOSITORY_URL)) {
		return `The attestation is not from ${REPO}.`;
	}
	const workflowRef = `${REPOSITORY_URL}/${RELEASE_WORKFLOW}@refs/tags/v${version}`;
	if (!hasExtension(identity, BUILD_SIGNER_URI_OID, workflowRef)) {
		return `The attestation was not signed by release.yml at v${version}.`;
	}
	return undefined;
}

/**
 * Exactly one extension with this OID, holding exactly this string. Compared
 * as DER, which is how Fulcio writes it, so the certificate's bytes are never
 * parsed here.
 */
function hasExtension(identity: Signer["identity"], oid: number[], expected: string): boolean {
	const matches = (identity?.oids ?? []).filter(
		(entry) => entry.oid?.id.length === oid.length && entry.oid.id.every((n, i) => n === oid[i])
	);
	return matches.length === 1 && matches[0].value.equals(derUtf8String(expected));
}

function derUtf8String(text: string): Buffer {
	const body = Buffer.from(text, "utf8");
	return Buffer.concat([Buffer.from([0x0c]), derLength(body.length), body]);
}

function derLength(length: number): Buffer {
	if (length < 0x80) return Buffer.from([length]);
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** The signed statement must be SLSA provenance naming the installer's digest. */
function statementProblem(bundle: Bundle, digest: string): string | undefined {
	const content = bundle.content;
	if (
		content.$case !== "dsseEnvelope" ||
		content.dsseEnvelope.payloadType !== IN_TOTO_PAYLOAD_TYPE
	) {
		return "The attestation is not an in-toto statement.";
	}
	const statement = parseStatement(content.dsseEnvelope.payload);
	if (statement?.predicateType !== SLSA_PROVENANCE_V1) {
		return "The attestation is not SLSA build provenance.";
	}
	const subjects = Array.isArray(statement.subject) ? statement.subject : [];
	const named = subjects.some(
		(subject) =>
			(subject as { digest?: { sha256?: unknown } } | null)?.digest?.sha256 === digest
	);
	return named ? undefined : "The attestation does not name this installer's SHA-256.";
}

function parseStatement(payload: Buffer): { predicateType?: unknown; subject?: unknown } | null {
	try {
		const parsed: unknown = JSON.parse(payload.toString("utf8"));
		return typeof parsed === "object" ? (parsed as { predicateType?: unknown }) : null;
	} catch {
		return null;
	}
}
