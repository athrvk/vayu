/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * The label registries render in several places each (pickers, run headers,
 * toasts), so a Title Case word here shows up on every screen at once (#2296).
 * `voice-casing.test.ts` scans the whole tree for the same rule; this file is the
 * registry-level proof that the labels themselves, as data, read in sentence
 * case, with the predicate's two directions pinned below.
 */

import { describe, it, expect } from "vitest";
import { AUTH_MODE_LABELS } from "@/constants/auth-modes";
import { LOAD_TEST_MODES } from "@/constants/load-test-modes";
import { OAUTH2_FIELD_LABELS } from "@/constants/oauth2-fields";

/** Names that keep their capitals mid-label. */
const CAPITALISED_NAMES = new Set([
	"OAuth",
	"Akamai",
	"EdgeGrid",
	"Postman",
	"Insomnia",
	"OpenAPI",
]);

/** `API`, `RPS`, `PKCE`, `IDs`: capitals by spelling. */
const isAcronym = (word: string) => /^[A-Z][A-Z\d]+s?$/.test(word);

/**
 * Words after the first, with hyphenated parts counted as words, so "Ramp-Up"
 * is caught. Punctuation around a word is not part of it: "(PKCE)" is "PKCE".
 */
export function titleCasedWords(label: string): string[] {
	return label
		.split(/[\s-]+/)
		.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.slice(1)
		.filter((word) => /^\p{Lu}/u.test(word))
		.filter((word) => !isAcronym(word) && !CAPITALISED_NAMES.has(word));
}

const REGISTRIES: Record<string, readonly string[]> = {
	AUTH_MODE_LABELS: Object.values(AUTH_MODE_LABELS),
	LOAD_TEST_MODES: LOAD_TEST_MODES.map((mode) => mode.label),
	OAUTH2_FIELD_LABELS: Object.values(OAUTH2_FIELD_LABELS),
};

describe("sentence-case label registries", () => {
	it.each(Object.entries(REGISTRIES))("%s yields labels to check", (_name, labels) => {
		expect(labels.length).toBeGreaterThan(0);
	});

	it.each(Object.entries(REGISTRIES))("%s holds no Title Case word", (_name, labels) => {
		const offenders = labels
			.map((label) => ({ label, words: titleCasedWords(label) }))
			.filter(({ words }) => words.length > 0)
			.map(({ label, words }) => `${JSON.stringify(label)} (${words.join(", ")})`);

		expect(offenders).toEqual([]);
	});
});

describe("the sentence-case predicate", () => {
	it("names the capitalised word after the first, a hyphenated one too", () => {
		expect(titleCasedWords("Bearer Token")).toEqual(["Token"]);
		expect(titleCasedWords("Ramp-Up")).toEqual(["Up"]);
		expect(titleCasedWords("Inherit from Collection")).toEqual(["Collection"]);
	});

	it("passes acronyms, the allowlisted names and a capitalised first word", () => {
		expect(titleCasedWords("Authorization code (PKCE)")).toEqual([]);
		expect(titleCasedWords("Constant RPS")).toEqual([]);
		expect(titleCasedWords("JWT bearer")).toEqual([]);
		expect(titleCasedWords("Akamai EdgeGrid")).toEqual([]);
		expect(titleCasedWords("OAuth 2.0")).toEqual([]);
	});
});
