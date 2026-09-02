/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The `jsx-a11y` rules suppressed at the line, held to a ceiling and to a list.
 *
 * #1216 turned the recommended set on and read its 58-error baseline rather than
 * allowlisting it: three rules are configured in `app/eslint.config.mjs` because
 * the pattern they flag is the correct one here, and the rest are suppressed one
 * line at a time. Each of those carries its reason, and
 * `--report-unused-disable-directives` retires a stale one, so the mechanism is
 * honest - but a rule-level configuration is visible in one place while a
 * line-level one is visible only to whoever opens that file, and nothing stopped
 * the count growing one justified line at a time.
 *
 * So the sites are enumerated in `docs/design-system.md` and this guard reads
 * both halves. The count is a ceiling in the shape `type-scale.test.ts` uses for
 * font weights: it may come down when a suppression goes, and raising it is an
 * edit someone has to make on purpose. The doc list is compared site by site
 * rather than only in total, because a suppression that moves from a tree to a
 * dialog is a different claim about the same number.
 *
 * The scan reads raw lines and does *not* blank comments, unlike the other
 * source scans in this directory: here the comment is the thing being counted.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DOC_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The most directives this repository may carry.
 *
 * A ceiling, not a count to hold: 16 is what #1216 left behind, and the number
 * moves down with the list in the doc when a site is fixed rather than
 * suppressed. Raising it means adding a site to the doc too, which is where the
 * reason has to convince the next reader.
 */
const CEILING = 16;

/** The reason marker eslint itself understands, and this repository writes. */
const REASON = " -- ";

const RULE = /jsx-a11y\/[a-z-]+/g;

const scanned = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter(
	(file) => !file.includes(".test.") && !file.includes(".testkit.")
);

interface Directive {
	/** Relative to `app/src`, POSIX-spelled, as the doc lists it. */
	readonly file: string;
	readonly line: number;
	readonly rules: readonly string[];
	readonly reason: string;
}

/**
 * A reason on the previous line counts too - a wrapped block comment above the
 * directive says as much as a trailing one - which is why this reads the line
 * before rather than only the text after the marker.
 *
 * Exported for the cases at the bottom of this file, the way
 * `focus-indicator.test.ts` exports its class-string reader. All 16 sites write
 * their reason inline today, so the previous-line arm has no fixture in the
 * repository to prove it: unread code in a guard is how a guard starts passing
 * for the wrong reason.
 */
export function reasonFor(lines: readonly string[], at: number): string {
	const inline = lines[at].split(REASON).slice(1).join(REASON);
	if (inline.trim() !== "") return inline.replace(/\*\/\s*}?\s*$/, "").trim();

	const previous = (lines[at - 1] ?? "").trim();
	const comment = /^(?:\/\/|\/\*|\*)\s*(.+?)(?:\*\/)?$/.exec(previous);
	return comment && !comment[1].includes("eslint-disable") ? comment[1].trim() : "";
}

const directives: Directive[] = scanned.flatMap((file) => {
	const lines = readFileSync(join(srcRoot, file), "utf8").split(/\r?\n/);
	return lines.flatMap((line, at) =>
		line.includes("eslint-disable") && line.includes("jsx-a11y/")
			? [
					{
						file: file.split("\\").join("/"),
						line: at + 1,
						rules: [...new Set(line.split(REASON)[0].match(RULE) ?? [])].sort(),
						reason: reasonFor(lines, at),
					},
				]
			: []
	);
});

/** One entry per file, which is the granularity the doc list is written at. */
function bySite(entries: readonly Directive[]): Map<string, { count: number; rules: string[] }> {
	const sites = new Map<string, { count: number; rules: string[] }>();
	for (const entry of entries) {
		const site = sites.get(entry.file) ?? { count: 0, rules: [] };
		site.count += 1;
		site.rules = [...new Set([...site.rules, ...entry.rules])].sort();
		sites.set(entry.file, site);
	}
	return sites;
}

const sites = bySite(directives);

