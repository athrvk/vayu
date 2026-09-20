/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `navigator.clipboard.writeText` has exactly two callers, and one of them is
 * a documented exception.
 *
 * `useCopy` exists because a hand-rolled copy does not receive the primitive's
 * fixes (#555, #565), and it was bypassed six times over anyway (#1686) - each
 * bypass re-introducing the same defect: an awaited write with no catch, so a
 * denied clipboard threw past the state that draws the feedback and the user
 * saw nothing at all. That is not a defect a behavioural test can find at the
 * sites that do not exist yet, so the rule is enforced on the source.
 *
 * `errors/ErrorBoundary.tsx` is the one legitimate direct call: it runs when
 * the React tree below it has already failed, and a hook is not reachable from
 * a class component's error state - the copy has to work with no hook tree at
 * all. It catches its own rejection.
 *
 * Mutation check: add an `await navigator.clipboard.writeText(x)` to any other
 * file under `src` and this fails, naming the file.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Relative to `app/src`. Adding to this list needs a reason in the comment above. */
const ALLOWED = ["hooks/useCopy.ts", "errors/ErrorBoundary.tsx"];

function sourceFiles() {
	return globSync("**/*.{ts,tsx}", { cwd: srcRoot })
		.filter((f) => !/\.test\.tsx?$|\.testkit\.ts$/.test(f))
		.map((f) => f.split("\\").join("/"));
}

describe("clipboard writes go through useCopy", () => {
	it("scanned a non-empty set of source files", () => {
		// Without this the whole guard passes forever on a glob that matched
		// nothing - a renamed directory, a changed `cwd`.
		const files = sourceFiles();
		expect(files.length).toBeGreaterThan(400);
		for (const allowed of ALLOWED) {
			expect(files, `${allowed} is not in the scanned set`).toContain(allowed);
		}
	});

	it("names writeText in the hook and the error boundary, and nowhere else", () => {
		const writers = sourceFiles().filter((f) =>
			/clipboard\??\.writeText/.test(readFileSync(join(srcRoot, f), "utf8"))
		);
		expect(writers.sort()).toEqual([...ALLOWED].sort());
	});

	it("leaves no call site scheduling its own copy reset", () => {
		// The three durations this replaced (1500ms, 2000ms and a shared
		// transient-status constant) each
		// lived in a `setTimeout` beside a `setCopied`. The reset is `useCopy`'s,
		// off `TIMING.COPY_RESET_MS`, and the hook schedules it through a named
		// `reset` callback rather than an inline setter.
		const offenders = sourceFiles().filter((f) =>
			/setTimeout\([^)]*setCopied/.test(readFileSync(join(srcRoot, f), "utf8"))
		);
		expect(offenders).toEqual([]);
	});
});
