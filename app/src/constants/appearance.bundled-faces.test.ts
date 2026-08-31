/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A face the picker offers must be a face the app carries, and vice versa.
 *
 * The six families used to arrive from `fonts.googleapis.com` through a link in
 * the head of `index.html` - render-blocking, and the window is only shown on
 * first paint, so the window waited on the network to appear (#1149). They are
 * bundled in `src/fonts.css` now, which moves the failure mode: a family added
 * to a stack here is no longer fetched on demand, it simply does not exist, and
 * the option falls silently through to its system fallback. Nothing about the
 * picker looks wrong when that happens - it is the repo's "written but never
 * read" defect with the layers swapped.
 *
 * So both directions are asserted: every face an option promises is imported,
 * and every import is a face some option promises (a bundled family nothing can
 * select is installer weight for no one). The two remaining checks hold the
 * wiring: `index.css` must actually pull `fonts.css` in, and the head of
 * `index.html` must stay free of the fetch this all replaced.
 *
 * Read from disk rather than imported: vitest stubs a CSS import to `""`, and a
 * guard that scans an empty string passes while proving nothing (repo
 * CLAUDE.md). Hence the non-empty assertions first.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MONO_FONTS, UI_FONTS } from "./appearance";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const fontsCss = read("../fonts.css");
const indexCss = read("../index.css");
const indexHtml = read("../../index.html");

/**
 * The face an option promises - the head of its stack, when that head is a
 * named family. `system-ui, ...` and `ui-monospace, ...` lead with a generic
 * the OS provides, and everything after a stack's head is a fallback that has
 * to exist on the machine already, so neither is ours to bundle.
 */
const promisedFace = (stack: string): string | undefined => /^\s*"([^"]+)"/.exec(stack)?.[1];

/** `"IBM Plex Mono"` -> `ibm-plex-mono`, the `@fontsource` package for it. */
const fontsourcePackage = (family: string): string => family.toLowerCase().replace(/\s+/g, "-");

const promised = [...new Set([...UI_FONTS, ...MONO_FONTS].map((f) => promisedFace(f.stack)))]
	.filter((face): face is string => face !== undefined)
	.map(fontsourcePackage)
	.sort();

const imported = [
	...new Set([...fontsCss.matchAll(/@import "@fontsource\/([^/"]+)\//g)].map((m) => m[1])),
].sort();

describe("the bundled faces", () => {
	it("scanned non-empty sources", () => {
		// Without this every scan below is vacuous.
		expect(fontsCss.length).toBeGreaterThan(0);
		expect(indexCss.length).toBeGreaterThan(0);
		expect(indexHtml.length).toBeGreaterThan(0);
		expect(promised.length).toBeGreaterThan(0);
	});

	it("are exactly the faces the pickers offer", () => {
		expect(imported).toEqual(promised);
	});

	it("reach the renderer - index.css imports them", () => {
		expect(indexCss).toContain('@import "./fonts.css";');
	});

	it("are declared before any rule, as CSS requires of an @import", () => {
		// An `@import` after a rule is dropped, which would leave every
		// declaration in fonts.css unread while the file itself still scans fine.
		const at = indexCss.indexOf('@import "./fonts.css";');
		expect(at).toBeGreaterThanOrEqual(0);
		const beforeOurImport = indexCss.slice(0, at);
		expect(beforeOurImport.replace(/@import [^;]+;|\/\*[\s\S]*?\*\/|\s+/g, "")).toBe("");
	});

	it("are the only source of a face - nothing in the head fetches one", () => {
		expect(indexHtml).not.toContain("fonts.googleapis.com");
		expect(indexHtml).not.toContain("fonts.gstatic.com");
		// Broader than the two hosts: any external stylesheet in this head is a
		// round trip the window waits on, whoever serves it.
		expect(indexHtml).not.toMatch(/<link[^>]+href="https?:/);
	});

	it("are files, not fetches - fonts.css pulls nothing from the network", () => {
		expect(fontsCss).not.toMatch(/url\(\s*["']?https?:/);
	});

	it("each declare the range they cover, so only the needed file is read", () => {
		/*
		 * The trap this exists for. `@fontsource` also ships per-subset entry
		 * points (`latin-400.css`, `latin-ext-400.css`), and those declare their
		 * `@font-face` with no `unicode-range` at all - so nothing tells the
		 * browser which file holds which characters, and every subset face for a
		 * rendered weight is read whether a character needs it or not. Measured on
		 * the built app, painting the shell read four Space Grotesk files that way
		 * where the weight files read two, which with every subset bundled is
		 * seven times the font bytes on the first-paint path. Typography still
		 * looks right (the browser falls back within the family per character), so
		 * nothing else would catch it. Read from `node_modules` because the
		 * declarations are the dependency's, not ours, and that is where the
		 * mistake would land.
		 */
		const imports = [...fontsCss.matchAll(/@import "(@fontsource\/[^"]+)";/g)].map((m) => m[1]);
		expect(imports.length).toBeGreaterThan(0);

		const rangeless = imports.filter((specifier) => {
			const css = read(`../../node_modules/${specifier}`);
			const faces = css.match(/@font-face/g)?.length ?? 0;
			const ranges = css.match(/unicode-range:/g)?.length ?? 0;
			return faces === 0 || faces !== ranges;
		});
		expect(rangeless).toEqual([]);
	});
});
