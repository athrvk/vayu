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
 * The welcome screen reads in a centred column (#1691).
 *
 * It filled the tab: at 1440px the tiles and the recent runs hugged the left
 * edge with the right two-thirds empty, so the eye crossed a monitor between a
 * tile and the run list beneath it.
 *
 * jsdom has no layout, so the class is the assertion - and all three states the
 * screen can be in are asserted together, because a skeleton in a different
 * column from the content it stands in for shifts the page the moment the
 * queries land, which is the one thing a skeleton exists to prevent.
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Launcher } from "./Launcher";
import { FirstRunWelcome } from "./FirstRunWelcome";
import { LauncherSkeleton } from "./LauncherSkeleton";

const noop = () => {};

function classesOf(ui: React.ReactElement): string {
	const { container, unmount } = render(ui);
	const className = container.firstElementChild!.className;
	unmount();
	return className;
}

describe("the welcome screen's column", () => {
	it("is centred and capped, in every state the screen can be in", () => {
		const roots = [
			classesOf(
				<Launcher
					runs={[]}
					collectionCount={2}
					onImport={noop}
					onNewRequest={noop}
					onOpenDemo={noop}
					onSearch={noop}
					onHistory={noop}
					onVariables={noop}
					onServices={noop}
				/>
			),
			classesOf(<FirstRunWelcome onImport={noop} onNewRequest={noop} onOpenDemo={noop} />),
			classesOf(<LauncherSkeleton />),
		];

		// The classes are spelled out rather than read from `WELCOME_COLUMN`:
		// asserting a constant against itself would pass on any value, including
		// the left-anchored one this replaced.
		expect(roots).toHaveLength(3);
		for (const className of roots) {
			expect(className).toContain("mx-auto");
			expect(className).toContain("w-full");
			expect(className).toContain("max-w-2xl");
		}
	});

	// `LauncherSkeleton` is the one welcome state with no content of its own to
	// fade - it *is* the placeholder - so only the two real states carry the
	// class. Without it, the swap from skeleton to `Launcher` or
	// `FirstRunWelcome` popped in a frame after the skeleton's own bars, while
	// the sibling `isEmpty && hasFailed` branch (`ErrorState`) already faded,
	// since that primitive carries `enter-fade` itself.
	it("fades in Launcher and FirstRunWelcome, the two states that replace the skeleton", () => {
		const launcherClass = classesOf(
			<Launcher
				runs={[]}
				collectionCount={2}
				onImport={noop}
				onNewRequest={noop}
				onOpenDemo={noop}
				onSearch={noop}
				onHistory={noop}
				onVariables={noop}
				onServices={noop}
			/>
		);
		const firstRunClass = classesOf(
			<FirstRunWelcome onImport={noop} onNewRequest={noop} onOpenDemo={noop} />
		);

		expect(launcherClass).toContain("enter-fade");
		expect(firstRunClass).toContain("enter-fade");
	});
});
