/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The renderer's Content-Security-Policy (#1780). The policy is derived from
 * the real index.html, so an edit to its inline script cannot leave the hash
 * stale, and the build plugin that ships it is exercised, not assumed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildRendererCsp, inlineScriptBodies, inlineScriptHash } from "./renderer-csp.js";
import { cspMeta } from "../vite-plugins/csp-meta";
import { ENGINE_PORT_CANDIDATES, MCP_PORT } from "./constants.js";

const indexHtml = readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
const scripts = inlineScriptBodies(indexHtml);
const policy = buildRendererCsp(scripts);

function directive(name: string): string[] {
	const found = policy.split("; ").find((d) => d.startsWith(name + " "));
	return found ? found.split(" ").slice(1) : [];
}

describe("buildRendererCsp", () => {
	it("scanned the real document: its one inline script, non-empty", () => {
		expect(indexHtml.length).toBeGreaterThan(0);
		expect(scripts).toHaveLength(1);
		expect(scripts[0].trim().length).toBeGreaterThan(0);
	});

	it("allows the inline script by hash and runs no other inline code", () => {
		expect(directive("script-src")).toEqual(["'self'", inlineScriptHash(scripts[0])]);
		expect(policy).not.toContain("unsafe-eval");
		expect(directive("script-src")).not.toContain("'unsafe-inline'");
	});

	it("lets the renderer connect only to itself and the engine's candidate ports", () => {
		// The port is chosen at runtime and this policy is fixed at build time
		// (#2118), so every candidate is named - and nothing wider.
		expect(directive("connect-src")).toEqual([
			"'self'",
			...ENGINE_PORT_CANDIDATES.map((port) => `http://127.0.0.1:${port}`),
		]);
	});

	it("names no loopback port the engine cannot have", () => {
		const connect = directive("connect-src");
		expect(connect).toContain("http://127.0.0.1:9876");
		expect(connect).not.toContain(`http://127.0.0.1:${MCP_PORT}`);
		expect(connect).not.toContain("http://127.0.0.1:9890");
		expect(connect.some((source) => source.includes("*"))).toBe(false);
	});

	it("keeps Monaco's workers, forbids plugins and a rebased document", () => {
		expect(directive("worker-src")).toEqual(["'self'", "blob:"]);
		expect(directive("object-src")).toEqual(["'none'"]);
		expect(directive("base-uri")).toEqual(["'none'"]);
	});

	it("submits no form anywhere, which default-src does not cover", () => {
		// Mutation check: drop `form-action 'none'` from buildRendererCsp and
		// this reddens.
		expect(directive("form-action")).toEqual(["'none'"]);
	});

	it("leaves every directive that names 'self' as it was", () => {
		// The app scheme (#2380) changed what 'self' means, one origin instead of
		// any file: URL, and nothing about which directives grant it.
		const naming = policy
			.split("; ")
			.filter((d) => d.split(" ").includes("'self'"))
			.map((d) => d.split(" ")[0]);
		expect(naming).toEqual([
			"default-src",
			"script-src",
			"style-src",
			"connect-src",
			"img-src",
			"font-src",
			"worker-src",
			"frame-src",
		]);
		expect(directive("default-src")).toEqual(["'self'"]);
		expect(directive("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
		expect(directive("img-src")).toEqual(["'self'", "data:", "blob:"]);
		expect(directive("font-src")).toEqual(["'self'", "data:"]);
		expect(directive("frame-src")).toEqual(["'self'"]);
	});
});

describe("cspMeta", () => {
	it("stamps the same policy into the built document as a meta tag", () => {
		const plugin = cspMeta();
		const handler = (plugin.transformIndexHtml as { handler: (h: string) => string }).handler;
		const built = handler(indexHtml);
		expect(built).toContain(
			`<meta http-equiv="Content-Security-Policy" content="${policy}" />`
		);
	});

	it("applies to the build only, where no dev preamble needs inline script", () => {
		expect(cspMeta().apply).toBe("build");
	});
});
