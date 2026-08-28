/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The wiring that makes a doc guard run on the doc it guards.
 *
 * Four suites under `app/` assert against pages in `docs/`, and every area
 * filter in `pr-tests.yml` excludes Markdown - so a token value rewritten in
 * `docs/design-system.md`, or a hook renamed out of `docs/app/state-management.md`,
 * used to land green and fail on the next change to `app/` as if that change
 * had caused it (#1118 for the first guard, #1121 for the rest).
 *
 * The fix is a list of paths in a workflow that must agree with a list of paths
 * in TypeScript, which is the drift this repository keeps paying for. So the two
 * are compared rather than trusted, in one place for all four guards: adding a
 * page to `DOC_READING_GUARDS` is red until it is routed, and routing a page no
 * guard reads is red too.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
	DOC_READING_GUARDS,
	ROUTED_DOC_PAGES,
	ROUTING_FILTER,
	TESTKIT_MODULE,
	TESTKIT_PATH,
	WORKFLOW_PATH,
	fromRepoRoot,
	routedDocPaths,
} from "./routed-docs.testkit";

const workflow = readFileSync(WORKFLOW_PATH, "utf8");

describe("the docs the app suite reads", () => {
	/*
	 * A version of this that found no filter block, or no guards, would pass
	 * forever while comparing nothing - the empty-string failure mode this
	 * repository has already shipped once.
	 */
	it("has something to compare", () => {
		expect(workflow.length).toBeGreaterThan(1000);
		expect(Object.keys(DOC_READING_GUARDS).length).toBeGreaterThan(1);
		expect(ROUTED_DOC_PAGES.length).toBeGreaterThan(1);
		expect(routedDocPaths(workflow).length).toBeGreaterThan(0);
	});

	/*
	 * The three links in the wiring: the filter names exactly the pages the
	 * guards read, the `changes` job exports it, and the job that runs
	 * `pnpm test` reads it. A filter nothing reads would be this repository's
	 * most repeated defect in the file that documents it.
	 */
	it("routes every page a guard reads, and no other", () => {
		expect([...routedDocPaths(workflow)].sort()).toEqual([...ROUTED_DOC_PAGES].sort());
		expect(workflow).toContain(
			`${ROUTING_FILTER}: \${{ steps.area.outputs.${ROUTING_FILTER} }}`
		);
		expect(workflow).toContain(`needs.changes.outputs.${ROUTING_FILTER} == 'true'`);
	});

	it("names pages that exist", () => {
		for (const page of ROUTED_DOC_PAGES) {
			expect(existsSync(fromRepoRoot(page)), page).toBe(true);
		}
	});

	/*
	 * The guards are named here so the entries cannot outlive them, and each is
	 * required to import this module: a guard holding its own copy of the list
	 * is exactly the drift the module exists to end, and it would be routed
	 * correctly right up until someone edited one of the two copies.
	 */
	it("is the list its guards actually read", () => {
		expect(existsSync(fromRepoRoot(TESTKIT_PATH)), TESTKIT_PATH).toBe(true);

		for (const [name, guard] of Object.entries(DOC_READING_GUARDS)) {
			const path = fromRepoRoot(guard.test);
			expect(existsSync(path), guard.test).toBe(true);
			expect(readFileSync(path, "utf8"), name).toContain(`from "${TESTKIT_MODULE}"`);
			expect(guard.pages.length, name).toBeGreaterThan(0);
		}
	});
});
