/**
 * The pr-tests.yml path-filter routing table (issue #915).
 *
 * The `changes` job's two `dorny/paths-filter` invocations decide, for every
 * pull request, which of the areas a change routes to - and therefore whether
 * the three-platform engine matrix, the app matrix, the installer suites and
 * the script lint run at all. Both failure directions cost something and only
 * one of them is visible: routing too much wastes runners (#913, where a
 * change to `engine/CLAUDE.md` plus any script ran the engine matrix with no
 * engine source touched), and routing too little makes a job quietly *not*
 * run - a green pull request that never compiled the engine looks exactly like
 * a green pull request that did.
 *
 * So this reads the filters **out of the workflow file** and asserts a table of
 * (changed files) -> (areas). It never keeps a second copy of the globs: a
 * copy would drift and go on passing while the real thing was wrong, which is
 * the failure it exists to catch.
 *
 * It also uses the matcher the action uses - picomatch with `{dot: true}`, and
 * paths-filter's own quantifier semantics transcribed from its `filter.ts`.
 * Reimplementing the glob engine here would be the copy-of-a-primitive trap in
 * its purest form: a hand-rolled matcher that disagrees with picomatch would
 * report a pass for a routing that CI does differently.
 *
 * Run: cd scripts/test/routing && npm ci && node paths_filter_test.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";
import picomatch from "picomatch";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "pr-tests.yml");

// paths-filter's own matcher options (`MatchOptions` in src/filter.ts). `dot`
// is what makes `engine/**` match `engine/.clang-tidy`.
const MATCH_OPTIONS = { dot: true };

// The action's package.json pins `picomatch: ^2.3.1`, so this package pins 2.x
// too. A major bump on either side changes glob behaviour, and a test matching
// under different rules than CI proves nothing - hence the ref check below.
const EXPECTED_USES = "dorny/paths-filter@v4";

let passed = 0;
let failed = 0;

function ok(name) {
	console.log(`  ok - ${name}`);
	passed += 1;
}

function bad(name, detail) {
	console.log(`  FAIL - ${name}`);
	console.log(`         ${detail}`);
	failed += 1;
}

function check(name, condition, detail) {
	if (condition) ok(name);
	else bad(name, detail);
}

// --- reading the filters out of the workflow ------------------------------

/**
 * Pull every `dorny/paths-filter` invocation out of the `changes` job.
 *
 * Throws rather than returning an empty table on anything unexpected. A
 * selector that silently reads no filters would pass every case below while
 * asserting nothing, which is the one failure mode this suite cannot survive
 * quietly (CLAUDE.md's source-scan rule).
 */
function readPathFilters(workflowText) {
	const doc = yaml.load(workflowText);
	const steps = doc?.jobs?.changes?.steps;
	if (!Array.isArray(steps)) {
		throw new Error(
			"pr-tests.yml has no `changes` job with steps - the filters cannot be read"
		);
	}

	const invocations = [];
	for (const step of steps) {
		if (typeof step?.uses !== "string" || !step.uses.startsWith("dorny/paths-filter@"))
			continue;
		const filtersYaml = step.with?.filters;
		if (typeof filtersYaml !== "string") {
			throw new Error(`paths-filter step '${step.id}' has no inline \`filters\` string`);
		}
		const parsed = yaml.load(filtersYaml);
		if (!parsed || typeof parsed !== "object") {
			throw new Error(`paths-filter step '${step.id}' parsed to no filters`);
		}
		invocations.push({
			id: step.id,
			uses: step.uses,
			// The action's own default when the input is absent.
			quantifier: step.with?.["predicate-quantifier"] ?? "some",
			filters: parsed,
		});
	}

	if (invocations.length === 0) {
		throw new Error("no paths-filter invocations found in the `changes` job");
	}

	// One flat name -> rule map. The split into two invocations exists because
	// the quantifiers differ, and each filter carries its own from here on.
	const table = {};
	for (const invocation of invocations) {
		for (const [name, patterns] of Object.entries(invocation.filters)) {
			// A filter item can also be a `added|modified:` status map, which changes
			// what a match means. None of ours is one, and a silent one would make
			// every expectation below a guess.
			if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string")) {
				throw new Error(`filter '${name}' is not a plain list of patterns`);
			}
			if (patterns.length === 0) {
				throw new Error(`filter '${name}' has no patterns`);
			}
			if (name in table) {
				throw new Error(`filter '${name}' is declared twice`);
			}
			table[name] = { quantifier: invocation.quantifier, patterns, uses: invocation.uses };
		}
	}
	return table;
}

