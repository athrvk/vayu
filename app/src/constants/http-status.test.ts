/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * One vocabulary for HTTP status classes.
 *
 * Five places classified codes for colour and gave four different answers for
 * 3xx - amber on the response badge, violet in the dashboard chart, a raw
 * `blue-*` history tile, and `status-running-text` in the dashboard's request
 * view. 4xx had three. The measured case against the old badge mapping: its
 * green -> amber -> orange -> red ramp packed four classes into 38deg-0deg of
 * hue, so three of its ten pairs collided in OKLab, including 5xx against a
 * connection failure at exactly 0.000.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	httpStatusClass,
	statusCodeLabel,
	STATUS_CLASS_STYLE,
	type HttpStatusClass,
} from "./http-status";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("httpStatusClass", () => {
	it.each([
		[200, "success"],
		[204, "success"],
		[299, "success"],
		[301, "redirect"],
		[304, "redirect"],
		[400, "client-error"],
		[429, "client-error"],
		[500, "server-error"],
		[503, "server-error"],
	] as const)("maps %i to %s", (code, expected) => {
		expect(httpStatusClass(code)).toBe(expected);
	});

	it("treats status 0 as no-response, not a server error", () => {
		// The defect this vocabulary exists to fix. Both response badges painted
		// a failed connection with the same red as a 500, and one of them had
		// lost the branch entirely and rendered a literal "0".
		expect(httpStatusClass(0)).toBe("no-response");
		expect(httpStatusClass(0)).not.toBe("server-error");
	});

	it("groups 1xx with redirect rather than painting it red", () => {
		// Every branch this replaced ended in a bare `else` feeding the
		// server-error colour, so a 101 Switching Protocols showed as an error.
		expect(httpStatusClass(100)).toBe("redirect");
		expect(httpStatusClass(101)).toBe("redirect");
	});

	it("never falls through to an error colour for nonsense input", () => {
		for (const code of [NaN, Infinity, -Infinity, -1, 99, 600, 999]) {
			expect(httpStatusClass(code), String(code)).toBe("no-response");
		}
	});
});

describe("statusCodeLabel", () => {
	it("shows the code, except when nothing came back", () => {
		expect(statusCodeLabel(200)).toBe("200");
		expect(statusCodeLabel(404)).toBe("404");
		expect(statusCodeLabel(0)).toBe("ERR");
	});
});

describe("STATUS_CLASS_STYLE", () => {
	const CLASSES: HttpStatusClass[] = [
		"success",
		"redirect",
		"client-error",
		"server-error",
		"no-response",
	];

	it("gives every class all three tiers", () => {
		for (const c of CLASSES) {
			const s = STATUS_CLASS_STYLE[c];
			expect(s.fill, c).toMatch(/^bg-status-[\w-]+-fill$/);
			expect(s.text, c).toMatch(/^text-status-[\w-]+-text$/);
			expect(s.tint, c).toMatch(/^bg-status-[\w-]+\/10$/);
		}
	});

	it("gives the five classes five distinct colours", () => {
		// The whole point. Under the badge's old mapping a 5xx and a connection
		// failure were the same token.
		expect(new Set(CLASSES.map((c) => STATUS_CLASS_STYLE[c].fill)).size).toBe(5);
		expect(new Set(CLASSES.map((c) => STATUS_CLASS_STYLE[c].text)).size).toBe(5);
	});

	it("holds complete literals, never a composed string", () => {
		/*
		 * Tailwind scans source text and this repo has no `@source inline(...)`
		 * and no safelist, so a `bg-${stem}-fill` template would emit no CSS at
		 * all - a silently uncoloured element, most likely noticed only in a
		 * production build. Guards the file itself, since the map reads like
		 * something a future tidy-up would want to generate.
		 */
		const source = readFileSync(join(srcRoot, "constants/http-status.ts"), "utf8");
		expect(source.length).toBeGreaterThan(0);
		const map = source.slice(source.indexOf("STATUS_CLASS_STYLE: Record"));
		const body = map.slice(0, map.indexOf("\n};"));
		expect(body).not.toMatch(/\$\{/);
		expect(body).not.toMatch(/["'`]\s*\+/);
	});
});

describe("no component classifies status codes on its own", () => {
	/*
	 * The same guard shape as the load-test mode vocabulary. A component that
	 * re-derives the mapping is how four different answers for 3xx happened in
	 * the first place.
	 */
	const files = globSync("**/*.tsx", { cwd: srcRoot }).filter((f) => !f.includes(".test."));

	it("scans a real set of components", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	it("finds no hand-rolled status branch paired with a colour", () => {
		const BRANCH = /startsWith\(["']([2-5])["']\)|status(?:Code)?\s*(?:>=|===)\s*[0-9]{1,3}/;
		const COLOUR = /(?:text|bg|border)-(?:status-|warning|destructive|success)/;
		const offences: string[] = [];

		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			const lines = source.split("\n");
			lines.forEach((line, i) => {
				if (!BRANCH.test(line)) return;
				// A branch is only a problem when it is choosing a colour. Range
				// checks that drive other logic are not this defect.
				const window = lines.slice(i, i + 3).join("\n");
				if (!COLOUR.test(window)) return;
				offences.push(
					`${relative(".", file)}:${i + 1}  classifies a status code and picks a ` +
						`colour inline. Use httpStatusClass + STATUS_CLASS_STYLE.`
				);
			});
		}

		expect(offences.join("\n")).toBe("");
	});
});
