/**
 * @vitest-environment jsdom
 */
/**
 * Copyright (c) 2026 Atharva Kusumbia
 *
 * This source code is licensed under the Apache 2.0 license found in the
 * LICENSE file in the "app" directory of this source tree.
 */

/**
 * A step's unresolved variables (issue #3269), worded by what the count counts:
 * distinct names for a collection run, sends for a load run.
 *
 * Mutation-check: swap the two wordings in `UnresolvedTokens.tsx` and the
 * "names" and "sends" cases fail; drop its `count > 0` guard and the last fails.
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UnresolvedTokens } from "./UnresolvedTokens";

afterEach(cleanup);

describe("UnresolvedTokens", () => {
	it.each([
		[1, "1 unresolved variable"],
		[2, "2 unresolved variables"],
		[1234, "1,234 unresolved variables"],
	])("counts %i distinct names as %j", (count, text) => {
		render(<UnresolvedTokens count={count} unit="names" />);

		expect(screen.getByText(text)).toBeTruthy();
	});

	it.each([
		[1, "1 send with unresolved variables"],
		[2, "2 sends with unresolved variables"],
		[1234, "1,234 sends with unresolved variables"],
	])("counts %i sends as %j", (count, text) => {
		render(<UnresolvedTokens count={count} unit="sends" />);

		expect(screen.getByText(text)).toBeTruthy();
	});

	it.each([
		["absent", undefined],
		["zero", 0],
		["negative", -1],
		["not a number", Number.NaN],
		["a string off a malformed report", "3" as unknown as number],
	])("renders nothing for a count that is %s", (_label, count) => {
		const { container } = render(<UnresolvedTokens count={count} unit="names" />);

		expect(container.firstChild).toBeNull();
	});
});