// --- paths-filter's matching semantics ------------------------------------

// Transcribed from `createRuleItem` in dorny/paths-filter's src/filter.ts.
// picomatch inverts the result of a matcher built from a negated pattern, so
// inverting it back gives "the files this pattern excludes".
function compileRule(pattern) {
	const matcher = picomatch(pattern, MATCH_OPTIONS, true);
	const negated = matcher.state.negated;
	return {
		isMatch: (file) => matcher(file),
		isInclude: negated ? undefined : (file) => matcher(file),
		isExclude: negated ? (file) => !matcher(file) : undefined,
	};
}

// Transcribed from `Filter.isMatch`. Each pattern in the list is its own rule
// item, which is what makes `every` an intersection over patterns.
function fileMatches(rules, file, quantifier) {
	switch (quantifier) {
		case "every":
			return rules.every((rule) => rule.isMatch(file));
		case "some-with-excludes": {
			let included = false;
			for (const rule of rules) {
				// An exclusion is final - no later pattern can include the file back.
				if (rule.isExclude?.(file)) return false;
				if (!included && rule.isInclude?.(file)) included = true;
			}
			return included;
		}
		case "some":
			return rules.some((rule) => rule.isMatch(file));
		default:
			throw new Error(`unsupported predicate-quantifier '${quantifier}'`);
	}
}

/**
 * What the `changes` job would output for a changeset.
 *
 * A filter is true when *any* changed file satisfies it - the action reports
 * per filter, not per file, which is the whole of #913: the job conditions AND
 * two answers that different files may have given.
 */
function route(table, files) {
	const result = {};
	for (const [name, { quantifier, patterns }] of Object.entries(table)) {
		const rules = patterns.map(compileRule);
		result[name] = files.some((file) => fileMatches(rules, file, quantifier));
	}
	return result;
}

// --- the table ------------------------------------------------------------

