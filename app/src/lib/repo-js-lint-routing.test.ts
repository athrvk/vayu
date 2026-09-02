/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The wiring that makes the JavaScript outside `app/` reach the lint that reads
 * it (#1166).
 *
 * That lint takes its files from `git ls-files`, so it covers a script added
 * tomorrow - but only on a pull request that routes to the job it runs in. The
 * filter and the file list are two spellings of one set, in two languages, in
 * one file: a `.jsx` harness added to the lint's pathspec and not to the filter
 * would be linted by a job that never runs on it, which is #1118's defect in the
 * gate that exists to end it.
 *
 * So the filter is derived here from the lint step rather than compared with a
 * third copy of the list: the entries `repo_js` must carry are exactly what the
 * step's own pathspec and exclusions imply, and either side moving alone is red.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { WORKFLOW_PATH, fromRepoRoot, repoRoot, routedPaths } from "./routed-inputs.testkit";

const FILTER = "repo_js";
const STEP_NAME = "Lint JavaScript outside app/";

const workflow = readFileSync(WORKFLOW_PATH, "utf8");

/**
 * The lint step's shell, from its `- name:` line to the next step's. Read as
 * text for the reason `routedPaths` is: `app/` declares no YAML parser, and one
 * step's `run:` block is a shape a regular expression can honestly describe.
 */
function lintStep(): string {
	const lines = workflow.split("\n");
	const start = lines.findIndex((line) => line.trim() === `- name: ${STEP_NAME}`);
	if (start === -1) return "";

	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^\s*- name: /.test(line));
	return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

/**
 * The job the lint step belongs to, from its own line back to the nearest job
 * key. Which job it is matters as much as that some job names the filter: a
 * clause that drifts onto another job's condition leaves the substring in the
 * file and the lint step unreachable, which is the drift this file exists for.
 */
function jobRunningLint(): string {
	const lines = workflow.split("\n");
	const step = lines.findIndex((line) => line.trim() === `- name: ${STEP_NAME}`);
	if (step === -1) return "";

	const isJobKey = (line: string) => /^ {2}[A-Za-z0-9_-]+:$/.test(line);
	let start = -1;
	for (let line = step - 1; line >= 0 && start === -1; line--) {
		if (isJobKey(lines[line])) start = line;
	}
	if (start === -1) return "";

	const rest = lines.slice(start + 1);
	const end = rest.findIndex(isJobKey);
	return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

const step = lintStep();
const job = jobRunningLint();

/** `git ls-files -- '*.mjs' '*.cjs' '*.js'` - the extensions, as written. */
const pathspec = [...step.matchAll(/'(\*\.[a-z]+)'/g)].map((match) => match[1]);

/** `| grep -v '^app/'` - the prefixes the step drops, as written. */
const prefixesDropped = [...step.matchAll(/grep -v '\^([^']+)'/g)].map((match) => match[1]);

const configPath = /--config (\S+)/.exec(step)?.[1] ?? "";

/**
 * The files that lint would run on today. From `git ls-files`, the same source
 * the step uses: a list written out here would be the copy this test exists to
 * refuse, and would go stale the day a third harness lands.
 */
function lintedFiles(): string[] {
	const tracked = execFileSync("git", ["ls-files", "--", ...pathspec], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	return tracked
		.split("\n")
		.filter(Boolean)
		.filter((file) => !prefixesDropped.some((prefix) => file.startsWith(prefix)));
}

describe("JavaScript outside app/", () => {
	/*
	 * A version of this that found no step would derive an empty filter from an
	 * empty pathspec and compare nothing, passing forever - the empty-string
	 * failure mode this repository has already shipped once.
	 */
	it("has something to scan", () => {
		expect(step.length).toBeGreaterThan(200);
		expect(job.length).toBeGreaterThan(step.length);
		expect(pathspec.length).toBeGreaterThan(0);
		expect([...prefixesDropped].sort()).toEqual(["app/", "engine/vendor/"]);
		expect(lintedFiles().length).toBeGreaterThan(0);
	});

	/*
	 * The filter, derived from the lint rather than trusted beside it: both glob
	 * forms per extension (the bare one for a root-level file, the nested one for
	 * everything below), this workflow so a change to the split routes to itself,
	 * and the step's own two exclusions.
	 */
	it("routes every file the lint reads, and no other", () => {
		const expected = [
			...pathspec.flatMap((glob) => [glob, `**/${glob}`]),
			".github/workflows/pr-tests.yml",
			...prefixesDropped.map((prefix) => `!${prefix}**`),
		];

		expect([...routedPaths(workflow, FILTER)].sort()).toEqual([...expected].sort());
	});

	/*
	 * A filter nothing reads routes nowhere, and a filter the wrong job reads
	 * routes somewhere useless - so the condition asserted is the one belonging
	 * to whichever job the step is written into, found from the step rather than
	 * named here.
	 */
	it("is exported by the changes job and read by the job that lints", () => {
		expect(workflow).toContain(`${FILTER}: \${{ steps.area.outputs.${FILTER} }}`);
		expect(job).toMatch(
			new RegExp(`^\\s*if: .*needs\\.changes\\.outputs\\.${FILTER} == 'true'`, "m")
		);
	});

	/*
	 * The config is the third thing that can drift: an extension linted and
	 * routed, with no block in the config to give it a parser, is linted as
	 * whatever ESLint defaults to rather than as what Node runs. Its `ignores`
	 * are held to the step's own exclusions for the other direction - a run
	 * started by hand or by an editor takes the config's word for what is out of
	 * bounds, where the step takes `grep`'s.
	 */
	it("lints every extension against a config block written for it", () => {
		expect(existsSync(fromRepoRoot(configPath)), configPath).toBe(true);

		const config = readFileSync(fromRepoRoot(configPath), "utf8");
		for (const glob of pathspec) {
			expect(config, glob).toContain(`"**/${glob}"`);
		}
		for (const prefix of prefixesDropped) {
			expect(config, prefix).toContain(`"${prefix}**"`);
		}
	});
});
