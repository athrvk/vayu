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
 * The Elements tab badges a count, unlike Body/Auth/Info's presence badge -
 * but a blank `script.pre`/`script.post` (empty or whitespace-only text) must
 * not add to it. It is inert everywhere else (#1609: not composed, not run,
 * not reported), so counting it here would tell a user something will run
 * that in fact does nothing.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequestBuilderContext } from "../../context";
import type { RequestBuilderContextValue } from "../../types";
import { createDefaultRequestState } from "../../utils/request-state";
import type { ElementDef } from "@/types";
import RequestTabs from "./index";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useScriptCompletionsQuery: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("./panels/InfoPanel", () => ({ default: () => null }));
vi.mock("./panels/ParamsPanel", () => ({ default: () => null }));
vi.mock("./panels/HeadersPanel", () => ({ default: () => null }));
vi.mock("./panels/BodyPanel", () => ({ default: () => null }));
vi.mock("./panels/AuthPanel", () => ({ default: () => null }));
vi.mock("./panels/ElementsPanel", () => ({ default: () => null }));
vi.mock("./panels/SettingsPanel", () => ({ default: () => null }));

function renderTabs(elements: ElementDef[]) {
	const value = {
		request: { ...createDefaultRequestState(), elements },
		activeTab: "elements",
		setActiveTab: vi.fn(),
	} as unknown as RequestBuilderContextValue;

	return render(
		<RequestBuilderContext.Provider value={value}>
			<RequestTabs />
		</RequestBuilderContext.Provider>
	);
}

const labelOf = (tab: HTMLElement) =>
	tab.querySelector('[data-slot="tab-label-reserve"]')?.nextElementSibling?.textContent ?? "";

const elementsTab = () =>
	screen.getAllByRole("tab").find((tab) => labelOf(tab).startsWith("Elements")) as HTMLElement;

const countOf = (tab: HTMLElement) => tab.querySelector("sup")?.textContent ?? null;

describe("the Elements tab badge", () => {
	it("counts a real, enabled element", () => {
		renderTabs([
			{ id: "el_1", kind: "assert.status", enabled: true, config: { codes: [200] } },
		]);
		expect(countOf(elementsTab())).toBe("1");
	});

	it("excludes a blank script.pre", () => {
		renderTabs([{ id: "el_1", kind: "script.pre", enabled: true, config: { script: "" } }]);
		expect(countOf(elementsTab())).toBeNull();
	});

	it("excludes a whitespace-only script.post", () => {
		renderTabs([
			{ id: "el_1", kind: "script.post", enabled: true, config: { script: "  \n\t" } },
		]);
		expect(countOf(elementsTab())).toBeNull();
	});

	it("counts a script once it has real text", () => {
		renderTabs([
			{ id: "el_1", kind: "script.pre", enabled: true, config: { script: "" } },
			{ id: "el_2", kind: "script.post", enabled: true, config: { script: "pm.test()" } },
		]);
		expect(countOf(elementsTab())).toBe("1");
	});
});
