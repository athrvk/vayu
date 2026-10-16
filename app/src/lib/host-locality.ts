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
 * `electron/mcp/safety.ts`; change both.** The process boundary forbids sharing
 * a source file (see `run-compare.ts`), and
 * `electron/mcp/host-locality.conformance.test.ts` fails on any divergence.
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

/**
 * The dotted quad behind an IPv4-mapped IPv6 address, else the address unchanged.
 * `URL` serializes `::ffff:127.0.0.1` as `::ffff:7f00:1`, so the hex pair is the
 * form that arrives; the dotted spelling is kept for a caller passing it directly.
 */
function unmapIpv4(address: string): string {
	const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
	if (dotted) return dotted[1];
	const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
	if (!hex) return address;
	const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** Whether `host` (as `URL.hostname` reports it) names a machine on the user's own network. */
export function isLocalHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;

	if (host.startsWith("[") && host.endsWith("]")) {
		// An IPv4-mapped address is classified as the v4 one it wraps.
		const address = unmapIpv4(host.slice(1, -1));
		if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) return isLocalIpv4(address);
		if (address === "::1" || address === "::") return true;
		// fc00::/7 (unique local) and fe80::/10 (link local).
		return /^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address);
	}

	return /^\d+\.\d+\.\d+\.\d+$/.test(host) && isLocalIpv4(host);
}
