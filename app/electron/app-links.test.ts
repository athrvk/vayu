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
import { DOC_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

describe("the keyed app links", () => {
	it("names every link the renderer can open", () => {
		expect(Object.keys(APP_LINKS).sort()).toEqual([
			"docs",
			"issues",
			"mcp",
			"pmApiCompatibility",
			"scripting",
		]);
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

	it('sends pmApiCompatibility to the page\'s "Not (yet) supported" section', () => {
		const url = new URL(appLinkUrl("pmApiCompatibility"));
		expect(url.href.startsWith(`${SITE_URL}app/pm-api-compatibility/`)).toBe(true);
		expect(url.hash).toBe("#not-yet-supported");
	});

	// The slug is the page's own rule (`pymdownx.slugs.slugify`, case lower):
	// punctuation dropped, spaces to hyphens. A heading renamed on the page alone
	// would leave the link opening the top of it.
	it("points the fragment at a heading that exists on the page", () => {
		const [page] = DOC_READING_GUARDS.appLinkAnchors.paths.map(fromRepoRoot);
		const source = readFileSync(page, "utf8");
		const slugs = [...source.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
			m[1]
				.toLowerCase()
				.replace(/[^\w\- ]/g, "")
				.trim()
				.replace(/ +/g, "-")
		);
		expect(slugs.length).toBeGreaterThan(0);
		expect(slugs).toContain(new URL(appLinkUrl("pmApiCompatibility")).hash.slice(1));
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
			const declared = /openAppLink: \(\s*key: ([^)]*)\)/.exec(source)?.[1];
			expect(declared).toBeDefined();
			const keys = [...(declared ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
			expect(keys.sort()).toEqual(Object.keys(APP_LINKS).sort());
		}
	);
});
