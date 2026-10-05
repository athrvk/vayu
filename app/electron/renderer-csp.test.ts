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
import { ENGINE_HOST, ENGINE_PORT } from "./constants.js";

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

	it("lets the renderer connect only to itself and the engine", () => {
		expect(directive("connect-src")).toEqual([
			"'self'",
			`http://${ENGINE_HOST}:${ENGINE_PORT}`,
		]);
	});

	it("keeps Monaco's workers, forbids plugins and a rebased document", () => {
		expect(directive("worker-src")).toEqual(["'self'", "blob:"]);
		expect(directive("object-src")).toEqual(["'none'"]);
		expect(directive("base-uri")).toEqual(["'none'"]);
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
