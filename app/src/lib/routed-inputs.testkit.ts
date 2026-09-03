/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The files outside `app/` that the app suite reads, and the CI filters that
 * have to route them.
 *
 * Guards under `app/` assert against files the app does not own - pages under
 * `docs/`, sources and fixtures under `engine/`, files at the repository root -
 * which makes each of those files a test input in the same sense a source file
 * under `app/src` is: edit it and `pnpm test` can go red. The area filters in
 * `pr-tests.yml` route on `app/**` and exclude Markdown, so until #1118 none of
 * those edits ran the job that would catch them: the failure surfaced on the
 * next unrelated change under `app/`, attributed to that change. #1118 routed
 * one guard's two pages, #1121 the other doc guards', #1122 the engine half,
 * #1130 the two root files.
 *
 * The lists live here, not in the guards, for the reason the routing exists at
 * all: two copies of a path list drift. A guard imports the paths it reads, the
 * workflow lists the union per filter, and `routed-inputs.test.ts` compares the
 * two - so a path added to a guard is red until it is routed, and a path routed
 * that no guard reads is red too.
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
 * `routed-inputs.test.ts` asserts both, so a rename that reaches most of the
 * guards cannot pass by leaving a stale name that still reads as a prefix.
 */
export const TESTKIT_MODULE = "@/lib/routed-inputs.testkit";
export const TESTKIT_PATH = "app/src/lib/routed-inputs.testkit.ts";

/**
 * One test that reads outside `app/`, with the repository-relative paths it
 * reads.
 *
 * `reader` is the file itself: `routed-inputs.test.ts` asserts each one exists
 * and imports this module, so an entry cannot outlive the guard that justified
 * it or quietly stop being that guard's own list. It is usually a `.test.ts`,
 * but a `.testkit.ts` a suite imports is a reader too - the fixture it opens
 * turns those suites red exactly the same way.
 */
interface ReadingGuard {
	readonly reader: string;
	readonly paths: readonly string[];
}

/**
 * Every guard that reads a page under `docs/`, with the pages it reads.
 *
 * A fifth guard belongs here the day it is written - the union below is derived,
 * so adding an entry is what asks CI to route its pages.
 */
export const DOC_READING_GUARDS = {
	scriptTypedefs: {
		reader: "app/src/hooks/script-typedefs.docs-compile.test.ts",
		paths: ["docs/engine/scripting.md", "docs/app/pm-api-compatibility.md"],
	},
	/*
	 * The same two pages, read for a different question (#1223): the script
	 * panels stopped stating the `pm.*` rules in prose, so this guard is what
	 * holds each rule to the surface it moved to - the completion table for a
	 * member's rule, these pages for a hook's.
	 */
	scriptRules: {
		reader: "app/src/modules/request-builder/components/RequestTabs/panels/script-rules.test.ts",
		paths: ["docs/engine/scripting.md", "docs/app/pm-api-compatibility.md"],
	},
	designSystem: {
		reader: "app/src/design-system-doc.test.ts",
		paths: ["docs/design-system.md"],
	},
	/*
	 * The second reader of that page, and the one that reads its prose: the
	 * Type Scale Conventions table names the weight of the micro/badge step,
	 * which the components either match or do not (#1199). `design-system-doc`
	 * checks the page's colour *values* against `index.css` and says so - a
	 * table cell is not a value, and neither guard covers the other's half.
	 */
	typeScale: {
		reader: "app/src/components/ui/type-scale.test.ts",
		paths: ["docs/design-system.md"],
	},
	/*
	 * The third reader of that page, and the second of its prose (#1282): the
	 * Accessibility section enumerates the `jsx-a11y` rules suppressed at the
	 * line, and the guard holds that list to what `app/src` actually carries. A
	 * site edited out of the doc alone is the drift it exists to catch, so the
	 * page is one of its inputs in the same sense the sources are.
	 */
	a11ySuppressions: {
		reader: "app/src/components/a11y-suppressions.test.ts",
		paths: ["docs/design-system.md"],
	},
	rendererState: {
		reader: "app/src/state-management-doc.test.ts",
		paths: [
			"docs/app/state-management.md",
			"docs/app/architecture.md",
			"docs/app/api-integration.md",
		],
	},
	rowPersistence: {
		reader: "app/src/modules/collections/row-persistence-claims.test.ts",
		paths: ["docs/app/data-driven-runs.md", "docs/app/COMPONENTS.md"],
	},
} as const satisfies Record<string, ReadingGuard>;

