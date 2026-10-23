/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @file connection.tools.ts
 * @brief Connection setup: the client certificates (mutual TLS) Vayu presents, and
 *        `diagnose_connection`.
 */

import { z } from "zod";
import { checkAllowlist } from "../safety.js";
import { secretsShape, withheldPointer, withholdDiagnoseCredentials } from "../withhold.js";
import type { McpTool } from "./contract.js";
import {
	callEngine,
	engineErrorResult,
	guardErrorResult,
	jsonResult,
	requireStr,
	withCaveat,
} from "./kit.js";
import { resolveRemedyTokens } from "../remedy.js";
import { asRecord, CONNECTION_OUTCOME_HINTS } from "./spec-bindings.js";

export const CONNECTION_TOOLS: McpTool[] = [
	{
		name: "list_client_certificates",
		category: "read",
		invalidates: [],
		description:
			'List the client certificates (mutual TLS) Vayu presents, one per host and optional port: `host` (or `*.example.com`), `port` (null for every port), `certPath`, `keyPath` ("" for a PKCS#12 bundle), `certFormat` and `hasPassphrase`. The passphrase itself is never returned. Read this when a host answers with a TLS handshake failure, or diagnose_connection reports `tls_failed`: a host with no entry sends no certificate. Entries are added by the user; no tool adds one.',
		annotations: {
			title: "List client certificates",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {},
		handler: (_args, ctx, signal) =>
			callEngine(ctx, () => ctx.client.listClientCertificates(signal)),
	},
	{
		name: "diagnose_connection",
		category: "execute",
		invalidates: [],
		description: (config) =>
			"Test whether Vayu can reach a URL under the proxy, custom CA and client-certificate settings in force, and say which hop failed. Sends one HEAD with certificate verification on, redirects off and a 10-second deadline, and returns `outcome` (ok, proxy_failed, tls_failed, timed_out, failed), the proxy mode and URL used, the client certificate that answered for the host (\"\" when none), and on failure the engine's error code and libcurl's message. Use it when requests fail with connection or TLS errors, before concluding the API is down. Never returns a response body or headers." +
			withheldPointer(config) +
			" GUARDED: the URL's host must be on Vayu's MCP allowlist.",
		annotations: {
			title: "Diagnose a connection",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			url: z
				.string()
				.describe("The http or https URL to test, fully resolved - no {{variables}}."),
		},
		handler: async (args, ctx, signal) => {
			const url = requireStr(args, "url");
			const gate = checkAllowlist(url, ctx.config, ctx.host);
			if (!gate.ok) return guardErrorResult(gate);
			let answer: unknown;
			try {
				answer = await ctx.client.diagnoseConnection(url, signal);
			} catch (err) {
				return engineErrorResult(err, ctx);
			}
			const outcome = asRecord(answer).outcome;
			const hint =
				typeof outcome === "string" ? CONNECTION_OUTCOME_HINTS[outcome] : undefined;
			return withCaveat(
				jsonResult(secretsShape(ctx, withholdDiagnoseCredentials)(answer)),
				hint ? `\n\n${resolveRemedyTokens(hint, ctx.host)}` : ""
			);
		},
	},
];
