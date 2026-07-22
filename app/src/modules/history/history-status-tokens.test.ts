/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Status colour in the history views comes from tokens, not the raw palette.
 *
 * Three sites had drifted, and each was *paired* with a `dark:` variant, so
 * they read as fine on a theme-blindness check and were not:
 *
 *   - the "stopped" run badge, raw orange next to a sidebar that already used
 *     `--status-stopped` for exactly that state;
 *   - the rate-control achievement figure, whose good/caution branches were raw
 *     while its bad branch already used `--destructive-text`, so one expression
 *     spoke two vocabularies;
 *   - the sampled-request card's success border, raw green framing a
 *     `--status-success` icon.
 *
 * The discriminator is *what the colour means*, not whether it is paired.
 * Deliberately excluded below: `TimingBreakdown` (DNS/connect/TLS/TTFB/download
 * phases) and `OverviewTab`'s status-code tiles are the documented decorative
 * categorical palettes - fixed identity, no state - and design-system.md names
 * them as the token exception. Scanning them would be a false positive.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Files whose colour is state, so all of it must be tokenised. */
const STATE_COLOURED = [
	"main/HistoryDetail.tsx",
	"main/components/PerformanceTab.tsx",
	"main/components/SampleRequestCard.tsx",
	"sidebar/RunItem.tsx",
];

/**
 * Raw Tailwind palette hues carrying status meaning, in any utility position
 * (text / bg / border / ring) and with or without a `dark:` pair.
 *
 * `purple` is absent on purpose: the P99 tile and the load-run bolt were
 * measured at 3.50/3.66 and 3.93/4.59 against the 3.0 non-text bar and kept,
 * there being no violet semantic token to move them to.
 */
const RAW_STATUS_PALETTE =
	/(?:^|[\s"'`:])(?:dark:)?(?:text|bg|border|ring)-(?:red|green|emerald|yellow|amber|orange|blue|sky)-\d{2,3}/;

describe("history status colours use tokens", () => {
	for (const relative of STATE_COLOURED) {
		it(`${relative} has no raw status palette`, () => {
			const source = readFileSync(join(here, relative), "utf8");

			// A guard that reads an empty file passes forever. Assert it read
			// something, and something that actually styles.
			expect(source.length).toBeGreaterThan(500);
			expect(source).toContain("className");

			const offenders = source
				.split("\n")
				.map((line, i) => [i + 1, line] as const)
				.filter(([, line]) => RAW_STATUS_PALETTE.test(line));

			expect(
				offenders.map(([n, line]) => `${relative}:${n}: ${line.trim()}`),
				"raw palette used for a status colour; use --status-* / semantic -text tokens"
			).toEqual([]);
		});
	}

	// The regex is only as good as its ability to fire. Pin that separately, so
	// a botched pattern can't quietly turn every case above into a no-op.
	it("the pattern actually matches the classes it is meant to catch", () => {
		expect(RAW_STATUS_PALETTE.test('className="text-orange-600"')).toBe(true);
		expect(RAW_STATUS_PALETTE.test('"border-green-500/20"')).toBe(true);
		expect(RAW_STATUS_PALETTE.test('"text-green-600 dark:text-green-400"')).toBe(true);
		// Tokens must not trip it.
		expect(RAW_STATUS_PALETTE.test('"text-status-stopped-text"')).toBe(false);
		expect(RAW_STATUS_PALETTE.test('"border-status-success/20"')).toBe(false);
		expect(RAW_STATUS_PALETTE.test('"text-warning-text"')).toBe(false);
	});
});
