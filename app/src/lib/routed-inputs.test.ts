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
 * renamed out of `docs/app/state-management/`, or a bound raised in
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

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	ROUTED_INPUTS,
	TESTKIT_MODULE,
	TESTKIT_PATH,
	WORKFLOW_PATH,
	entryExists,
	filterGlob,
	fromRepoRoot,
	markdownFiles,
	routedPaths,
} from "./routed-inputs.testkit";

const workflow = readFileSync(WORKFLOW_PATH, "utf8");

describe.each(ROUTED_INPUTS)("$filter", ({ filter, suite, readers, guards, routed }) => {
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
		expect([...routedPaths(workflow, filter)].sort()).toEqual(
			[...routed.map(filterGlob)].sort()
		);
		expect(workflow).toContain(`${filter}: \${{ steps.area.outputs.${filter} }}`);
		expect(workflow).toContain(`needs.changes.outputs.${filter} == 'true'`);
	});

	/*
	 * A suite's pass is reused when its fingerprint repeats, and the fingerprint
	 * hashes the files its filters name. A filter the fingerprint does not name
	 * routes the job and then skips it again off the earlier pass, so an edit to
	 * one of these files would run nothing (#3846).
	 */
	it("is in the fingerprint of the suite that reads it", () => {
		const fingerprints = [
			...workflow.matchAll(/suite-fingerprint\.py "\$wf" area ([^)]*)\)/g),
		].map((match) => match[1].trim().split(/\s+/));
		const named = fingerprints.find((names) => names[0] === suite);
		expect(named, `a fingerprint for the ${suite} suite`).toBeDefined();
		expect(named, `${filter} in the ${suite} fingerprint`).toContain(filter);
	});

	it("names paths that exist", () => {
		for (const path of routed) {
			expect(entryExists(path), path).toBe(true);
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
			expect(guard.paths.length, name).toBeGreaterThan(0);
			const source = readFileSync(path, "utf8");
			if (readers === "import") {
				expect(source, name).toContain(`from "${TESTKIT_MODULE}"`);
				continue;
			}
			/*
			 * A C++ reader cannot import the list, so it is held to the next best
			 * thing: it opens each file the entry says it does. The path is built
			 * from `/` segments there, so the file name is what the source carries.
			 */
			for (const read of guard.paths) {
				expect(source, `${guard.reader} reads ${read}`).toContain(basename(read));
			}
		}
	});
});

/*
 * A directory entry lets one registry line answer for every page under it, so a
 * page split into a directory of pages (`docs/app/components/`) keeps routing
 * as pages are added to it. The registry is compared with the filter by
 * expanding the entry to the `**` glob, and an entry whose directory holds no
 * Markdown is refused: the glob would match nothing and still look routed.
 */
describe("directory entries", () => {
	const scratch: string[] = [];
	afterEach(() => {
		for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tree(files: string[]): string {
		const root = mkdtempSync(join(tmpdir(), "routed-inputs-"));
		scratch.push(root);
		for (const file of files) {
			const path = join(root, ...file.split("/"));
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, "");
		}
		return root;
	}

	it("expands a directory to the ** glob under it and leaves a file alone", () => {
		expect(filterGlob("docs/app/components/")).toBe("docs/app/components/**");
		expect(filterGlob("docs/app/pm-api-compatibility.md")).toBe(
			"docs/app/pm-api-compatibility.md"
		);
	});

	it("matches the ** entry a filter lists for it", () => {
		const fixture = [
			"            some_filter:",
			"              - 'docs/app/components/**'",
			"              - 'docs/index.md'",
			"            other_filter:",
			"              - 'docs/unrelated.md'",
		].join("\n");
		const registry = ["docs/app/components/", "docs/index.md"];
		expect(routedPaths(fixture, "some_filter").sort()).toEqual(registry.map(filterGlob).sort());
		expect(routedPaths(fixture, "some_filter").sort()).not.toEqual([...registry].sort());
	});

	it("exists when Markdown is under it, at any depth", () => {
		const root = tree(["docs/app/components/index.md"]);
		expect(entryExists("docs/app/components/", root)).toBe(true);
		const nested = tree(["docs/app/components/deep/er/page.md"]);
		expect(entryExists("docs/app/components/", nested)).toBe(true);
	});

	it("does not exist when the directory is missing, empty, or holds no Markdown", () => {
		const root = tree(["docs/app/other/index.md", "docs/app/components/schema.json"]);
		expect(entryExists("docs/app/missing/", root)).toBe(false);
		expect(entryExists("docs/app/components/", root)).toBe(false);
		mkdirSync(join(root, "docs", "app", "empty"));
		expect(entryExists("docs/app/empty/", root)).toBe(false);
	});

	it("lists the Markdown under a directory at any depth, in name order, and nothing else", () => {
		const root = tree([
			"docs/app/components/b.md",
			"docs/app/components/a.md",
			"docs/app/components/deep/c.md",
			"docs/app/components/schema.json",
		]);
		const names = markdownFiles(join(root, "docs", "app", "components")).map((path) =>
			path.slice(join(root, "docs", "app", "components").length + 1).replace(/\\/g, "/")
		);
		expect(names).toEqual(["a.md", "b.md", "deep/c.md"]);
	});

	it("does not take a file for a directory", () => {
		const root = tree(["docs/app/components.md"]);
		expect(entryExists("docs/app/components/", root)).toBe(false);
		expect(entryExists("docs/app/components.md", root)).toBe(true);
	});

	it("keeps a file entry's plain existence check", () => {
		const root = tree(["docs/index.md"]);
		expect(entryExists("docs/index.md", root)).toBe(true);
		expect(entryExists("docs/missing.md", root)).toBe(false);
	});
});

/*
 * The engine filter lists inputs by hand and nothing derives it from the job,
 * so a floor-check script the engine job runs can be edited on a PR that never
 * runs it (#1864). Compared against the job's own `run:` lines rather than a
 * second list.
 */
describe("engine filter", () => {
	it("routes every scripts/check-*.sh the workflow runs", () => {
		const run = [...workflow.matchAll(/run:\s*\.\/(scripts\/check-[\w-]+\.sh)/g)].map(
			(m) => m[1]
		);
		expect(run.length).toBeGreaterThan(0);
		const routed = routedPaths(workflow, "engine");
		for (const script of run) {
			expect(routed, script).toContain(script);
		}
	});
});
