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
 * Run retention was split across the whole settings tree (#586).
 *
 * This card shows the stored runs and clears them; how many are kept and for
 * how long are engine settings in the other section - and nothing on either
 * side said the other existed, so a user asking "why did my old runs go" had
 * to already know the answer to find it. The line is a link rather than a
 * sentence because naming a category the user then has to hunt for is barely
 * better than saying nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSettingsStore } from "@/modules/settings/settings-store";
import GeneralPanel from "./GeneralPanel";

vi.mock("@/queries/runs", () => ({
	useAllRunsQuery: () => ({ data: [{ id: "r1", status: "completed" }] }),
	useInvalidateRuns: () => vi.fn(),
}));

vi.mock("@/services", () => ({
	apiService: { deleteRun: vi.fn(() => Promise.resolve()) },
}));

// Neither card is the subject here, and both reach outside the renderer.
vi.mock("./UpdatesCard", () => ({ UpdatesCard: () => null }));
vi.mock("./CookiesCard", () => ({ CookiesCard: () => null }));

beforeEach(() => {
	useSettingsStore.setState({ selectedCategory: "general", highlightedKey: null });
});

describe("GeneralPanel - the retention cross-link", () => {
	it("selects the category that holds the retention knobs", () => {
		render(<GeneralPanel />);

		fireEvent.click(screen.getByRole("button", { name: /data & retention/i }));

		expect(useSettingsStore.getState().selectedCategory).toBe("data_retention");
	});

	it("leaves the clear-history action alone", () => {
		// The link sits under the row, not inside it: a cross-reference that
		// competed with the destructive button would be a worse card than the
		// one with no cross-reference at all.
		render(<GeneralPanel />);

		expect(screen.getByRole("button", { name: /clear run history/i })).toBeInTheDocument();
		expect(useSettingsStore.getState().selectedCategory).toBe("general");
	});
});
