/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Every time the app shows goes through `TimeValue` (issue #1786).
 *
 * The card is only "one hover away on every surface" while no surface formats a
 * time by itself, so this reads every non-test source file under `src` and
 * fails on a date formatter outside the two places allowed to hold one:
 * `lib/time-value.ts`, which owns the formatting, and `components/shared/TimeValue/`,
 * which owns the rendering. A string that must carry a time (an `aria-label`, a
 * native `title`, a palette subtitle) calls `formatInstant` from `time-value`.
 *
 * `Number#toLocaleString` is used for counts across the app and stays; only a
 * Date receiver is a time, which is what `DATE_TO_LOCALE_STRING` recognises.
 */

import { describe, it, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { openingTags } from "@/lib/jsx-opening-tags.testkit";
import { stripComments } from "@/lib/strip-comments.testkit";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED = ["lib/time-value.ts", "components/shared/TimeValue/"];

const sources = globSync("**/*.{ts,tsx}", { cwd: srcRoot })
	.map((file) => file.split(sep).join("/"))
	.filter((file) => !/\.(test|testkit)\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
	.map((file) => ({ file, code: stripComments(readFileSync(join(srcRoot, file), "utf8")) }));

const surfaces = sources.filter(({ file }) => !ALLOWED.some((allowed) => file.startsWith(allowed)));

const TO_LOCALE_DATE_OR_TIME = /\.toLocale(?:Date|Time)String\b/;
/** `new Date(x).toLocaleString()` or an identifier that names a time, then `.toLocaleString`. */
const DATE_TO_LOCALE_STRING =
	/(?:\bDate\([^)]*\)|\b\w*(?:[Dd]ate|[Tt]ime|[Tt]imestamp|At))\s*\.toLocaleString\b/;
const INTL_TIME_FORMATTER = /\bIntl\.(?:DateTimeFormat|RelativeTimeFormat)\b/;
const FORMAT_TIME_IMPORT = /from\s+["'](?:@\/lib|\.{1,2}(?:\/lib)?)\/format-time["']/;

const BANNED: [label: string, pattern: RegExp][] = [
	["toLocaleDateString / toLocaleTimeString", TO_LOCALE_DATE_OR_TIME],
	["toLocaleString on a Date", DATE_TO_LOCALE_STRING],
	["Intl.DateTimeFormat / Intl.RelativeTimeFormat", INTL_TIME_FORMATTER],
	["an import of lib/format-time", FORMAT_TIME_IMPORT],
];

describe("time-surfaces: the scan", () => {
	it("reads the app's source, not an empty list", () => {
		expect(sources.length).toBeGreaterThan(100);
		expect(surfaces.length).toBeGreaterThan(100);
		expect(sources.some(({ file }) => file === "lib/time-value.ts")).toBe(true);
		expect(
			surfaces.some(({ file }) => file === "modules/settings/main/panels/CookiesCard.tsx")
		).toBe(true);
	});

	it("recognises each banned shape, and leaves a count's toLocaleString alone", () => {
		expect(DATE_TO_LOCALE_STRING.test("new Date().toLocaleString()")).toBe(true);
		expect(DATE_TO_LOCALE_STRING.test("new Date(run.startTime).toLocaleString()")).toBe(true);
		expect(DATE_TO_LOCALE_STRING.test("receivedAt.toLocaleString()")).toBe(true);
		expect(DATE_TO_LOCALE_STRING.test("startTime.toLocaleString()")).toBe(true);
		expect(DATE_TO_LOCALE_STRING.test("received.toLocaleString()")).toBe(false);
		expect(DATE_TO_LOCALE_STRING.test("tests.passed.toLocaleString()")).toBe(false);
		expect(TO_LOCALE_DATE_OR_TIME.test("d.toLocaleTimeString()")).toBe(true);
		expect(TO_LOCALE_DATE_OR_TIME.test("d.toLocaleDateString(undefined, {})")).toBe(true);
		expect(INTL_TIME_FORMATTER.test("new Intl.RelativeTimeFormat('en')")).toBe(true);
		expect(INTL_TIME_FORMATTER.test("new Intl.NumberFormat('en')")).toBe(false);
		expect(FORMAT_TIME_IMPORT.test('import { formatTime } from "@/lib/format-time";')).toBe(
			true
		);
		expect(FORMAT_TIME_IMPORT.test('import { formatInstant } from "@/lib/time-value";')).toBe(
			false
		);
	});
});

describe("time-surfaces: no surface formats a time itself", () => {
	it.each(BANNED)("%s appears only in lib/time-value.ts and TimeValue/", (_label, pattern) => {
		const offenders = surfaces.filter(({ code }) => pattern.test(code)).map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	it("keeps lib/format-time.ts retired", () => {
		expect(sources.some(({ file }) => file === "lib/format-time.ts")).toBe(false);
	});
});

describe("time-surfaces: no editor opts out of the time card", () => {
	const codeEditor = join(srcRoot, "components/ui/code-editor.tsx");

	it("gives CodeEditor no prop that mentions a time", () => {
		const source = stripComments(readFileSync(codeEditor, "utf8"));
		const props = /export interface CodeEditorProps\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
		expect(props.length).toBeGreaterThan(100);
		expect(props).not.toMatch(/time/i);
	});

	it("passes no time attribute at any CodeEditor call site", () => {
		const tags = sources
			.filter(({ file }) => file.endsWith(".tsx"))
			.flatMap(({ file, code }) =>
				openingTags(code, "CodeEditor").map((tag) => ({ file, tag }))
			);
		expect(tags.length).toBeGreaterThan(4);
		const offenders = tags
			.filter(({ tag }) => /\btime\w*\s*=/i.test(tag))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});
});
