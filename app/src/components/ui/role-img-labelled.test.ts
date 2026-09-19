/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * `role="img"` is a promise that the element has something to say (#1691).
 *
 * The audit behind this guard looked at both sites the app ships and found them
 * correct, which is the outcome worth writing down as a test rather than as a
 * sentence in a PR:
 *
 *   - `ui/tabs.tsx`'s `TabErrorDot` - a 5px dot beside a tab label that says
 *     "Console", never "error". Nothing adjacent carries the meaning, so the
 *     dot names itself ("Script error") and the role is what makes that name
 *     reach a screen reader at all.
 *   - `history/sidebar/RunItem.tsx`'s warning triangle (#1527) - same shape: no
 *     adjacent text says a run finished with warnings.
 *
 * The two failure modes are opposite and both silent. A decorative glyph given
 * `role="img"` and no label announces as an unlabelled image - noise with no
 * content. A labelled one sitting beside text that already says the same thing
 * announces twice. `jsx-a11y` catches neither: the first because it cannot tell
 * decorative from meaningful, the second because it cannot read the siblings.
 *
 * So the rule this can mechanise is the first one, and it is absolute: every
 * `role="img"` in shipped source carries an `aria-label` on the same element. A
 * glyph with nothing to say drops the role and takes `aria-hidden` instead -
 * which is what the run row's status glyph does, one element away from here.
 */

import { describe, it, expect } from "vitest";

const sources: Record<string, string> = import.meta.glob("/src/**/*.tsx", {
	query: "?raw",
	import: "default",
	eager: true,
});

/**
 * The JSX element opening tag that carries `role="img"`, from its `<` to the
 * `>` that closes it. Multi-line: these are always attribute-per-line elements.
 */
const ELEMENT = /<[A-Za-z][^<>]*?role="img"[^<>]*?>/gs;

function elementsWithRoleImg(): { path: string; element: string }[] {
	const found: { path: string; element: string }[] = [];
	for (const [path, src] of Object.entries(sources)) {
		if (path.includes(".test.")) continue;
		for (const match of src.matchAll(ELEMENT)) {
			found.push({ path, element: match[0] });
		}
	}
	return found;
}

describe('every role="img" names itself', () => {
	it("scans something - the glob and the pattern both still match", () => {
		// Without this the suite below passes forever on an empty list, which is
		// the way a source scan dies quietly: a moved directory, a renamed
		// extension, an attribute written `role={"img"}`.
		expect(Object.keys(sources).length).toBeGreaterThan(100);
		expect(elementsWithRoleImg().length).toBeGreaterThanOrEqual(2);
	});

	it("carries an aria-label on the same element", () => {
		const unlabelled = elementsWithRoleImg()
			.filter(({ element }) => !/aria-label[=\s]/.test(element))
			.map(({ path, element }) => `${path}: ${element.replace(/\s+/g, " ").slice(0, 96)}`);

		expect(unlabelled).toEqual([]);
	});
});
