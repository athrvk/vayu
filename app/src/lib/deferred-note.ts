/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

import { VARIABLE_PATTERN } from "@/constants/variables";
import { pickByCount } from "@/modules/dashboard/utils/format";

/**
 * Names the tokens left written because a pre-request script runs before the
 * send (#2521), so a `{{token}}` reads as deliberate rather than as a variable
 * that failed to resolve. The Code section's note, the "Sends" line's hint and a
 * deferred token's hover are this one sentence.
 *
 * Its own module, apart from `code-composition.ts`, because the token painters
 * under `components/shared/` say it too and must not load a query to do so.
 */
export function deferredNote(names: readonly string[]): string {
	const tokens = deferredTokens(names);
	return pickByCount(names.length, {
		one: `${tokens} is set by a pre-request script at send.`,
		other: `${tokens} are set by a pre-request script at send.`,
	});
}

/** @p names written as the `{{name}}` tokens a note names. */
export function deferredTokens(names: readonly string[]): string {
	return names.map((name) => `{{${name}}}`).join(", ");
}

/** The name inside a `{{name}}` token, trimmed the way the resolvers read it. */
export function tokenName(token: string): string {
	return token.slice(2, -2).trim();
}

/**
 * The names in @p deferred that @p texts use, in order of first appearance. The
 * engine lists every name a scope answers for the whole request, not the ones a
 * given field holds.
 */
export function deferredNamesIn(deferred: readonly string[], texts: readonly string[]): string[] {
	if (deferred.length === 0) return [];
	const answered = new Set(deferred);
	const used = new Set<string>();
	for (const text of texts) {
		for (const [token] of text.matchAll(VARIABLE_PATTERN)) {
			const name = tokenName(token);
			if (answered.has(name)) used.add(name);
		}
	}
	return [...used];
}
