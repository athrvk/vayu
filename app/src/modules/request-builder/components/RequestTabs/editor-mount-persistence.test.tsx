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
 * Body and Elements keep their editor mounted once visited (issue #1718).
 *
 * Radix's `TabsContent` unmounts an inactive panel by default, so stepping
 * from Body to Headers and back used to tear the Monaco instance down and
 * build a fresh one: the text survived (it is read back from the request
 * store), but the cursor position, scroll position and undo/redo stack did
 * not. `RequestTabs` now force-mounts Body's and Elements' panels once the
 * user has looked at either, which is the memory trade recorded in
 * `docs/app/COMPONENTS.md`: a request opened on Params never mounts either
 * panel, and once mounted they stay alive - hidden, not destroyed - for the
 * rest of this builder instance rather than being rebuilt on every glance
 * elsewhere.
 *
 * `BodyPanel` and `ElementsPanel` are stubbed to a component that renders a
 * stable marker and counts its own mounts - a real `BodyPanel` needs the full
 * request-builder context and Monaco, neither of which this file is about;
 * what is asserted here is `RequestTabs`' own force-mount wiring; the panels'
 * own behaviour is `BodyPanel.test.tsx` and `ElementsPanel.test.tsx`.
 *
 * Mutation check: delete the `visited.has(tab.id)` half of the `forceMount`
 * condition in `index.tsx` (or the whole `forceMount` prop) and "stays
 * mounted, hidden, once visited" fails - the panel unmounts (its mount count
 * increments again and the marker leaves the DOM) the moment the user steps
 * away. Delete `EDITOR_TABS.has(tab.id) && ` instead - so every tab
 * force-mounts once visited - and "is not in the DOM before its first visit"
 * fails for Params, whose panel would then mount on the very first render.
 */

import { describe, it, expect, vi } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue, RequestTab } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import RequestTabs from "./index";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
	useElementKindsQuery: () => ({ data: [] }),
}));

vi.mock("./panels/InfoPanel", () => ({ default: () => null }));
vi.mock("./panels/ParamsPanel", () => ({ default: () => <div data-testid="params-panel" /> }));
vi.mock("./panels/HeadersPanel", () => ({ default: () => <div data-testid="headers-panel" /> }));
vi.mock("./panels/AuthPanel", () => ({ default: () => null }));
vi.mock("./panels/ExamplesPanel", () => ({ default: () => null }));
vi.mock("./panels/SettingsPanel", () => ({ default: () => null }));

/** How many times each stubbed editor panel has been constructed. */
const mounts = { body: 0, elements: 0 };

/*
 * `useEffect` with an empty dependency array, not a counter incremented in the
 * component body: the body runs on every re-render (a click on any trigger
 * re-renders `RequestTabs` and everything still present under it, force-mounted
 * or not), while the effect fires once per genuine mount - which is the
 * distinction "stays mounted" is about. A real Monaco editor pays the same
 * way: it is created in `onMount`/an effect, not on every render.
 */
vi.mock("./panels/BodyPanel", () => ({
	default: function StubBodyPanel() {
		useEffect(() => {
			mounts.body += 1;
		}, []);
		return <div data-testid="body-panel">body editor</div>;
	},
}));
vi.mock("./panels/ElementsPanel", () => ({
	default: function StubElementsPanel() {
		useEffect(() => {
			mounts.elements += 1;
		}, []);
		return <div data-testid="elements-panel">elements editor</div>;
	},
}));

/** A minimal but real `activeTab`/`setActiveTab` pair, like the tab strip has. */
function renderTabs(initialTab: RequestTab) {
	function Harness() {
		const [activeTab, setActiveTab] = useState<RequestTab>(initialTab);
		const value = {
			request: createDefaultRequestState(),
			activeTab,
			setActiveTab,
		} as unknown as RequestBuilderContextValue;
		return (
			<RequestBuilderContext.Provider value={value}>
				<RequestTabs />
			</RequestBuilderContext.Provider>
		);
	}
	return render(<Harness />);
}

/**
 * Radix activates a trigger on `mousedown`, not on `click` - `fireEvent.click`
 * fires neither the mousedown nor the focus it listens for, so a click-driven
 * version of this switch never actually changes the active tab (the same trap
 * `CollectionDetail/draft-survival.test.tsx` documents).
 */
