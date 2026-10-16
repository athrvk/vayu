/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Keeps the two host classifiers honest.
 *
 * `isPrivateHost` in `electron/mcp/safety.ts` decides which monitor endpoints
 * skip the MCP allowlist; `isLocalHost` in `src/lib/host-locality.ts` decides
 * which load-test targets the dialog calls local (#2117). They are the same
 * classification, mirrored on purpose because the process boundary forbids
 * sharing a source file (see `compare.conformance.test.ts`); change both.
 *
 * Drift here would be quiet and costly: the dialog warning about a host the MCP
 * gate treats as the user's own, or the reverse. The table below is the
 * contract; a host added here fails whichever side forgot it.
 */

import { describe, expect, it } from "vitest";
import { isPrivateHost } from "./safety.js";
import { isLocalHost } from "@/lib/host-locality";

const HOSTS: readonly string[] = [
	// loopback and the unspecified address
	"localhost",
	"app.localhost",
	"notlocalhost",
	"127.0.0.1",
	"127.255.255.255",
	"0.0.0.0",
	"0.1.2.3",
	// RFC1918, at and just past each edge
	"10.0.0.1",
	"11.0.0.1",
	"172.15.255.255",
	"172.16.0.1",
	"172.31.255.255",
	"172.32.0.1",
	"192.168.0.1",
	"192.169.0.1",
	// link local
	"169.254.0.1",
	"169.253.0.1",
	// public
	"8.8.8.8",
	"jsonplaceholder.typicode.com",
	"example.com",
	// malformed dotted quads
	"256.0.0.1",
	"10.0.0",
	// IPv6, bracketed as URL.hostname reports it
	"[::1]",
	"[::]",
	"[fc00::1]",
	"[fd12:3456::1]",
	"[fe80::1]",
	"[febf::1]",
	"[fec0::1]",
	"[2001:db8::1]",
	"[::ffff:127.0.0.1]",
	"[::ffff:10.1.2.3]",
	"[::ffff:8.8.8.8]",
	// the hex pair URL.hostname actually reports for the mapped spellings
	"[::ffff:7f00:1]",
	"[::ffff:a01:203]",
	"[::ffff:808:808]",
	// an unbracketed IPv6 never arrives from URL.hostname
	"::1",
	"",
];

describe("host classifiers: main process and renderer agree", () => {
	it("scans a non-empty table that exercises both answers", () => {
		expect(HOSTS.filter(isPrivateHost).length).toBeGreaterThan(10);
		expect(HOSTS.filter((h) => !isPrivateHost(h)).length).toBeGreaterThan(10);
	});

	it.each(HOSTS)("agrees on %j", (host) => {
		expect(isLocalHost(host)).toBe(isPrivateHost(host));
	});
});
