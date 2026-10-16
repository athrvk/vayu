/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file host-locality.ts
 * @brief Whether a request's host is a machine on the user's own network -
 *        loopback, RFC1918, link-local, unique-local - so the load-test dialog
 *        can tell a local target from one that belongs to someone else (#2117).
 *
 * **This file is mirrored, on purpose, by `isPrivateHost` in
 * `electron/mcp/safety.ts`.** The two processes cannot share a source file:
 * `tsconfig.node.json` emits the main process with `rootDir: "electron"`, so it
 * cannot compile a file from `src/` (TS6059), and the renderer cannot import one
 * from `electron/` either, since that is a referenced composite project (TS6305).
 * The mirror is pinned by `electron/mcp/host-locality.conformance.test.ts`, which
 * runs *both* implementations over one host table and fails on any divergence.
 * Change this file and change that one.
 *
 * Textual, like the MCP allowlist: a DNS name that *resolves* to a private
 * address is not local here, because resolving it would make the answer depend
 * on the network it is asked on. The host is the lowercased `URL.hostname`,
 * which normalises alternate IPv4 spellings and brackets an IPv6 literal.
 */

/** RFC1918, loopback, link-local and the unspecified address, in dotted quad. */
function isLocalIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return false;
	}
	const [a, b] = parts;
	if (a === 0 || a === 127) return true; // unspecified / loopback
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true; // link local
	return false;
}

/** Whether `host` (as `URL.hostname` reports it) names a machine on the user's own network. */
export function isLocalHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;

	if (host.startsWith("[") && host.endsWith("]")) {
		// `::ffff:127.0.0.1` is a v4 address wearing a v6 spelling, so it is
		// classified as the v4 one rather than falling through as "not local".
		const address = host.slice(1, -1).replace(/^::ffff:/, "");
		if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return isLocalIpv4(address);
		if (address === "::1" || address === "::") return true;
		// fc00::/7 (unique local) and fe80::/10 (link local).
		return /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
	}

	return /^\d+\.\d+\.\d+\.\d+$/.test(host) && isLocalIpv4(host);
}
