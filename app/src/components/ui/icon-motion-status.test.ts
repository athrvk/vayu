/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The half of the icon-motion policy that is a prohibition: **a glyph
 * conveying a state never animates** (#1683, refined by #1707;
 * docs/design-system.md under Motion).
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
 *
 * **What #1707 refined**: the rule is about *placement*, not about which glyph
 * it is. `Clock` in a row's status column is a state being reported and never
 * animates; `Clock` in the Activity Rail means "go to History" and animates
 * like any other navigation affordance. So the scan below looks at what the
 * element sits inside - a `[data-slot="button"]`, a menu item, a tab trigger,
 * a `RowAction` body, or anything carrying `group` (which is exactly what the
 * stylesheet's trigger selector keys off) - rather than at the tag name alone.
 * Owners are found by JSX indentation, which is well-defined here because
 * `app/` is prettier-clean to the file and CI keeps it that way.
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

/** Every status-icon JSX element in one file, as `{ icon, tag, index }`. */
function statusElements(source: string): { icon: string; tag: string; index: number }[] {
	const found: { icon: string; tag: string; index: number }[] = [];
	const opener = new RegExp(`<(${STATUS_ICONS.join("|")})(?=[\\s/>])`, "g");
	for (const match of source.matchAll(opener)) {
		found.push({
			icon: match[1],
			tag: openingTag(source, match.index),
			index: match.index,
		});
	}
	return found;
}

/**
 * The JSX elements that own a hover an icon motion can fire from, by tag name.
 *
 * Deliberately the same set the stylesheet's trigger selector describes: a
 * `[data-slot="button"]` (which is what `Button` and every control built on it
 * renders), a Radix menu item, a tab trigger, or the row-action body. Anything
 * else qualifies only by carrying `group`, which is the class those trigger
 * rules key off directly - so a hand-rolled control is judged by the thing
 * that actually makes its glyph move, not by its tag.
 */
const OWNER_TAGS = new Set([
	"Button",
	"button",
	"RailButton",
	"TooltipIconButton",
	"DropdownMenuItem",
	"ContextMenuItem",
	"MenubarItem",
	"CommandItem",
	"SelectItem",
	"TabsTrigger",
	"ToggleGroupItem",
	"Toggle",
	"RowActionBody",
]);

/**
 * The nearest enclosing interactive owner of the JSX element at `at`, or
 * `null` if it sits in none.
 *
 * Indentation, not a parser. JSX in `app/` is prettier-formatted to the file
 * and CI keeps it that way (`pnpm format:check`), so an element's ancestors
 * are exactly the preceding lines that open a tag at a strictly smaller
 * indent - walked outward, each one replacing the indent to beat. A real
 * parser would be the honest tool for arbitrary source; for source a formatter
 * owns, this reads the same structure with none of the dependency, and the
 * case above proves it distinguishes the two placements that matter.
 */
function interactiveOwner(source: string, at: number): string | null {
	const lines = source.split("\n");
	// Each line's byte offset, so an ancestor's opening tag is located by
	// position rather than by `indexOf(line)` - two identical lines in one
	// file would otherwise send the tag reader to the wrong one.
	const offsets: number[] = [];
	let running = 0;
	for (const line of lines) {
		offsets.push(running);
		running += line.length + 1;
	}
	const indentOf = (line: string) => line.length - line.trimStart().length;

	let self = offsets.findIndex((start, i) => at >= start && at < start + lines[i].length + 1);
	if (self === -1) self = lines.length - 1;
	let want = indentOf(lines[self]);

	for (let i = self - 1; i >= 0; i--) {
		const line = lines[i];
		if (line.trim() === "") continue;
		const indent = indentOf(line);
		if (indent >= want) continue;
		want = indent;
		const opening = /^<([A-Za-z][A-Za-z0-9.]*)/.exec(line.trim());
		if (!opening) continue;
		const tag = opening[1];
		if (OWNER_TAGS.has(tag)) return tag;
		// The whole opening tag, so a `className` spanning several lines is
		// read in full rather than only its first line.
		if (/\bgroup\b/.test(openingTag(source, offsets[i] + indent))) return tag;
	}
	return null;
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

	it("puts data-icon-motion on none of them outside an interactive owner", () => {
		const offenders: string[] = [];
		let inspected = 0;
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			for (const { icon, tag, index } of statusElements(source)) {
				if (!tag.includes("data-icon-motion")) continue;
				inspected++;
				if (interactiveOwner(source, index)) continue;
				offenders.push(
					`${relative(src, file)}: <${icon}> carries data-icon-motion but sits in no interactive owner`
				);
			}
		}
		// Joined into one string: the failure names every offender at once,
		// rather than the first one a `toHaveLength(0)` would print.
		expect(offenders.join("\n")).toBe("");
		// `inspected` is deliberately allowed to be 0: the app may simply not
		// animate a status glyph anywhere today, and that is the policy
		// working. What must not be 0 is the scan itself, which the case above
		// asserts, and the owner walk, which `interactiveOwner` is unit-tested
		// on below.
		expect(inspected).toBeGreaterThanOrEqual(0);
	});

	it("reads placement, not the tag: the same glyph fails in a chip and passes in a button", () => {
		// The mutation check #1707 names, written down as a test rather than
		// left to a reviewer: identical markup, two placements, two verdicts.
		// Without this, `interactiveOwner` returning `true` unconditionally
		// would turn the case above into a guard that can never fail.
		const chip = [
			`<span className="rounded-full bg-muted px-2">`,
			`\t<Clock className="size-icon" data-icon-motion={ICON_MOTION.hands} />`,
			`\tQueued`,
			`</span>`,
		].join("\n");
		const button = [
			`<Button variant="ghost" onClick={go}>`,
			`\t<Clock className="size-icon" data-icon-motion={ICON_MOTION.hands} />`,
			`\tHistory`,
			`</Button>`,
		].join("\n");

		expect(interactiveOwner(chip, chip.indexOf("<Clock"))).toBeNull();
		expect(interactiveOwner(button, button.indexOf("<Clock"))).toBe("Button");

		// And a hand-rolled owner, which is how half this app's controls are
		// written: not a Button, but carrying the `group` the stylesheet's
		// trigger selector actually keys off.
		const group = [
			`<div className="group flex items-center" onClick={go}>`,
			`\t<Clock className="size-icon" data-icon-motion={ICON_MOTION.hands} />`,
			`</div>`,
		].join("\n");
		expect(interactiveOwner(group, group.indexOf("<Clock"))).toBe("div");
	});

	it("allows a motion on a status glyph that sits inside an interactive owner", () => {
		// The other side of the same rule, and the reason it is stated as
		// placement: `DRAWER_VIEWS` draws `Clock` as the Activity Rail's
		// History button, where it is an affordance and not a report. A
		// registry entry is an interactive placement by construction - the
		// rail renders every one of them into a `RailButton` - so the guard
		// that used to fail this now asserts the opposite.
		expect(DRAWER_VIEWS.length).toBeGreaterThan(5);
		const withStatusIcon = DRAWER_VIEWS.filter((v) => STATUS_COMPONENTS.has(v.icon));
		expect(withStatusIcon.length, "no drawer view draws a status icon at all").toBeGreaterThan(
			0
		);
		for (const view of withStatusIcon) {
			expect(
				view.motion,
				`${view.label} draws ${STATUS_COMPONENTS.get(view.icon)} as a rail affordance and should name a motion`
			).toBeDefined();
		}
	});
});
