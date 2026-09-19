/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The half of the icon-motion policy that is a prohibition: **status icons
 * never animate** (#1683, docs/design-system.md under Motion).
 *
 * The other two guards are positive - `icon-motion.test.tsx` holds the
 * stylesheet to its rules, `icon-motion.call-sites.test.tsx` holds each call
 * site to the name it spells. Neither can catch this, because the defect is not
 * a broken rule: `<CheckCircle2 data-icon-motion={ICON_MOTION.scale} />`
 * typechecks, animates exactly as designed, and looks like a considered choice
 * in a diff. What makes it wrong is only the policy - a state the user is being
 * *told about* is not an action they can take, and a success tick that grows
 * under the pointer invites a click on something that does nothing.
 *
 * So this scans instead of rendering: the prohibition is over call sites that
 * do not exist yet, and there is no component to hand it. Both halves of the
 * scan assert they saw something, since a source scan that reads nothing passes
 * forever (the rule in `app/CLAUDE.md`).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { AlertCircle, AlertTriangle, CheckCircle2, Clock, Info, XCircle } from "lucide-react";
import { DRAWER_VIEWS } from "@/constants/drawer-views";

/** `src/`, so a finding is reported as a repository-ish path. */
const src = resolve(__dirname, "../..");

/**
 * The glyphs that say "here is a state", by the name a call site imports them
 * under. Kept in step with the list in docs/design-system.md, which is the
 * policy; this is only its spelling.
 */
const STATUS_ICONS = [
	"AlertTriangle",
	"AlertCircle",
	"CheckCircle2",
	"XCircle",
	"Clock",
	"Info",
] as const;

/** The same six as components, for the registry half below. */
const STATUS_COMPONENTS = new Map<unknown, string>([
	[AlertTriangle, "AlertTriangle"],
	[AlertCircle, "AlertCircle"],
	[CheckCircle2, "CheckCircle2"],
	[XCircle, "XCircle"],
	[Clock, "Clock"],
	[Info, "Info"],
]);

function tsxFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			out.push(...tsxFiles(path));
			continue;
		}
		if (entry.name.endsWith(".tsx")) out.push(path);
	}
	return out;
}

/**
 * The attribute text of one JSX opening tag, starting at the `<`.
 *
 * Hand-walked rather than `/<Icon([^>]*)>/`: an attribute value is an
 * expression, and `{a > b ? x : y}` or `{"a>b"}` ends that character class
 * early - which would silently truncate the very attribute list being
 * inspected, and a guard that stops looking before the end is a guard that
 * passes. Braces are counted and quotes are skipped, so the `>` found is the
 * one that closes the tag.
 */
function openingTag(source: string, at: number): string {
	let depth = 0;
	let quote = "";
	for (let i = at; i < source.length; i++) {
		const ch = source[i];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		else if (ch === ">" && depth === 0) return source.slice(at, i);
	}
	return source.slice(at);
}

/** Every status-icon JSX element in one file, as `{ icon, tag }`. */
function statusElements(source: string): { icon: string; tag: string }[] {
	const found: { icon: string; tag: string }[] = [];
	const opener = new RegExp(`<(${STATUS_ICONS.join("|")})(?=[\\s/>])`, "g");
	for (const match of source.matchAll(opener)) {
		found.push({ icon: match[1], tag: openingTag(source, match.index) });
	}
	return found;
}

const files = tsxFiles(src);

describe("icon motion: status icons never animate (#1683)", () => {
	it("scanned the renderer's .tsx files and found status icons in them", () => {
		expect(files.length).toBeGreaterThan(100);
		const total = files.reduce(
			(n, file) => n + statusElements(readFileSync(file, "utf8")).length,
			0
		);
		// If this ever reaches 0 the scan below is vacuous - either the app
		// stopped drawing these six, or `statusElements` stopped finding them.
		expect(
			total,
			"no status icon is rendered anywhere, so the scan proves nothing"
		).toBeGreaterThan(5);
	});

	it("puts data-icon-motion on none of them", () => {
		const offenders: string[] = [];
		for (const file of files) {
			for (const { icon, tag } of statusElements(readFileSync(file, "utf8"))) {
				if (!tag.includes("data-icon-motion")) continue;
				offenders.push(`${relative(src, file)}: <${icon}> carries data-icon-motion`);
			}
		}
		// Joined into one string: the failure names every offender at once,
		// rather than the first one a `toHaveLength(0)` would print.
		expect(offenders.join("\n")).toBe("");
	});

	it("names no motion on a status icon in the registries that carry one", () => {
		// The attribute also reaches the DOM from a registry entry, where no
		// source scan can see it (`DRAWER_VIEWS` is the first, #1687). Compared
		// by component identity, not by name: the entry holds the import.
		expect(DRAWER_VIEWS.length).toBeGreaterThan(5);
		const withStatusIcon = DRAWER_VIEWS.filter((v) => STATUS_COMPONENTS.has(v.icon));
		expect(withStatusIcon.length, "no drawer view draws a status icon at all").toBeGreaterThan(
			0
		);
		for (const view of withStatusIcon) {
			expect(
				view.motion,
				`${view.label} draws ${STATUS_COMPONENTS.get(view.icon)}, which never animates`
			).toBeUndefined();
		}
	});
});
