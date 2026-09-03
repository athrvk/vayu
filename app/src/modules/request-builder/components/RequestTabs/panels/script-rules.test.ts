/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The rules the script panels used to state, where they live now.
 *
 * The panels carried nine paragraphs of `pm.*` rules under the pre-request
 * editor and four under the tests editor (#1223). Those facts are worth
 * pinning; pinning them as *panel prose* is what made the wall load-bearing -
 * the panel could not lose a sentence without a test noticing, so nobody could
 * remove the wall.
 *
 * Each fact now lives where the person writing the script already meets it:
 *
 *   - a rule about a member is in the engine's completion table, which reaches
 *     the editor twice - as a completion's documentation, and as the hover on
 *     the generated declarations. This suite reads the pinned generated
 *     declarations (`script-typedefs.d.ts`), because the documentation strings
 *     are copied into them verbatim, so a rule dropped from the table is a rule
 *     missing here;
 *   - a rule about a *hook* rather than a member - a pre-request script does not
 *     run under load; a test script under load sees sampled responses; the
 *     sandbox has no `URL` - is in the two published pages the panel's own
 *     "Scripting docs" link opens.
 *
 * Mutation check: delete any of these sentences from `scripting.cpp` (and
 * regenerate the fixture) or from the pages, and this suite reddens.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
	DOC_READING_GUARDS,
	ENGINE_READING_GUARDS,
	fromRepoRoot,
} from "@/lib/routed-inputs.testkit";

function read(path: string) {
	return readFileSync(fromRepoRoot(path), "utf-8");
}

const [typedefsPath] = ENGINE_READING_GUARDS.scriptRules.paths;
const typedefs = read(typedefsPath);
const pages = DOC_READING_GUARDS.scriptRules.paths.map(read).join("\n");

/**
 * A rule, and the phrase that carries it. The phrases are the engine's own
 * wording rather than a paraphrase: a paraphrase would pass while the text a
 * user actually reads said something else.
 */
const MEMBER_RULES: Array<[string, RegExp]> = [
	[
		"what a pre-request script holds is what is sent",
		/pm\.request holds when the script ends is what is sent/i,
	],
	["a script-set header beats the Auth tab", /overrides the one the Auth tab applied/i],
	["a refused value loses the whole edit", /rejects the whole edit/i],
	["a test script's writes to pm.request do nothing", /writing to it does nothing/i],
	["header indexing is case-sensitive", /Names are case-sensitive here/i],
	[
		"the header methods are not",
		/case-insensitively - unlike indexing, which is case-sensitive/i,
	],
	["add refuses a name already there", /Throws if one of that name already exists/i],
	["response headers are keyed lower-cased", /keyed by the lower-cased name/i],
	[
		"response header reads are case-insensitive",
		/Read a response header by name, case-insensitively/i,
	],
	[
		"the URL is an object that still reads as its string",
		/It still behaves as the string it used to be/i,
	],
	["sendRequest is synchronous", /the send blocks and the callback runs inline/i],
	["sendRequest is bounded", /at most 10 requests/i],
	["signing is synchronous and hex by default", /HMAC-SHA256, hex by default/i],
	["pm.info says which hook is running", /which hook it is running in/i],
];

const HOOK_RULES: Array<[string, RegExp]> = [
	[
		"a load test runs no pre-request script",
		/[Ll]oad tests? (do not|runs no) run?s? ?pre-request scripts?/,
	],
	["a test script under load grades sampled responses", /sampled response/],
	["the sandbox has no URL parser", /no `setTimeout`, `fetch`, `URL`/],
];

describe("the rules the script panels used to carry", () => {
	it.each(MEMBER_RULES)("states in the completion table: %s", (_rule, phrase) => {
		expect(typedefs).toMatch(phrase);
	});

	it.each(HOOK_RULES)("states in the scripting pages: %s", (_rule, phrase) => {
		expect(pages).toMatch(phrase);
	});

	/*
	 * The floor. Every assertion above is a substring search, and a search over
	 * an empty string fails loudly - but a search over the *wrong* file could
	 * pass on a coincidence, and a fixture that shrank to a stub would fail
	 * every case at once in a way that reads as "the rules are gone" rather than
	 * "the input is wrong".
	 */
	it("read the files it thinks it read", () => {
		expect(typedefs.length).toBeGreaterThan(10_000);
		expect(pages.length).toBeGreaterThan(10_000);
		expect(typedefs).toContain("declare const pm");
	});
});
