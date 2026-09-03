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
 * A section may arrive after the bar does (#1146).
 *
 * The GraphQL section is `React.lazy` in the registry, because it is the one
 * entry that reaches the `graphql` package and the bar is mounted on every tab.
 * Two properties make that safe, and neither is visible in the registry:
 *
 * 1. The bar has a Suspense boundary at all. Without one the nearest boundary
 *    is outside the bar - `Shell`'s tab panel does not contain it - so a
 *    suspending section takes the window down rather than showing a placeholder.
 * 2. The boundary is *per section*. One around the list would blank every
 *    section beside the one that is still loading, which is a worse bar than
 *    the eager import it replaced.
 *
 * **Each case builds its own lazy component.** `React.lazy` remembers that it
 * resolved, so a shared one suspends in the first case and in none of the
 * others - which quietly turns every later assertion into a statement about an
 * already-loaded section. That is not a detail of this file: it is why the
 * per-section case can prove anything at all.
 *
 * The registry is stubbed here, as in `ContextBar.markup.test.tsx`: this is
 * about the frame's handling of a lazy entry, not about which sections exist.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { lazy, type ComponentType } from "react";
import { render, screen, act } from "@testing-library/react";
import { ContextBar } from "./ContextBar";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore, useTabsStore } from "@/stores";

interface StubSection {
	id: string;
	title: string;
	appliesTo: () => boolean;
	Component: ComponentType<{ tab: unknown }>;
}

/** Set per case, so each one gets a lazy component that has not resolved yet. */
let sections: StubSection[] = [];

vi.mock("./context-bar/registry", () => ({
	sectionsForTab: (tab: { type: string } | undefined) =>
		tab?.type === "request" ? sections : [],
}));

/** A section whose code has not arrived, and a plain one to sit beside it. */
function stubSections(): StubSection[] {
	return [
		{
			id: "eager",
			title: "Eager",
			appliesTo: () => true,
			Component: () => <p>eager body</p>,
		},
		{
			id: "lazy",
			title: "Lazy",
			appliesTo: () => true,
			Component: lazy(() => Promise.resolve({ default: () => <p>lazy body</p> })),
		},
	];
}

beforeEach(() => {
	sections = stubSections();
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
		activeTabId: "t1",
	});
	useLayoutStore.setState({ contextBarOpen: true, contextBarCollapsedSections: [] });
});

function renderBar() {
	return render(
		<TooltipProvider>
			<ContextBar />
		</TooltipProvider>
	);
}

describe("a lazy section", () => {
	it("shows the section's own loading line while its code is still arriving", async () => {
		renderBar();

		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.queryByText("lazy body")).toBeNull();

		// Flushed so the load lands inside `act`, not during teardown.
		await act(async () => {});
	});

	it("does not blank the sections beside it - the boundary is per section", async () => {
		renderBar();

		// The mutation check: move the Suspense boundary from around each
		// section to around the list, and this goes red - the bar renders one
		// "Loading…" and nothing else until the chunk lands.
		expect(screen.getByText("eager body")).toBeInTheDocument();
		expect(screen.getByText("Loading…")).toBeInTheDocument();

		await act(async () => {});
	});

	it("renders once its code arrives", async () => {
		renderBar();

		await act(async () => {});

		expect(screen.getByText("lazy body")).toBeInTheDocument();
		expect(screen.queryByText("Loading…")).toBeNull();
		expect(screen.getByText("eager body")).toBeInTheDocument();
	});
});
