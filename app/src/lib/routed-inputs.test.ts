/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The wiring that makes a guard run on the file it guards.
 *
 * Suites under `app/` assert against pages in `docs/` and against sources and
 * fixtures in `engine/`, and every area filter in `pr-tests.yml` routes on
 * `app/**` - so a token value rewritten in `docs/design-system.md`, a hook
 * renamed out of `docs/app/state-management.md`, or a bound raised in
 * `engine/include/vayu/core/constants.hpp` used to land green and fail on the
 * next change to `app/` as if that change had caused it (#1118 and #1121 for
 * the doc half, #1122 for the engine half).
 *
 * The fix is a list of paths in a workflow that must agree with a list of paths
 * in TypeScript, which is the drift this repository keeps paying for. So the two
 * are compared rather than trusted, in one place for every guard: adding a path
 * to a registry is red until it is routed, and routing a path no guard reads is
 * red too.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
	ROUTED_INPUTS,
	TESTKIT_MODULE,
	TESTKIT_PATH,
	WORKFLOW_PATH,
	fromRepoRoot,
	routedPaths,
} from "./routed-inputs.testkit";

const workflow = readFileSync(WORKFLOW_PATH, "utf8");

describe.each(ROUTED_INPUTS)("$filter", ({ filter, guards, routed }) => {
	/*
	 * A version of this that found no filter block, or no guards, would pass
	 * forever while comparing nothing - the empty-string failure mode this
	 * repository has already shipped once.
	 */
	it("has something to compare", () => {
		expect(workflow.length).toBeGreaterThan(1000);
		expect(Object.keys(guards).length).toBeGreaterThan(1);
		expect(routed.length).toBeGreaterThan(1);
		expect(routedPaths(workflow, filter).length).toBeGreaterThan(0);
	});

	/*
	 * The three links in the wiring: the filter names exactly the paths the
	 * guards read, the `changes` job exports it, and the job that runs
	 * `pnpm test` reads it. A filter nothing reads would be this repository's
	 * most repeated defect in the file that documents it.
	 */
	it("routes every path a guard reads, and no other", () => {
		expect([...routedPaths(workflow, filter)].sort()).toEqual([...routed].sort());
		expect(workflow).toContain(`${filter}: \${{ steps.area.outputs.${filter} }}`);
		expect(workflow).toContain(`needs.changes.outputs.${filter} == 'true'`);
	});

	it("names paths that exist", () => {
		for (const path of routed) {
			expect(existsSync(fromRepoRoot(path)), path).toBe(true);
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

		for (const [name, guard] of Object.entries(guards)) {
			const path = fromRepoRoot(guard.reader);
			expect(existsSync(path), guard.reader).toBe(true);
			expect(readFileSync(path, "utf8"), name).toContain(`from "${TESTKIT_MODULE}"`);
			expect(guard.paths.length, name).toBeGreaterThan(0);
		}
	});
});
