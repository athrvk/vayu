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
 * The description is the first request tab, and first is the whole point.
 *
 * It used to be `RequestDescription`, a full-width band between the URL bar and
 * the tab strip - drawn on every request whether or not a description existed,
 * so every request paid ~30px permanently for a button reading "Add
 * description…".
 *
 * Moving it into the tab row costs nothing when unused. Moving it to the *head*
 * of the row is what makes it useful: as a trailing tab it is a footnote you
 * scroll past, and at the front it is first in reading order, which is what a
 * description is for. Nothing but position expresses that, so nothing but a
 * test protects it.
 *
 * "Info" rather than "Docs" to match `CollectionDetail`'s first tab - the two
 * detail surfaces should not name the same idea differently.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import RequestTabs from "./index";

// The panels pull in Monaco, the variable inputs and the auth editors; none of
// that is what this guards.
/**
 * The snippets list under a script editor reads the engine's completion table
 * (#1223). Its own behaviour is `ScriptSnippets.test.tsx`; here it only needs
 * to not reach for a QueryClient this suite does not set up.
 */
vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("./panels/InfoPanel", () => ({ default: () => <div>info panel</div> }));
vi.mock("./panels/ParamsPanel", () => ({ default: () => null }));
vi.mock("./panels/HeadersPanel", () => ({ default: () => null }));
vi.mock("./panels/BodyPanel", () => ({ default: () => null }));
vi.mock("./panels/AuthPanel", () => ({ default: () => null }));
vi.mock("./panels/script/ScriptPanel", () => ({ default: () => null }));
vi.mock("./panels/SettingsPanel", () => ({ default: () => null }));

function renderTabs(description?: string) {
	const value = {
		request: { ...createDefaultRequestState(), description },
		activeTab: "info",
		setActiveTab: vi.fn(),
	} as unknown as RequestBuilderContextValue;

	return render(
		<RequestBuilderContext.Provider value={value}>
			<RequestTabs />
		</RequestBuilderContext.Provider>
	);
}

/*
 * The visible label only. `TabLabel` renders a hidden bold twin to reserve the
 * active state's width, so a tab's raw `textContent` reads "InfoInfo" - which
 * is what the first version of this file asserted against and got wrong.
 */
const labelOf = (tab: HTMLElement) =>
	tab.querySelector('[data-slot="tab-label-reserve"]')?.nextElementSibling?.textContent ?? "";

const tabNames = () => screen.getAllByRole("tab").map(labelOf);

/** The count superscript, which is a sibling of the label, not part of it. */
const countOf = (tab: HTMLElement) => tab.querySelector("sup")?.textContent ?? null;

describe("the Info tab", () => {
	it("is the first tab in the row", () => {
		renderTabs();
		expect(tabNames()[0]).toMatch(/^Info/);
	});

	it("sits ahead of Params, which used to be first", () => {
		renderTabs();
		const names = tabNames();
		expect(names.findIndex((n) => n.startsWith("Info"))).toBeLessThan(
			names.findIndex((n) => n.startsWith("Params"))
		);
	});

	it('is called "Info", matching the collection detail screen', () => {
		renderTabs();
		expect(screen.getByRole("tab", { name: /^Info/ })).toBeInTheDocument();
		expect(screen.queryByRole("tab", { name: /Docs/ })).not.toBeInTheDocument();
	});

	it("badges presence, not a count, like Body and Auth do", () => {
		renderTabs("Returns settled payouts.");
		expect(countOf(screen.getAllByRole("tab")[0])).toBe("1");
	});

	it("stays quiet when there is no description", () => {
		renderTabs();
		expect(countOf(screen.getAllByRole("tab")[0])).toBeNull();
	});

	it("treats a whitespace-only description as none", () => {
		renderTabs("   \n  ");
		expect(countOf(screen.getAllByRole("tab")[0])).toBeNull();
	});
});