/**
 * Every guard that reads a file under `engine/`, with the files it reads.
 *
 * Two shapes, one rule. A *parity* guard reads engine source and pins a value
 * the app restates - a bound, an enum, a directory name - so the two cannot
 * drift apart silently. A *conformance* guard replays a fixture the engine's
 * own tests generate, so both sides answer the same cases the same way. Either
 * way the engine file is the input, and an edit to it is what the guard exists
 * to catch (#1122).
 */
export const ENGINE_READING_GUARDS = {
	mcpSafetyCeiling: {
		reader: "app/electron/mcp/safety.test.ts",
		paths: ["engine/include/vayu/core/constants.hpp"],
	},
	dataDirLayout: {
		reader: "app/electron/app-paths.test.ts",
		paths: ["engine/src/daemon.cpp"],
	},
	loadTestBounds: {
		reader: "app/src/constants/load-test.engine-parity.test.ts",
		paths: ["engine/include/vayu/core/constants.hpp", "engine/src/http/routes/execution.cpp"],
	},
	importEvents: {
		reader: "app/src/constants/import.engine-parity.test.ts",
		paths: ["engine/include/vayu/core/constants.hpp"],
	},
	settingsShelves: {
		reader: "app/src/modules/settings/engine-categories.test.ts",
		paths: ["engine/src/db/database.cpp"],
	},
	httpVersionOptions: {
		reader: "app/src/modules/settings/main/SettingsMain.enum.test.tsx",
		paths: ["engine/include/vayu/types.hpp", "engine/src/db/database.cpp"],
	},
	/*
	 * The one guard in both registries: it reads three pages under `docs/` and,
	 * for the identifiers those pages name that `app/src` does not declare, the
	 * engine headers that do.
	 */
	rendererStateOwners: {
		reader: "app/src/state-management-doc.test.ts",
		paths: [
			"engine/include/vayu/core/constants.hpp",
			"engine/include/vayu/http/curl_version_map.hpp",
		],
	},
	scriptTypedefs: {
		reader: "app/src/hooks/script-typedefs.docs-compile.test.ts",
		paths: ["engine/tests/fixtures/script-typedefs.d.ts"],
	},
	/* The generated declarations carry the completion table's documentation
	   strings verbatim, which is what makes them readable as the rules the
	   script panels no longer state (#1223). */
	scriptRules: {
		reader: "app/src/modules/request-builder/components/RequestTabs/panels/script-rules.test.ts",
		paths: ["engine/tests/fixtures/script-typedefs.d.ts"],
	},
	treeOrder: {
		reader: "app/src/types/tree-order.conformance.test.ts",
		paths: ["engine/tests/fixtures/tree-order-conformance.json"],
	},
	recursiveRunOrder: {
		reader: "app/src/modules/collections/CollectionTree.run-order.conformance.test.tsx",
		paths: ["engine/tests/fixtures/recursive-run-order-conformance.json"],
	},
	variableResolution: {
		reader: "app/src/lib/variable-resolution.conformance.test.ts",
		paths: ["engine/tests/fixtures/variable-resolution-conformance.json"],
	},
	/*
	 * The same fixture, read by the third implementation of the resolution order
	 * (issue #1207): the MCP `resolve_variables` tool cannot import the
	 * renderer's resolver across the process boundary, so it mirrors it and this
	 * guard replays the fixture against both.
	 */
	mcpVariableOrigins: {
		reader: "app/electron/mcp/variable-origins.conformance.test.ts",
		paths: ["engine/tests/fixtures/variable-resolution-conformance.json"],
	},
	setCookie: {
		reader: "app/src/modules/request-builder/components/ResponseViewer/parse-set-cookie.conformance.test.ts",
		paths: ["engine/tests/fixtures/set-cookie-conformance.json"],
	},
	importPayloads: {
		reader: "app/src/services/importers/orchestrator.payload-conformance.test.ts",
		paths: ["engine/tests/fixtures/import-conformance.json"],
	},
	/*
	 * Not a suite of its own: the five `ImportModal.*.test.tsx` files reach this
	 * fixture through `import-preview.testkit.ts`, so an edit to it turns them
	 * red without any of them naming it.
	 */
	recordedParse: {
		reader: "app/src/modules/collections/recorded-parse.testkit.ts",
		paths: ["engine/tests/fixtures/import-conformance.json"],
	},
} as const satisfies Record<string, ReadingGuard>;

