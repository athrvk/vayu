/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The recorded parse of a fixture document (issue #877).
 *
 * Its own module, and deliberately importing **nothing of the app**: a
 * `vi.mock("@/services/api", ...)` factory reaches for this, and a factory that
 * pulls in a module which itself imports the mocked one closes a cycle the
 * module runner does not fail on - it deadlocks, and the test file hangs until
 * the CI job's timeout kills it with no output to say why. That is what
 * `import-preview.testkit.ts` cannot be used for: it imports `apiService` in
 * order to spy on it.
 */

import { readFileSync } from "node:fs";
import type { ImportResult } from "@/services/importers/types";
import { ENGINE_READING_GUARDS, fromRepoRoot } from "@/lib/routed-inputs.testkit";

/** Held in the testkit, so CI routes an edit to the fixture back to the suites. */
const [FIXTURE] = ENGINE_READING_GUARDS.recordedParse.paths.map(fromRepoRoot);

/**
 * Not a hand-written stand-in: `engine/tests/fixtures/import-conformance.json`
 * carries what the renderer's own parsers produced for each of these documents,
 * recorded at the commit before they were deleted and asserted against the
 * engine's parse on every build. So a case that pastes `postman-v21.json` and
 * previews it is looking at the same tree a running engine would answer with.
 */
export function recordedParse(name: string): ImportResult {
	const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
		cases: { name: string; expected: ImportResult }[];
	};
	const found = fixture.cases.find((entry) => entry.name === name);
	if (!found) throw new Error(`no recorded parse named "${name}"`);
	return found.expected;
}
