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
 * The chrome `AuthInheritBanner` and `InheritedScriptsNotice` had written out
 * twice, identically, and now share.
 *
 * Both said "something up the collection chain applies here, and here is the
 * chain": the tinted box, the summary row with its bottom rule, the captioned
 * body, and rows separated by a hairline with the last one bare. Nine class
 * strings each, matching character for character - so a change to the treatment
 * landed in one and not the other, which is the failure this removes.
 *
 * The separator rule is the only logic in it, and it is the kind that is
 * invisible when wrong: a trailing hairline under the last row makes the list
 * look truncated rather than finished, and nobody files that.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ChainCard from "./ChainCard";

function renderCard(count: number) {
	return render(
		<ChainCard caption="Resolution chain" summary={<p>Inheriting Bearer from Root.</p>}>
			{Array.from({ length: count }, (_, i) => (
				<span key={i}>row-{i}</span>
			))}
		</ChainCard>
	);
}

/** The row wrappers the card draws around each child. */
function rows(container: HTMLElement) {
	return Array.from(container.querySelectorAll<HTMLElement>(".py-1"));
}

describe("what the card shows", () => {
	it("renders the summary and the caption", () => {
		const { container } = renderCard(2);
		expect(container.textContent).toContain("Inheriting Bearer from Root.");
		expect(container.textContent).toContain("Resolution chain");
	});

	it("renders one row per child, in order", () => {
		const { container } = renderCard(3);
		const text = rows(container).map((r) => r.textContent);
		expect(text).toEqual(["row-0", "row-1", "row-2"]);
	});
});

describe("the separators", () => {
	it("puts a hairline between rows but not after the last", () => {
		const { container } = renderCard(3);
		const separated = rows(container).map((r) => r.className.includes("border-b"));
		expect(separated).toEqual([true, true, false]);
	});

	it("draws none at all for a single row", () => {
		// The only row is also the last one, so an off-by-one here shows a rule
		// under a one-item list - the shape that reads as "cut off".
		const { container } = renderCard(1);
		expect(rows(container)).toHaveLength(1);
		expect(rows(container)[0].className).not.toContain("border-b");
	});
});

describe("the tint", () => {
	it("keeps the accent on --primary, which is a text and tint token", () => {
		// Not `--primary-fill`: that is the solid button background and is one
		// value in both themes. A tint has to track the accent as it brightens.
		const { container } = renderCard(2);
		const card = container.firstElementChild as HTMLElement;
		expect(card.className).toContain("bg-primary/10");
		expect(card.className).toContain("border-primary/30");
		expect(card.className).not.toContain("primary-fill");
	});

	it("carries a radius, so it is not pinned square for a Rounded user", () => {
		// No radius class at all is the quiet version of a bare `rounded`, and a
		// source scan cannot tell it from a surface that is square on purpose.
		const { container } = renderCard(2);
		expect((container.firstElementChild as HTMLElement).className).toMatch(/\brounded-md\b/);
	});
});