const clickTab = (name: RegExp) => {
	fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
	expect(screen.getByRole("tab", { name })).toHaveAttribute("data-state", "active");
};

/**
 * The wrapping `TabsContent` a testid-only query cannot see through. jsdom
 * applies no Tailwind, so `data-[state=inactive]:hidden` in its class list -
 * rather than a computed style - is what stands in for "actually hidden",
 * exactly as `components/ui/tabs.test.tsx` checks it for the primitive
 * itself. Radix's own `hidden` attribute is not it: `forceMount` makes
 * `present` unconditionally true, so the attribute (`!present`) never appears
 * on a force-mounted panel - see the file comment in `tabs.tsx`.
 */
const panelWrapper = (testId: string) => screen.getByTestId(testId).closest('[role="tabpanel"]');

/** Reset the shared mount counters; called first in every test below. */
function resetMounts() {
	mounts.body = 0;
	mounts.elements = 0;
}

describe("a request nobody has taken to Body or Elements", () => {
	it("never mounts either editor panel", () => {
		resetMounts();
		renderTabs("params");

		expect(screen.queryByTestId("body-panel")).toBeNull();
		expect(screen.queryByTestId("elements-panel")).toBeNull();
		expect(mounts.body).toBe(0);
		expect(mounts.elements).toBe(0);
	});
});

describe("the Body panel, once visited", () => {
	it("stays mounted and hidden rather than unmounting when the user leaves", () => {
		resetMounts();
		renderTabs("body");
		expect(mounts.body).toBe(1);

		clickTab(/headers/i);

		// Still in the DOM - not unmounted - and marked to be hidden from the
		// accessibility tree and the tab order the way `components/ui/tabs.tsx`
		// hides every force-mounted inactive panel (`data-[state=inactive]:hidden`,
		// a Tailwind `display:none`, which pulls the panel and everything in it
		// out of both).
		const wrapper = panelWrapper("body-panel");
		expect(wrapper).not.toBeNull();
		expect(wrapper).toHaveAttribute("data-state", "inactive");
		expect(wrapper).not.toHaveAttribute("hidden");
		expect(wrapper?.className).toContain("data-[state=inactive]:hidden");
		// A real mount, not a fresh one: the component was constructed exactly
		// once so far.
		expect(mounts.body).toBe(1);
	});

	it("is the same instance switching away and back, not a rebuilt one", () => {
		resetMounts();
		renderTabs("body");
		const firstNode = screen.getByTestId("body-panel");

		clickTab(/headers/i);
		clickTab(/body/i);

		expect(screen.getByTestId("body-panel")).toBe(firstNode);
		expect(mounts.body).toBe(1);
	});

	it("does not force-mount Elements, which the user never visited", () => {
		resetMounts();
		renderTabs("body");
		clickTab(/headers/i);

		expect(screen.queryByTestId("elements-panel")).toBeNull();
		expect(mounts.elements).toBe(0);
	});
});

describe("the Elements panel, once visited", () => {
	it("stays mounted and hidden rather than unmounting when the user leaves", () => {
		resetMounts();
		renderTabs("elements");
		expect(mounts.elements).toBe(1);

		clickTab(/params/i);

		const wrapper = panelWrapper("elements-panel");
		expect(wrapper).not.toBeNull();
		expect(wrapper).toHaveAttribute("data-state", "inactive");
		expect(wrapper).not.toHaveAttribute("hidden");
		expect(wrapper?.className).toContain("data-[state=inactive]:hidden");
		expect(mounts.elements).toBe(1);
	});

	it("is the same instance switching away and back, not a rebuilt one", () => {
		resetMounts();
		renderTabs("elements");
		const firstNode = screen.getByTestId("elements-panel");

		clickTab(/params/i);
		clickTab(/elements/i);

		expect(screen.getByTestId("elements-panel")).toBe(firstNode);
		expect(mounts.elements).toBe(1);
	});
});

describe("Params and Headers", () => {
	it("keep mounting on demand - neither is in EDITOR_TABS", () => {
		resetMounts();
		renderTabs("params");
		expect(screen.getByTestId("params-panel")).toBeTruthy();
		expect(screen.queryByTestId("headers-panel")).toBeNull();

		clickTab(/headers/i);
		expect(screen.queryByTestId("params-panel")).toBeNull();
		expect(screen.getByTestId("headers-panel")).toBeTruthy();
	});
});
