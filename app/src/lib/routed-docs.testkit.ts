/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The pages under `docs/` that the app suite reads, and the CI filter that has
 * to route them.
 *
 * Four guards assert against repository documentation, which makes each page
 * they read a test input in the same sense a source file is: edit it and
 * `pnpm test` can go red. Every area filter in `pr-tests.yml` excludes Markdown,
 * so until #1118 none of those edits ran the job that would catch them - the
 * failure surfaced on the next unrelated change under `app/`, attributed to that
 * change. #1118 routed one guard's two pages; this module is #1121 doing the
 * same for the other three, in one place rather than four.
 *
 * The lists live here, not in the guards, for the reason the routing exists at
 * all: two copies of a path list drift. A guard imports the pages it reads, the
 * workflow lists the union, and `routed-docs.test.ts` compares the two - so a
 * page added to a guard is red until it is routed, and a page routed that no
 * guard reads is red too.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root. This file is `app/src/lib/`, so three levels up. */
export const repoRoot = join(here, "..", "..", "..");

/**
 * A repository-relative, POSIX-spelled path as this machine spells it. The
 * POSIX form is the one the workflow lists and the one these tests compare, so
 * it is what the guards hold; only the read needs the native separator.
 */
export function fromRepoRoot(path: string): string {
	return join(repoRoot, ...path.split("/"));
}

/**
 * This module, as a guard imports it and as the repository stores it.
 * `routed-docs.test.ts` asserts both, so a rename that reaches three of the four
 * guards cannot pass by leaving a stale name that still reads as a prefix.
 */
export const TESTKIT_MODULE = "@/lib/routed-docs.testkit";
export const TESTKIT_PATH = "app/src/lib/routed-docs.testkit.ts";

/**
 * Every guard that reads a page under `docs/`, with the pages it reads.
 *
 * `test` is the guard itself, repository-relative: `routed-docs.test.ts` asserts
 * each one exists and imports this module, so an entry cannot outlive the guard
 * that justified it or quietly stop being the guard's own list.
 *
 * A fifth guard belongs here the day it is written - the union below is derived,
 * so adding an entry is what asks CI to route its pages.
 */
export const DOC_READING_GUARDS = {
	scriptTypedefs: {
		test: "app/src/hooks/script-typedefs.docs-compile.test.ts",
		pages: ["docs/engine/scripting.md", "docs/app/pm-api-compatibility.md"],
	},
	designSystem: {
		test: "app/src/design-system-doc.test.ts",
		pages: ["docs/design-system.md"],
	},
	rendererState: {
		test: "app/src/state-management-doc.test.ts",
		pages: [
			"docs/app/state-management.md",
			"docs/app/architecture.md",
			"docs/app/api-integration.md",
		],
	},
	rowPersistence: {
		test: "app/src/modules/collections/row-persistence-claims.test.ts",
		pages: ["docs/app/data-driven-runs.md", "docs/app/COMPONENTS.md"],
	},
} as const;

/**
 * The union of those pages, which is what the workflow filter must list. Derived
 * rather than written out: a hand-kept union is the third copy of the same list.
 */
export const ROUTED_DOC_PAGES: readonly string[] = [
	...new Set(Object.values(DOC_READING_GUARDS).flatMap((guard) => guard.pages)),
];

export const WORKFLOW_PATH = fromRepoRoot(".github/workflows/pr-tests.yml");

/** The filter in that workflow whose whole job is to route the pages above. */
export const ROUTING_FILTER = "app_doc_fixtures";

/**
 * The paths that filter routes to the job running `pnpm test`.
 *
 * Read as text, not YAML: `app/` declares no YAML parser, and the block is a
 * flat list of single-quoted paths - the same shape every other guard in this
 * repository scans its input in. A line that is neither a comment nor a list
 * entry ends the filter, which is how the next filter's key stops the walk.
 */
export function routedDocPaths(workflow: string): string[] {
	const lines = workflow.split("\n");
	const key = lines.findIndex((line) => line.trim() === `${ROUTING_FILTER}:`);
	if (key === -1) return [];

	const keyIndent = lines[key].length - lines[key].trimStart().length;
	const routed: string[] = [];
	for (const line of lines.slice(key + 1)) {
		const indent = line.length - line.trimStart().length;
		if (indent <= keyIndent) break;
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue;
		const entry = /^- '(.+)'$/.exec(trimmed);
		if (!entry) break;
		routed.push(entry[1]);
	}
	return routed;
}