/**
 * Every guard that reads a file at the repository root, with the files it reads.
 *
 * The third route to the same defect (#1130). These two are neither prose the
 * `app` filter excludes nor engine sources it never matched: `README.md` is
 * rejected by `!*.md` *and* twice over by `code`, so a README-only pull request
 * runs no job at all, and `install.sh` matches `installer` and `scripts` - which
 * run the installer suite and shellcheck, and not the one guard holding the
 * Electron side to the shell's layout.
 *
 * Both guards exist because a value lives in two places that cannot share a
 * constant: the macOS update command in the README and in `updater.ts`, the
 * Linux install layout in `install.sh` and in `appimage-stamp.ts`. Routing them
 * is what makes the edit to the copy outside `app/` run the guard.
 */
export const ROOT_READING_GUARDS = {
	macUpdateCommand: {
		reader: "app/electron/updater.test.ts",
		paths: ["README.md"],
	},
	appImageLayout: {
		reader: "app/electron/appimage-stamp.layout.test.ts",
		paths: ["install.sh"],
	},
} as const satisfies Record<string, ReadingGuard>;

function union(guards: Record<string, ReadingGuard>): readonly string[] {
	return [...new Set(Object.values(guards).flatMap((guard) => guard.paths))];
}

/**
 * What each filter must list, derived rather than written out: a hand-kept union
 * is the third copy of the same list.
 */
export const ROUTED_DOC_PAGES = union(DOC_READING_GUARDS);
export const ROUTED_ENGINE_PATHS = union(ENGINE_READING_GUARDS);
export const ROUTED_ROOT_PATHS = union(ROOT_READING_GUARDS);

export const WORKFLOW_PATH = fromRepoRoot(".github/workflows/pr-tests.yml");

/**
 * The filters in that workflow whose whole job is to route the paths above, and
 * the guards each one answers for. One table rather than three comparisons: the
 * engine half arrived a fix later than the doc half (#1122 after #1118 and
 * #1121) and the root half later still (#1130), and the table is what made the
 * third kind of input cost an entry here rather than a third copy of the same
 * assertions.
 */
export const ROUTED_INPUTS = [
	{ filter: "app_doc_fixtures", guards: DOC_READING_GUARDS, routed: ROUTED_DOC_PAGES },
	{ filter: "app_engine_inputs", guards: ENGINE_READING_GUARDS, routed: ROUTED_ENGINE_PATHS },
	{ filter: "app_root_inputs", guards: ROOT_READING_GUARDS, routed: ROUTED_ROOT_PATHS },
] as const;

/**
 * The paths one filter routes to the job running `pnpm test`.
 *
 * Read as text, not YAML: `app/` declares no YAML parser, and the block is a
 * flat list of single-quoted paths - the same shape every other guard in this
 * repository scans its input in. A line that is neither a comment nor a list
 * entry ends the filter, which is how the next filter's key stops the walk.
 */
export function routedPaths(workflow: string, filter: string): string[] {
	const lines = workflow.split("\n");
	const key = lines.findIndex((line) => line.trim() === `${filter}:`);
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
