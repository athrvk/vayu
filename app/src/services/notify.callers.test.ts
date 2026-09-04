/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * Which events may interrupt the user in another application (#1358).
 *
 * The list is short by design, and its shortness is the feature: 71 `showToast`
 * call sites across 30 files report the outcome of something the user just did
 * in a focused window - copied, saved, moved, switched, started - and every one
 * of those is answered by the toast alone. An OS notification is for the other
 * kind: asynchronous, terminal, and possibly landing while Vayu is not the
 * window in front.
 *
 * So this pins the callers rather than the non-callers. A file that starts
 * notifying has to be added here, which is the moment to ask whether its event
 * is really one the user should be pulled out of another application for. A
 * blocklist of today's toast sites would answer that question for the files
 * that exist today and for no other.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

/**
 * Every module that may post one, as a path relative to `src`.
 *
 * The settings panel is here because it asks what the build can do, not
 * because it posts; the check below reads imports, and one import is what both
 * look like.
 */
const ALLOWED = [
	"components/shared/OAuth2Form/TokenStatusRow.tsx",
	"hooks/useAppUpdate.ts",
	"hooks/useEngineRestart.ts",
	// The one caller whose event is neither terminal nor rare, which is why it
	// carries a second opt-in of its own and a coalescing window (#1388).
	"modules/inbox/capture-notifier.ts",
	"modules/settings/main/panels/NotificationsPanel.tsx",
	"queries/health.ts",
	"services/load-test-service.ts",
	"services/scenario-run-service.ts",
];

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return walk(full);
		return /\.tsx?$/.test(entry) ? [full] : [];
	});
}

/** An import of the notify service, by either of the two paths it is reached by. */
const IMPORTS_NOTIFY = /from\s+"(?:@\/services\/notify|\.\/notify)"/;

describe("who may post a system notification", () => {
	const files = walk(srcRoot).filter(
		(f) => !/\.test\.tsx?$/.test(f) && !f.endsWith(join("services", "notify.ts"))
	);

	it("scanned a non-empty tree", () => {
		// A guard that reads nothing passes forever.
		expect(files.length).toBeGreaterThan(100);
	});

	it("is exactly the list above", () => {
		const callers = files
			.filter((f) => IMPORTS_NOTIFY.test(readFileSync(f, "utf8")))
			.map((f) => relative(srcRoot, f).split("\\").join("/"))
			.sort();

		expect(callers).toEqual([...ALLOWED].sort());
	});
});
