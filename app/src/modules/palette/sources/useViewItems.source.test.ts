/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * That the palette *reads* the drawer's list, rather than agreeing with it by
 * hand (#1341).
 *
 * `useViewItems.test.ts` compares the produced rows to `DRAWER_VIEWS`, and that
 * comparison would go on passing if the mapping were replaced by literals which
 * happen to match the list today - which is exactly the state this file's
 * subject was just moved out of, and how Collections came to be `FolderOpen` in
 * the Dock and `Folder` in the palette. The difference between reading a list
 * and copying it is visible only in the source, so the source is read.
 *
 * Node environment on purpose: nothing here renders, and `import.meta.url` is a
 * file URL only outside jsdom.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, it, expect } from "vitest";

import { DRAWER_VIEWS } from "@/constants/drawer-views";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "useViewItems.ts"), "utf8");

/**
 * The file's prose explains the drift by naming the views it happened to, so
 * the scan reads the code alone. Comment syntax only - no string in this file
 * contains `//` or `/*`, and a guard that had to parse TypeScript to answer
 * this question would be the wrong guard.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the palette's view source", () => {
	it("was read - a scan of an empty string passes forever", () => {
		expect(source).toContain("export function useViewItems");
	});

	it("takes the six from the shared list rather than importing marks of its own", () => {
		expect(code).toContain('from "@/constants/drawer-views"');

		// `Inbox` is the palette's own row and has no entry in `DRAWER_VIEWS`;
		// any other mark here would be a second spelling of a Dock icon.
		const lucide = /import\s*\{([^}]*)\}\s*from\s*"lucide-react"/.exec(code);
		expect(lucide).not.toBeNull();
		expect(lucide?.[1].split(",").map((name) => name.trim())).toEqual(["Inbox"]);
	});

	it("names no drawer view, so renaming one in the shared list cannot leave the palette behind", () => {
		for (const { label } of DRAWER_VIEWS) {
			expect(code).not.toContain(`"${label}"`);
		}
	});

	it("keys its keywords exhaustively, which is what fails the build on a seventh view", () => {
		// `Partial<...>` or a cast would compile and change no behaviour, so the
		// annotation is the assertion: it is the whole of the guarantee.
		expect(code).toContain("const VIEW_KEYWORDS: Record<DrawerView, string[]>");
	});
});
