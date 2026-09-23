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
 * The Test button's spinner used to mount beside its label for the length of a
 * test, widening the button by an icon and a gap and shrinking the URL field
 * beside it, then handing the width back when the result landed. jsdom has no
 * layout, so the guard is the mechanism: one glyph box is there before the
 * click and is the same node while the test runs, with the spinner inside it.
 */

import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ConnectionTestCard } from "./ConnectionTestCard";

const testConnection = vi.fn((_url: string) => new Promise<never>(() => {}));
vi.mock("@/services/api", () => ({
	apiService: { testConnection: (url: string) => testConnection(url) },
}));

describe("ConnectionTestCard's Test button", () => {
	it("swaps its glyph for a spinner in place rather than mounting one", async () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<ConnectionTestCard />
			</QueryClientProvider>
		);
		const button = screen.getByRole("button", { name: "Test" });
		const glyphBox = button.firstElementChild;
		expect(glyphBox, "the idle button carries no glyph box").not.toBeNull();
		// Scoped to the live cell: `IconSwap` keeps an invisible spinner twin
		// in the box at all times, which is what reserves its width.
		expect(button.querySelector(".enter-fade .animate-spin")).toBeNull();

		await act(async () => {
			fireEvent.click(button);
		});

		expect(testConnection).toHaveBeenCalledTimes(1);
		expect(button.firstElementChild).toBe(glyphBox);
		expect(button.querySelector(".enter-fade .animate-spin")).not.toBeNull();
	});
});