describe("the jsx-a11y suppressions", () => {
	it("scans a real set of files and directives", () => {
		// Both floors, for the reason `focus-indicator.test.ts` gives: a broken
		// glob empties the file list, and a rewritten directive spelling empties
		// the directive list while the files still scan. 16 directives in 12
		// files when this was written.
		expect(scanned.length).toBeGreaterThan(100);
		expect(directives.length).toBeGreaterThan(10);
	});

	it("stays under the ceiling", () => {
		expect(
			directives.length,
			`Fix the site, or - if the suppression is the right answer - add it to the Accessibility section of docs/design-system.md and raise this ceiling on purpose:\n${directives
				.map(({ file, line, rules }) => `${file}:${line} ${rules.join(", ")}`)
				.join("\n")}`
		).toBeLessThanOrEqual(CEILING);
	});

	it("gives every directive a reason", () => {
		const unreasoned = directives
			.filter((entry) => entry.reason === "")
			.map(
				({ file, line, rules }) =>
					`${file}:${line} suppresses ${rules.join(", ")} with no reason. Write it after ' -- ' on the directive, naming the file that provides the missing half.`
			);

		expect(unreasoned.join("\n")).toBe("");
	});
});

describe("the doc's list of suppressions", () => {
	const [DOC] = DOC_READING_GUARDS.a11ySuppressions.paths;
	const doc = readFileSync(fromRepoRoot(DOC), "utf8");

	/** The Accessibility section alone, so a bullet elsewhere cannot answer. */
	const afterHeading = doc.slice(doc.indexOf("\n## Accessibility") + 1);
	const section = afterHeading.slice(0, afterHeading.indexOf("\n## ", 1));

	/**
	 * The bullets as `path (count) - rules`. A bullet wraps across lines, so each
	 * is read from its `- ` to the next one and flowed to a single line first -
	 * the shape `row-persistence-claims.test.ts` reads hand-wrapped prose in. The
	 * allowlist bullets above name a rule rather than a path and no count, so
	 * they fall out here rather than needing to be skipped by position.
	 */
	const listed = section
		.split(/\n- /)
		.slice(1)
		.map((bullet) => /^`([^`]+)` \((\d+)\)/.exec(bullet.replace(/\s+/g, " ")))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => ({
			file: match[1],
			count: Number(match[2]),
			rules: [...new Set(match.input.match(RULE) ?? [])].sort(),
		}));

	it("read the section", () => {
		// The proof the block below rests on: a heading that moved, or a list
		// rewritten into another shape, fails here rather than passing by
		// matching nothing.
		expect(section.length).toBeGreaterThan(1000);
		expect(section).toContain("a11y-suppressions.test.ts");
		expect(listed.length).toBeGreaterThanOrEqual(10);
	});

	it("lists exactly the sites the sources carry", () => {
		const asText = (entries: { file: string; count: number; rules: readonly string[] }[]) =>
			entries
				.map(({ file, count, rules }) => `${file} (${count}) ${rules.join(", ")}`)
				.sort()
				.join("\n");

		expect(asText(listed)).toBe(asText([...sites].map(([file, site]) => ({ file, ...site }))));
	});

	it("states the totals the sources hold", () => {
		const totals = /\*\*(\d+) directives across (\d+) files\*\*/.exec(section);
		expect(totals, "the Accessibility section no longer states its totals").not.toBeNull();

		const [, count, files] = totals as RegExpExecArray;
		expect(Number(count)).toBe(directives.length);
		expect(Number(files)).toBe(sites.size);
	});
});

describe("the reason reader", () => {
	// The guard above is only as good as this: read the reason too loosely and a
	// bare directive passes, too strictly and a legal spelling is called
	// unreasoned. Every arm gets a case, including the one no site uses yet.
	/** The reason the guard would read for the last directive in `source`. */
	const reasonAt = (source: string) => {
		const lines = source.split("\n");
		const at = lines.reduce(
			(last, line, i) => (line.includes("eslint-disable") ? i : last),
			-1
		);
		return reasonFor(lines, at);
	};

	it("reads a reason written after the marker", () => {
		expect(
			reasonAt("// eslint-disable-next-line jsx-a11y/no-autofocus -- a dialog field")
		).toBe("a dialog field");
	});

	it("stops at the end of a JSX comment rather than keeping its delimiter", () => {
		expect(
			reasonAt("{/* eslint-disable-next-line jsx-a11y/no-autofocus -- a dialog field */}")
		).toBe("a dialog field");
	});

	it("takes the line above when the directive carries no reason", () => {
		expect(
			reasonAt("// a dialog field\n// eslint-disable-next-line jsx-a11y/no-autofocus")
		).toBe("a dialog field");
	});

	it("refuses a bare directive, and a second directive above it", () => {
		expect(reasonAt("const x = 1;\n// eslint-disable-next-line jsx-a11y/no-autofocus")).toBe(
			""
		);
		expect(
			reasonAt(
				"// eslint-disable-next-line jsx-a11y/no-autofocus\n// eslint-disable-next-line jsx-a11y/no-autofocus"
			)
		).toBe("");
	});
});
