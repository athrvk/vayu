/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * @vitest-environment jsdom
 */

/**
 * One run's concurrency, one word for it.
 *
 * The history sidebar row said "256 workers" and the dashboard header said
 * "64 VUs" - the same `summary.concurrency` field, described two ways
 * depending on which screen you were on. Worse, "workers" is a name the engine
 * already owns (the libcurl event-loop thread count, a Settings key), so a
 * sidebar row reading "256 workers" for a run executed with `workers = 8` was
 * not just inconsistent, it was answering a question the reader did not ask.
 *
 * The defect is a *disagreement*, so pinning one component's string would not
 * catch it - the next rename to the other side would re-open the split with
 * both tests green. These render both surfaces over the same number and
 * compare the word each chose.
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import RunItem from "@/modules/history/sidebar/RunItem";
import DashboardHeader from "@/modules/dashboard/components/DashboardHeader";
import { CONCURRENCY_UNIT, formatConcurrency } from "@/constants/load-test-modes";
import type { Run } from "@/types";

const srcRoot = dirname(fileURLToPath(import.meta.url));

const CONCURRENCY = 64;

/**
 * Every text node under an element, separately.
 *
 * Not `textContent`: it runs the badges together ("3s" + "64 VUs" reads as
 * "3s64 VUs"), which loses the boundary the unit has to be read against.
 */
function textNodes(root: Element): string[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const out: string[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.textContent?.trim()) out.push(n.textContent);
	}
	return out;
}

/** The word a surface put immediately after the concurrency number, or null. */
function unitAfterConcurrency(texts: string[]): string | null {
	const pattern = new RegExp(`(?:^|\\s)${CONCURRENCY}\\s+(\\S+)`);
	for (const text of texts) {
		const unit = pattern.exec(text)?.[1];
		if (unit) return unit;
	}
	return null;
}

function sidebarRow(): string[] {
	const run = {
		id: "run_1",
		type: "load",
		status: "completed",
		startTime: 1_750_000_000_000,
		endTime: 1_750_000_003_000,
		requestId: "req_1",
		environmentId: null,
		summary: {
			url: "https://api.example.test/users",
			method: "GET",
			mode: "constant_concurrency",
			duration: "3s",
			concurrency: CONCURRENCY,
		},
	} as Run;

	const { container } = render(
		<RunItem run={run} onSelect={() => {}} onDelete={vi.fn()} isDeleting={false} />
	);
	return textNodes(container);
}

function detailHeader(): string[] {
	const { container } = render(
		<DashboardHeader
			runId="run_1"
			mode="completed"
			isStreaming={false}
			isStopping={false}
			onStop={async () => {}}
			requestUrl="https://api.example.test/users"
			requestMethod="GET"
			configuration={{ mode: "constant_concurrency", concurrency: CONCURRENCY }}
		/>
	);
	return textNodes(container);
}

describe("concurrency vocabulary", () => {
	it("describes the same run's concurrency with the same word on both surfaces", () => {
		const sidebar = unitAfterConcurrency(sidebarRow());
		const detail = unitAfterConcurrency(detailHeader());

		// Both must have rendered something - a null here would let the equality
		// below pass by rendering no concurrency at all.
		expect(sidebar, "history sidebar rendered no concurrency").not.toBeNull();
		expect(detail, "dashboard header rendered no concurrency").not.toBeNull();
		expect(sidebar).toBe(detail);
		expect(sidebar).toBe(CONCURRENCY_UNIT);
	});

	it("does not call a run's concurrency 'workers' on either surface", () => {
		// The engine's own `workers` setting is a different number entirely.
		expect(sidebarRow().join(" ")).not.toMatch(/workers/i);
		expect(detailHeader().join(" ")).not.toMatch(/workers/i);
	});

	it("renders the shared formatter's exact output on both surfaces", () => {
		expect(sidebarRow().join(" ")).toContain(formatConcurrency(CONCURRENCY));
		expect(detailHeader().join(" ")).toContain(formatConcurrency(CONCURRENCY));
	});

	it("is the only place the unit is written", () => {
		// A third surface appending its own unit is how the first split happened,
		// and a render test cannot see a surface it does not know about.
		const offences: string[] = [];

		const files = globSync("**/*.{ts,tsx}", { cwd: srcRoot }).filter(
			(f) => !f.includes("load-test-modes") && !f.includes(".test.")
		);
		expect(files.length, "scan matched nothing").toBeGreaterThan(100);

		for (const file of files) {
			const source = readFileSync(join(srcRoot, file), "utf8");
			// Strip comments: prose legitimately discusses both words.
			const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
			// A unit glued to an interpolated number - `${n} VUs`, `{n} workers` -
			// which is exactly the shape both call sites had before the helper.
			if (new RegExp(`\\}\\s*(${CONCURRENCY_UNIT}|workers)\\b`).test(code)) {
				offences.push(`${relative(".", file)} appends the unit itself`);
			}
		}

		expect(offences.join("\n")).toBe("");
	});
});
