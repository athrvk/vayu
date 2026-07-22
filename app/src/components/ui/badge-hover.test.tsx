/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A Badge that overrides its background must not keep the variant's hover.
 *
 * The response status chip painted `bg-status-success-fill` and then turned the
 * user's accent colour when the pointer crossed it. The cause is a merge
 * asymmetry, not a bad class: `cn()` is tailwind-merge, which resolves `bg-*`
 * against `bg-*` but files `hover:bg-*` under a *different* key. So
 *
 *     cn("bg-primary-fill hover:bg-primary-fill/80", "bg-status-success-fill")
 *
 * drops `bg-primary-fill` and keeps `hover:bg-primary-fill/80`. At rest the chip
 * was green; on hover `--primary-fill` won, animated by the `transition-colors`
 * in the base. On Forest it faded green-to-green, on Magenta green-to-pink.
 *
 * Nothing wearing these classes is clickable, so the hover state was never
 * wanted. The `chip` variant supplies no colour and no `hover:` at all.
 *
 * This is invisible to a render test - jsdom computes no styles and the class
 * string looks plausible either way - so the assertions here are on the merged
 * class list, which is where the defect actually lives.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync, globSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cn } from "@/lib/utils";
import { badgeVariants } from "./badge";
import { ResponseStatusBar } from "@/components/shared/response-viewer";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Badge chip variant", () => {
	it("carries no hover state", () => {
		expect(badgeVariants({ variant: "chip" })).not.toMatch(/hover:/);
	});

	it("carries no background, so the caller's survives unambiguously", () => {
		expect(badgeVariants({ variant: "chip" })).not.toMatch(/(^|\s)bg-/);
	});

	it("keeps a caller background intact through cn()", () => {
		const merged = cn(badgeVariants({ variant: "chip" }), "bg-status-success-fill");
		expect(merged).toContain("bg-status-success-fill");
		expect(merged).not.toMatch(/hover:bg-/);
	});
});

describe("the merge asymmetry that caused this", () => {
	/**
	 * Pins the behaviour the fix depends on. If tailwind-merge ever started
	 * clearing `hover:bg-*` when a bare `bg-*` is overridden, the `chip` variant
	 * would become unnecessary - and this test would tell us, rather than the
	 * variant quietly outliving its reason.
	 */
	it("still drops the base background but keeps the hover one", () => {
		const merged = cn(
			"bg-primary-fill text-primary-foreground hover:bg-primary-fill/80",
			"bg-status-success-fill"
		);
		expect(merged).not.toMatch(/(^|\s)bg-primary-fill(\s|$)/);
		expect(merged).toContain("hover:bg-primary-fill/80");
	});
});

/**
 * The chip that actually had the bug, rendered.
 *
 * The source scan below cannot see this one: the background arrives via the
 * `statusColor` variable, not a literal `bg-…` in the JSX. Reverting the fix and
 * re-running proved it - the scan stayed green while the chip was broken again.
 * So the real component is asserted here, where the merged class list is
 * whatever the browser would receive.
 */
describe("the response status chip", () => {
	const renderStatus = (status: number, statusText: string) => {
		render(<ResponseStatusBar status={status} statusText={statusText} time={12} size={34} />);
		const el = screen.getByText(new RegExp(status === 0 ? "ERR" : String(status)));
		return el.closest('[data-slot="badge"]') as HTMLElement;
	};

	it("has no hover background at all", () => {
		const badge = renderStatus(200, "OK");
		expect(badge).not.toBeNull();
		expect(badge.className).not.toMatch(/hover:bg-/);
	});

	it("still paints its status fill", () => {
		expect(renderStatus(200, "OK").className).toContain("bg-status-success-fill");
	});

	it("does not fall back to the accent for any status class", () => {
		// One per branch of the ternary - 0, 2xx, 3xx, 4xx, 5xx - since the bug
		// was invisible at rest and identical across all of them.
		for (const [code, text] of [
			[0, "ERR"],
			[200, "OK"],
			[301, "Moved"],
			[404, "Not Found"],
			[500, "Server Error"],
		] as const) {
			const badge = renderStatus(code, text);
			expect(badge.className, `status ${code}`).not.toMatch(/hover:bg-/);
			expect(badge.className, `status ${code}`).not.toMatch(/bg-primary-fill/);
			screen.getByText(new RegExp(code === 0 ? "ERR" : String(code)));
		}
	});
});

describe("no Badge overrides its background while keeping a hover variant", () => {
	/**
	 * `<Badge className="bg-…">` with any variant other than `chip` reintroduces
	 * the bug. Scanning source rather than rendering, because the defect is in
	 * the class string and every render looks correct at rest.
	 */
	const files = globSync("**/*.tsx", { cwd: srcRoot }).filter((f) => !f.includes(".test."));

	it("scans a real set of components", () => {
		expect(files.length).toBeGreaterThan(100);
	});

	/**
	 * Derived from `badgeVariants`, not hardcoded - `outline` and `chip` set no
	 * background and no hover, so a caller painting over them is fine. Only the
	 * variants that actually carry a `hover:bg-*` can produce the defect. A first
	 * version of this guard hardcoded "must be chip" and reported `outline`
	 * callers as offenders, which would have meant four real bugs arriving with
	 * two false ones attached.
	 */
	const variantHasHoverBg = (variant: string) =>
		/hover:bg-/.test(badgeVariants({ variant: variant as never }));

	it("only treats variants that own a hover background as risky", () => {
		expect(variantHasHoverBg("default")).toBe(true);
		expect(variantHasHoverBg("secondary")).toBe(true);
		expect(variantHasHoverBg("outline")).toBe(false);
		expect(variantHasHoverBg("chip")).toBe(false);
	});

	it("finds no offender", () => {
		// `<Badge …>` up to the closing angle bracket of the opening tag.
		const BADGE_TAG = /<Badge\b([^>]*)>/gs;
		const offences: string[] = [];

		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			for (const match of source.matchAll(BADGE_TAG)) {
				const props = match[1];

				// A *bare* `bg-…`, not `hover:bg-…` or `dark:bg-…` - a caller
				// authoring its own hover is deliberate and not this bug.
				const paintsOwnBackground = props
					.split(/[\s"'`{}(),]+/)
					.some((token) => token.startsWith("bg-"));
				if (!paintsOwnBackground) continue;

				// An unresolvable dynamic variant falls back to the cva default.
				const variant = props.match(/variant=["'](\w+)["']/)?.[1] ?? "default";
				if (!variantHasHoverBg(variant)) continue;

				const line = source.slice(0, match.index).split("\n").length;
				offences.push(
					`${relative(".", file)}:${line}  Badge variant="${variant}" sets its own ` +
						`bg-*, so that variant's hover:bg-* survives tailwind-merge and ` +
						`repaints it on hover. Use variant="chip".`
				);
			}
		}

		expect(offences.join("\n")).toBe("");
	});
});
