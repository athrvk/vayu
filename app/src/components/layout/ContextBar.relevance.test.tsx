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
 * What the bar does with a section that says it has nothing to say.
 *
 * The bar used to decide from the tab alone, so a plain REST request opened
 * seven sections of which three existed only to report that they did not apply.
 * A section now answers the data-level question itself through `useRelevance`
 * (#1310), and this file is about the *frame's* half of that: hidden draws
 * nothing, empty draws a header with no way in, content draws what it always
 * did.
 *
 * The registry is stubbed, as it is in `ContextBar.markup.test.tsx`, and for the
 * same reason: which real section reports what is that section's own test, and a
 * component spy makes "did not mount" the mechanism rather than a proxy for it.
 *
 * The relevance verdicts come from a mutable record the cases write before
 * rendering, so one stub section can be driven through all three states - which
 * is what makes the empty -> content case a mutation check rather than two
 * unrelated renders.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextBar } from "./ContextBar";
import { TooltipProvider } from "@/components/ui";
import { useLayoutStore, useTabsStore } from "@/stores";
import { CONTEXT_BAR_DEFAULT_COLLAPSED } from "@/constants/layout";
import type { SectionRelevance } from "./context-bar/types";

const quietBody = vi.fn(() => <p>quiet body</p>);
const plainBody = vi.fn(() => <p>plain body</p>);

/** The verdict `quiet`'s stub hook returns on the next render. */
let quietRelevance: SectionRelevance = "content";

vi.mock("./context-bar/registry", () => ({
	sectionsForTab: (tab: { type: string } | undefined) =>
		tab?.type === "request"
			? [
					{
						id: "quiet",
						title: "Quiet",
						appliesTo: () => true,
						useRelevance: () => quietRelevance,
						Component: quietBody,
					},
					// No `useRelevance`: content by definition, and the section that
					// keeps the bar non-empty however quiet its neighbour goes.
					{ id: "plain", title: "Plain", appliesTo: () => true, Component: plainBody },
				]
			: [],
}));

function renderBar() {
	return render(
		<TooltipProvider>
			<ContextBar />
		</TooltipProvider>
	);
}

beforeEach(() => {
	quietBody.mockClear();
	plainBody.mockClear();
	quietRelevance = "content";
	useLayoutStore.setState({
		contextBarOpen: true,
		contextBarWidth: 280,
		contextBarCollapsedSections: [],
	});
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "request", entityId: "req_1" }],
		activeTabId: "t1",
	});
});

describe("ContextBar - a section that reports it is not relevant", () => {
	it("draws nothing at all for `hidden`", () => {
		quietRelevance = "hidden";
		renderBar();

		// Not a dimmed header either: `hidden` is for a section that does not
		// apply to this request at all - GraphQL off a GraphQL body - where even
		// the title is a line about something the user is not doing.
		expect(screen.queryByText("Quiet")).not.toBeInTheDocument();
		expect(quietBody).not.toHaveBeenCalled();
		// Its neighbour is untouched: one section going quiet is not the bar
		// going away.
		expect(screen.getByText("plain body")).toBeInTheDocument();
	});

	it("draws a header and a note, and no body, for `empty`", () => {
		quietRelevance = { empty: "none" };
		renderBar();

		expect(screen.getByText("Quiet")).toBeInTheDocument();
		expect(screen.getByText("none")).toBeInTheDocument();
		expect(quietBody).not.toHaveBeenCalled();
		expect(screen.queryByText("quiet body")).not.toBeInTheDocument();
	});

	it("gives an `empty` section no way in", () => {
		quietRelevance = { empty: "none" };
		renderBar();

		// A trigger over an empty body is a control that lies about having
		// something behind it - and it would write a collapse entry for a section
		// the user cannot open.
		expect(screen.queryByRole("button", { name: "Quiet" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument();
	});

	it("mounts the section again once it has something to say", () => {
		quietRelevance = { empty: "not sent yet" };
		const { rerender } = renderBar();
		expect(quietBody).not.toHaveBeenCalled();

		// The mutation check: the same section, the same store, one verdict
		// changed - which is what a first send does to Recent sends.
		quietRelevance = "content";
		rerender(
			<TooltipProvider>
				<ContextBar />
			</TooltipProvider>
		);

		expect(quietBody).toHaveBeenCalled();
		expect(screen.getByText("quiet body")).toBeInTheDocument();
		expect(screen.queryByText("not sent yet")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Quiet" })).toBeInTheDocument();
	});

	it("draws a section with no relevance hook exactly as before", () => {
		quietRelevance = "hidden";
		renderBar();

		const trigger = screen.getByRole("button", { name: "Plain" });
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(plainBody).toHaveBeenCalled();
	});

	it("still honours the user's collapse state for a section with content", () => {
		// Relevance decides whether there is anything to expand; the user still
		// decides whether it is expanded. A `content` verdict must not reopen a
		// section they closed.
		useLayoutStore.setState({ contextBarCollapsedSections: ["quiet"] });
		renderBar();

		expect(screen.getByRole("button", { name: "Quiet" })).toHaveAttribute(
			"aria-expanded",
			"false"
		);
		expect(quietBody).not.toHaveBeenCalled();
	});
});

describe("ContextBar - the sections that ship collapsed", () => {
	it("does not mount a section named in the default collapsed list", () => {
		// Driven from the store's own initial state rather than a literal: this
		// is the assertion that the default reaches the bar at all, and it would
		// pass vacuously against a hand-written array.
		useLayoutStore.setState({
			contextBarCollapsedSections: [
				...useLayoutStore.getInitialState().contextBarCollapsedSections,
				"quiet",
			],
		});
		expect(CONTEXT_BAR_DEFAULT_COLLAPSED).toContain("code");

		renderBar();
		expect(quietBody).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Quiet" })).toHaveAttribute(
			"aria-expanded",
			"false"
		);
	});

	it("keeps an explicit expand, which is what makes it a default and not a policy", () => {
		// The user opened it; the store no longer names it. Nothing may put it
		// back - the default applies at first run and at the v4 migration, and
		// never again (`layout-store.test.ts` pins the migration half).
		useLayoutStore.getState().toggleContextBarSection("quiet");
		expect(useLayoutStore.getState().contextBarCollapsedSections).toEqual(["quiet"]);

		useLayoutStore.getState().toggleContextBarSection("quiet");
		expect(useLayoutStore.getState().contextBarCollapsedSections).toEqual([]);

		renderBar();
		expect(quietBody).toHaveBeenCalled();
	});
});
