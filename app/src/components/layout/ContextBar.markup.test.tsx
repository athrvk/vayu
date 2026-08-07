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
 * What the context bar *is* on screen, as opposed to where its edits land
 * (`ContextBar.commit-scope.test.tsx`).
 *
 * Every case here pins a defect the bar shipped with: unnamed value inputs, a
 * scope visible only in a mouse-only `title`, a 14px close target, an anonymous
 * `<div>` where the facing Drawer is a labelled landmark, a doubled 1px left
 * edge, and a root that was simultaneously the scroll container and the resize
 * handle's positioning context - so scrolling the list carried the drag strip
 * and the header out of view.
 *
 * The structural cases assert `className`, not geometry: jsdom has no layout and
 * reports 0 for every measurement, so an `offsetHeight` or `scrollTop` guard
 * here would pass while measuring nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ContextBar } from "./ContextBar";
import { TooltipProvider } from "@/components/ui";
import { queryKeys } from "@/queries/keys";
import type { ResolvedVariable } from "@/types";

vi.mock("@/queries", () => ({
	useRequestQuery: () => ({ data: { id: "req_1", collectionId: "col_1" } }),
	useUpdateGlobalsMutation: () => ({ mutate: vi.fn() }),
	useUpdateEnvironmentMutation: () => ({ mutate: vi.fn() }),
	useUpdateCollectionMutation: () => ({ mutate: vi.fn() }),
}));

let resolved: Record<string, ResolvedVariable> = {};

vi.mock("@/hooks/useVariableResolver", () => ({
	useVariableResolver: () => ({ getAllVariables: () => resolved }),
}));

const layoutStore = {
	contextBarOpen: true,
	setContextBarOpen: vi.fn(),
	contextBarWidth: 280,
	setContextBarWidth: vi.fn(),
};
const tabsStore = {
	openTabs: [{ id: "t1", type: "request", entityId: "req_1" }],
	activeTabId: "t1",
};

vi.mock("@/stores", async () => {
	const saveStore =
		await vi.importActual<typeof import("@/stores/save-store")>("@/stores/save-store");
	return {
		useLayoutStore: () => layoutStore,
		useTabsStore: () => tabsStore,
		useSaveStore: saveStore.useSaveStore,
	};
});

function renderBar(mode?: "push" | "overlay") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(queryKeys.globals.all, { id: "globals", updatedAt: "", variables: {} });
	client.setQueryData(queryKeys.environments.list(), []);
	client.setQueryData(queryKeys.collections.list(), []);
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ContextBar mode={mode} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}

/** The bar's root - the landmark, and the element the mode classes land on. */
function bar(): HTMLElement {
	return screen.getByRole("complementary", { name: "Context sidebar" });
}

beforeEach(() => {
	resolved = {};
});

describe("ContextBar - naming what a screen reader reads", () => {
	it("names the editable value input after the variable it edits", () => {
		resolved = { host: { value: "example.com", scope: "global" } };
		renderBar();

		// Was an unnamed textbox: "textbox, blank", with a blur that silently
		// persisted the edit.
		expect(screen.getByRole("textbox", { name: "Value of host" })).toHaveValue("example.com");
	});

	it("names the masked input of a secret the same way", () => {
		resolved = { apiKey: { value: "s3cret", scope: "collection", secret: true } };
		renderBar();

		const input = screen.getByRole("textbox", { name: "Value of apiKey" });
		expect(input).toHaveAttribute("readonly");
		expect(input).toHaveValue("••••••");
		expect(screen.queryByDisplayValue("s3cret")).not.toBeInTheDocument();
	});

	it("is a labelled landmark, like the Drawer facing it", () => {
		renderBar();
		// An anonymous <div> could not be jumped to; the left panel could.
		// `getByRole("complementary", { name })` is the assertion - it resolves
		// only if both the landmark and its label are there.
		expect(bar().tagName).toBe("ASIDE");
	});

	it("gives the close button the documented icon-button box", () => {
		renderBar();
		const close = screen.getByRole("button", { name: "Close context bar" });
		// The hit area used to be the 14px icon itself - the smallest target in
		// the shell.
		expect(close.className).toContain("h-6");
		expect(close.className).toContain("w-6");
	});
});

describe("ContextBar - the scope is visible, not hover-only", () => {
	it("badges each row with the scope the winner came from", () => {
		resolved = {
			host: { value: "example.com", scope: "global" },
			base: { value: "/v1", scope: "collection", sourceId: "col_1" },
			token: { value: "t", scope: "environment", sourceId: "env_1" },
		};
		renderBar();

		// The compact letters `VariableScopeBadge` renders - the primitive the
		// variable popover already uses, rather than a hand-rolled copy.
		expect(screen.getByText("G")).toBeInTheDocument();
		expect(screen.getByText("C")).toBeInTheDocument();
		expect(screen.getByText("E")).toBeInTheDocument();
	});

	it("does not hand-write an unconditional title on the name", () => {
		resolved = { host: { value: "example.com", scope: "global" } };
		renderBar();

		// `TruncatedText` supplies the title only while the text is clipped -
		// jsdom never clips, so a title here means the old `truncate` + literal
		// `title` pattern came back.
		const name = screen.getByText("host");
		expect(name.className).toContain("truncate");
		expect(name).not.toHaveAttribute("title");
	});
});

describe("ContextBar - the frame stays put while the list scrolls", () => {
	it("puts the overflow on an inner wrapper, not on the root", () => {
		resolved = { host: { value: "example.com", scope: "global" } };
		renderBar();

		const root = bar();
		// With the overflow on the root, the root was both the scroll container
		// and the handle's positioning context: scrolling carried the drag strip,
		// the header and the close button away and left the lower edge
		// un-draggable.
		expect(root.className).not.toContain("overflow-y-auto");

		const scroller = root.querySelector(".overflow-y-auto");
		expect(scroller).not.toBeNull();
		// The two things that must survive a scroll are outside it.
		expect(scroller!.contains(screen.getByRole("separator"))).toBe(false);
		expect(scroller!.contains(screen.getByRole("button", { name: "Close context bar" }))).toBe(
			false
		);
		// …and the variables list is inside it.
		expect(scroller!.contains(screen.getByRole("textbox", { name: "Value of host" }))).toBe(
			true
		);
	});

	it("paints one left edge, not two", () => {
		renderBar();
		// The root's `border-l` sat on top of the handle's own 1px hairline; the
		// Drawer's identical handle-drawn edge is 1px.
		expect(bar().className).not.toContain("border-l");
	});
});

describe("ContextBar - push and overlay modes", () => {
	it("floats over the content in overlay mode", () => {
		renderBar("overlay");
		const className = bar().className;
		expect(className).toContain("absolute");
		expect(className).toContain("shadow-lg");
	});

	it("takes layout space in push mode", () => {
		renderBar("push");
		const className = bar().className;
		expect(className).toContain("relative");
		expect(className).not.toContain("absolute");
		expect(className).not.toContain("shadow-lg");
	});
});
