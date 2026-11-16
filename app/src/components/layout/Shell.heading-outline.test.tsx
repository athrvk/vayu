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
 * The Shell opens the main pane's heading outline at 1 (#3498), which is what
 * makes a tab's own title its `h1`. Each tab root's test renders the root
 * inside `asTab` (`@/test/heading-outline.testkit`), the same provider; this is
 * the half that proves the Shell supplies it, and only around the active tab.
 *
 * Mutation check: drop the `HeadingSection` around `renderTabContent` and the
 * tab reads no level at all.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useHeadingLevel } from "@/components/ui/heading-level";
import Shell from "./Shell";
import { useTabsStore, useLayoutStore } from "@/stores";

function LevelProbe({ where }: { where: string }) {
	return <span data-testid={where}>{String(useHeadingLevel())}</span>;
}

vi.mock("./Drawer", () => ({ Drawer: () => <LevelProbe where="drawer" /> }));
vi.mock("./Dock", () => ({ Dock: () => null }));
vi.mock("./ActivityRail", () => ({ ActivityRail: () => null }));
vi.mock("./ContextBar", () => ({ ContextBar: () => null }));
vi.mock("./ContextRail", () => ({ ContextRail: () => null }));
vi.mock("@/modules/collections/ImportModal", () => ({ ImportModal: () => null }));
vi.mock("@/modules/request-builder", () => ({ default: () => <LevelProbe where="tab" /> }));

describe("the Shell's heading outline", () => {
	beforeEach(() => {
		useTabsStore.setState({
			openTabs: [{ id: "t1", type: "request", entityId: "r1" }],
			activeTabId: "t1",
		});
		useLayoutStore.setState({ drawerOpen: true, drawerWidth: 260 });
	});

	it("starts at 1 for the active tab, and is absent outside the main pane", () => {
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<Shell />
			</QueryClientProvider>
		);

		expect(screen.getByTestId("tab").textContent).toBe("1");
		expect(screen.getByTestId("drawer").textContent).toBe("null");
	});
});