// Every case names the *complete* set of areas it routes to, so an over-route
// reddens as loudly as a missing one. `code` is separate because it is not an
// area: it is the "is there anything here a build could care about" half that
// every job condition ANDs with its area.
const CASES = [
	{
		name: "an engine source routes to the engine matrix",
		files: ["engine/src/http/server.cpp"],
		code: true,
		areas: ["engine"],
	},
	{
		// What `dot: true` buys. Without it `engine/**` skips every dotfile and the
		// tidy config could change with no engine job running.
		name: "an engine dotfile routes to the engine matrix",
		files: ["engine/.clang-tidy"],
		code: true,
		areas: ["engine"],
	},
	{
		name: "an app source routes to the app matrix",
		files: ["app/src/renderer/App.tsx"],
		code: true,
		areas: ["app"],
	},
	{
		// shared/ is aliased to @shared by vitest and vite, so it is app code.
		name: "a shared asset routes to the app matrix",
		files: ["shared/icons/logo.svg"],
		code: true,
		areas: ["app"],
	},
	{
		name: "build.py routes to both matrices, its own suite and the script lint",
		files: ["build.py"],
		code: true,
		areas: ["app", "engine", "build_script", "scripts"],
	},
	{
		name: "VERSION routes to both matrices and nothing else",
		files: ["VERSION"],
		code: true,
		areas: ["app", "engine"],
	},
	{
		name: ".clang-format routes to the engine matrix alone",
		files: [".clang-format"],
		code: true,
		areas: ["engine"],
	},
	{
		// The #913 defect, in its single-file form.
		name: "documentation inside a code tree routes nowhere",
		files: ["engine/CLAUDE.md"],
		code: false,
		areas: [],
	},
	{
		// ...and the overshoot the #913 fix must not have: the tree still routes
		// when a real source changed beside the documentation.
		name: "documentation beside a source in the same tree still routes",
		files: ["engine/CLAUDE.md", "engine/src/http/server.cpp"],
		code: true,
		areas: ["engine"],
	},
	{
		// The exact changeset from #913: two files, two different halves of the
		// job condition. `code` is true (the script is not documentation) and the
		// engine must still be false.
		name: "documentation plus an unrelated script does not wake the engine matrix",
		files: ["engine/CLAUDE.md", "scripts/pre-commit"],
		code: true,
		areas: ["installer", "scripts"],
	},
	{
		// `*.md` and `**/*.md` are separate patterns because the first does not
		// match a nested file and the second does not match a root-level one.
		name: "a root-level markdown file routes nowhere and is not code",
		files: ["README.md"],
		code: false,
		areas: [],
	},
	{
		name: "a nested markdown file routes nowhere and is not code",
		files: ["docs/architecture.md"],
		code: false,
		areas: [],
	},
	{
		name: "the pre-commit hook routes to the installer job and the script lint",
		files: ["scripts/pre-commit"],
		code: true,
		areas: ["installer", "scripts"],
	},
	{
		name: "build.py's own suite routes to the build-script job and the script lint",
		files: ["scripts/test/vcpkg_baseline_test.py"],
		code: true,
		areas: ["build_script", "scripts"],
	},
	{
		// On purpose: a pull request editing the split sees every job it describes.
		name: "pr-tests.yml routes to every area",
		files: [".github/workflows/pr-tests.yml"],
		code: true,
		areas: ["app", "engine", "build_script", "installer", "scripts", "ci_routing"],
	},
	{
		// This suite's own routing. It is not a `.sh` or a `.py`, so the `scripts`
		// area cannot carry it and `ci_routing` has to.
		name: "this suite routes to the routing job alone",
		files: ["scripts/test/routing/paths_filter_test.mjs"],
		code: true,
		areas: ["ci_routing"],
	},
	{
		// `code` without an area is a pass, not a hole: repository metadata has its
		// own workflows and cannot alter a build artifact.
		name: "repository metadata is code but routes to no area",
		files: [".github/labeler.yml"],
		code: true,
		areas: [],
	},
	{
		name: "the docs-site machinery is not code",
		files: [".github/mkdocs.yml", "requirements-docs.txt"],
		code: false,
		areas: [],
	},
];

function areaNames(table) {
	return Object.keys(table).filter((name) => name !== "code");
}

function runCases(table) {
	const areas = areaNames(table);
	for (const testCase of CASES) {
		const routed = route(table, testCase.files);
		const actualAreas = areas.filter((name) => routed[name]);
		const expected = [...testCase.areas].sort().join(", ") || "(none)";
		const actual = [...actualAreas].sort().join(", ") || "(none)";
		check(
			testCase.name,
			routed.code === testCase.code && actual === expected,
			`${testCase.files.join(" + ")}: code=${routed.code} (expected ${testCase.code}), ` +
				`areas ${actual} (expected ${expected})`
		);
	}
}

// --- the suite's own completeness -----------------------------------------

