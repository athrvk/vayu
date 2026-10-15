/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { APP_LINKS, appLinkUrl } from "./app-links.js";
import { DOCS_URL, ISSUES_URL, SITE_URL } from "./constants.js";

describe("the keyed app links", () => {
	it("names every link the renderer can open", () => {
		expect(Object.keys(APP_LINKS).sort()).toEqual(["docs", "issues", "mcp", "scripting"]);
	});

	it("keeps every documentation link https on the published docs site", () => {
		const docKeys = Object.keys(APP_LINKS).filter((key) => key !== "issues");
		expect(docKeys.length).toBeGreaterThan(0);
		for (const key of docKeys) {
			const url = new URL(appLinkUrl(key));
			expect(url.protocol, key).toBe("https:");
			expect(url.href.startsWith(SITE_URL), key).toBe(true);
		}
	});

	it("resolves every key, the issue tracker included, to https", () => {
		for (const key of Object.keys(APP_LINKS)) {
			expect(new URL(appLinkUrl(key)).protocol, key).toBe("https:");
		}
		expect(appLinkUrl("issues")).toBe(ISSUES_URL);
		expect(appLinkUrl("docs")).toBe(DOCS_URL);
	});

	it("sends mcp to the MCP server page", () => {
		expect(appLinkUrl("mcp")).toBe(`${SITE_URL}engine/mcp/`);
	});

	it("throws on a key it does not know, including an Object.prototype name", () => {
		expect(() => appLinkUrl("nope")).toThrow("Unknown app link: nope");
		expect(() => appLinkUrl("")).toThrow("Unknown app link");
		expect(() => appLinkUrl("toString")).toThrow("Unknown app link: toString");
	});
});

describe("the keys the renderer is typed to pass", () => {
	// preload.ts is sandboxed and cannot import APP_LINKS, so its parameter type
	// and the renderer's declaration are spelled by hand; this holds them to it.
	it.each(["electron/preload.ts", "src/types/electron.d.ts"])(
		"%s accepts exactly the keys in APP_LINKS",
		(file) => {
			const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
			const declared = /openAppLink: \(key: ([^)]*)\)/.exec(source)?.[1];
			expect(declared).toBeDefined();
			const keys = [...(declared ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
			expect(keys.sort()).toEqual(Object.keys(APP_LINKS).sort());
		}
	);
});
