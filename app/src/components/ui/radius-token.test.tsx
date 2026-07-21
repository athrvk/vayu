/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Corner radius must follow the roundedness setting.
 *
 * `--radius` is user-controlled (Settings → Appearance → Roundedness), and the
 * theme derives `--radius-sm/md/lg` from it — so `rounded-sm`, `rounded-md` and
 * `rounded-lg` all track the setting.
 *
 * Bare `rounded` does not. Tailwind resolves it from its own built-in default,
 * so it stays 4px at every setting: measured 4px at `--radius: 0rem`, `0.375rem`
 * and `0.75rem` alike, while `rounded-md` moved 0 → 4 → 10. Three of these had
 * drifted into the MCP settings panel, where they stayed rounded for a user who
 * had chosen Square.
 *
 * `rounded-full` and `rounded-none` are deliberately fixed — circles, switch
 * tracks and squared-off tab strips are not meant to follow the setting — so
 * they are allowed as classes.
 *
 * The other way to escape the setting is an inline `borderRadius`, which no
 * class scan catches. The chart tooltip had one (`"6px"`), so it stayed rounded
 * on Square and stopped short of the app's own tooltip on Rounded. Inline radii
 * are now allowed only when they are a `var(--radius…)` reference or a
 * percentage (a circle), plus the roundedness setting's own preview swatches,
 * which have to show every option regardless of which one is active.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// .ts as well as .tsx: an inline radius can be set from a plain module —
// the chart tooltip that started this was one.
const sources: Record<string, string> = import.meta.glob("/src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
});

// The stylesheet is read from disk, not globbed. vitest stubs CSS imports to an
// empty string unless `test.css` is enabled, so the `css` entries this glob used
// to include were all "" — the `@apply` half of the scan below was running
// against nothing and could never have failed.
sources["/src/index.css"] = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

/** `rounded` (or `rounded-t`, `rounded-l`, …) with no size suffix. */
const BARE_ROUNDED = /\brounded(-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?(?![-\w[])/g;

describe("corner radius tracks the roundedness setting", () => {
	it("finds radius utilities to check (guards the scan itself)", () => {
		const total = Object.values(sources).reduce<number>(
			(n, src) => n + ((src as string).match(/\brounded-(sm|md|lg)\b/g)?.length ?? 0),
			0
		);
		expect(total).toBeGreaterThan(50);
	});

	it("uses no hardcoded inline borderRadius", () => {
		// `style={{ borderRadius: "6px" }}` is invisible to a class scan and to
		// the setting alike. Percentages are circles and `var(--radius…)` tracks,
		// so both are fine.
		const offenders: string[] = [];
		for (const [path, src] of Object.entries(sources)) {
			if (path.includes(".test.")) continue;
			// The Appearance panel draws one swatch per roundedness option; each
			// must render its own radius, not the active one.
			if (path.endsWith("AppearancePanel.tsx")) continue;
			for (const line of (src as string).split("\n")) {
				const m = line.match(/borderRadius:\s*("[^"]*"|'[^']*'|`[^`]*`)/);
				if (!m) continue;
				const value = m[1].slice(1, -1);
				if (value.includes("var(--radius") || value.endsWith("%")) continue;
				offenders.push(`${path}: ${line.trim().slice(0, 88)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("uses no bare `rounded`, which ignores --radius", () => {
		const offenders: string[] = [];
		for (const [path, src] of Object.entries(sources)) {
			if (path.includes(".test.")) continue;
			for (const line of (src as string).split("\n")) {
				// Only look inside class strings; prose in comments may say "rounded".
				const classAttrs = line.match(/className=(?:"[^"]*"|\{[^}]*\})|@apply [^;]+/g);
				if (!classAttrs) continue;
				for (const attr of classAttrs) {
					BARE_ROUNDED.lastIndex = 0;
					if (BARE_ROUNDED.test(attr)) {
						offenders.push(`${path}: ${line.trim().slice(0, 88)}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