function checkTableIsWhatWeThink(table) {
	check(
		"the workflow yielded a non-empty filter table",
		Object.keys(table).length > 0 && Object.values(table).every((f) => f.patterns.length > 0),
		"no filters were parsed - the suite would have proved nothing"
	);

	check(
		"the code filter uses `every` and the areas use `some-with-excludes`",
		table.code?.quantifier === "every" &&
			areaNames(table).every((name) => table[name].quantifier === "some-with-excludes"),
		`quantifiers: ${Object.entries(table)
			.map(([name, f]) => `${name}=${f.quantifier}`)
			.join(" ")}`
	);

	const uses = [...new Set(Object.values(table).map((f) => f.uses))];
	check(
		"the action is the version this suite mirrors",
		uses.length === 1 && uses[0] === EXPECTED_USES,
		`workflow uses ${uses.join(", ")}, this suite transcribes ${EXPECTED_USES} - ` +
			"re-read its filter.ts and package.json (picomatch major) before bumping this"
	);

	// An area nobody gates on is this repository's "written but never read"
	// defect in wiring form, and an area no case covers is this suite going
	// blind on the half of the table that grew after it was written.
	const workflow = fs.readFileSync(WORKFLOW, "utf8");
	const unread = areaNames(table).filter(
		(name) => !workflow.includes(`needs.changes.outputs.${name} ==`)
	);
	check(
		"every area filter gates at least one job",
		unread.length === 0,
		`no job condition reads: ${unread.join(", ")}`
	);

	const covered = new Set(CASES.flatMap((c) => c.areas));
	const uncovered = areaNames(table).filter((name) => !covered.has(name));
	check(
		"every area filter has a case that expects it",
		uncovered.length === 0,
		`no case routes to: ${uncovered.join(", ")} - add one rather than trusting the glob`
	);
}

// --- mutation checks ------------------------------------------------------

// The repository asks for behavioural tests to be mutation-checked: revert the
// fix, confirm the failure, restore. These run the revert every time rather
// than once in a pull request body, because a table-driven suite that has gone
// insensitive still prints a wall of `ok`.
function checkSensitivity(table) {
	const asShipped = route(table, ["engine/CLAUDE.md"]);
	const quantifierReverted = structuredClone(table);
	quantifierReverted.engine.quantifier = "some";
	const withRevert = route(quantifierReverted, ["engine/CLAUDE.md"]);
	check(
		"reverting #913's quantifier reddens the documentation case",
		asShipped.engine === false && withRevert.engine === true,
		`engine routed ${asShipped.engine} as shipped and ${withRevert.engine} under \`some\` - ` +
			"the case no longer detects the defect it was written for"
	);

	const engineSource = ["engine/src/http/server.cpp"];
	const narrowed = structuredClone(table);
	narrowed.engine.patterns = narrowed.engine.patterns.map((p) =>
		p === "engine/**" ? "engine/src/db/**" : p
	);
	check(
		"narrowing `engine/**` reddens the engine-source case",
		route(table, engineSource).engine === true &&
			route(narrowed, engineSource).engine === false &&
			narrowed.engine.patterns.includes("engine/src/db/**"),
		"the engine-source case survives a narrowed tree glob - it would not catch a rename"
	);

	// The reader must refuse an empty table rather than hand back one, since
	// every check above would then pass over nothing.
	let refused = false;
	try {
		readPathFilters("jobs:\n  changes:\n    steps:\n      - name: nothing\n");
	} catch {
		refused = true;
	}
	check(
		"a workflow with no paths-filter step is refused, not read as empty",
		refused,
		"readPathFilters returned a table for a workflow that has no filters"
	);
}

// --- main -----------------------------------------------------------------

function main() {
	console.log("pr-tests.yml path-filter routing table");
	console.log();

	let table;
	try {
		table = readPathFilters(fs.readFileSync(WORKFLOW, "utf8"));
	} catch (error) {
		console.log("  FAIL - the filters could not be read out of the workflow");
		console.log(`         ${error.message}`);
		return 1;
	}

	checkTableIsWhatWeThink(table);
	runCases(table);
	checkSensitivity(table);

	console.log();
	console.log(`  ${passed} passed, ${failed} failed`);
	if (passed === 0) {
		console.log("  no assertions ran - the suite proved nothing");
		return 1;
	}
	return failed ? 1 : 0;
}

process.exit(main());
