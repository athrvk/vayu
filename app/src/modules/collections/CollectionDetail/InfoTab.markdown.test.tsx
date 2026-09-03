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
 * The collection description renders its markdown, and holds the source open
 * when the save failed.
 *
 * `MarkdownView` and `MarkdownEditor` are well covered on their own; **their
 * call sites were not**, and two things can only go wrong here:
 *
 *   1. **`keepSourceOpen` with no caller.** The prop was designed, documented
 *      and tested, and then passed by nobody - written but never read, in the
 *      change that cites the rule about it. A passing primitive test proves the
 *      prop works, not that anything uses it, which is the whole reason the
 *      rule says to grep for a reader.
 *   2. **The missing `TooltipProvider`.** The source pin is a
 *      `TooltipIconButton`, and Radix throws without a provider ancestor. The
 *      app mounts one at its root, so this works today and nothing pins that it
 *      keeps working - a panel moved out from under that provider would throw
 *      at render, in production, with every test still green.
 *
 * The field also carried the label "Markdown supported" beside a plain textarea
 * for as long as it existed, which is what this replaced.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui";
import type { Collection } from "@/types";

const mutation = {
	mutateAsync: vi.fn(() => Promise.resolve()),
	mutate: vi.fn(),
	reset: vi.fn(),
	isPending: false,
	isError: false,
};

vi.mock("@/queries/collections", () => ({
	useUpdateCollectionMutation: () => mutation,
}));

const { default: InfoTab } = await import("./InfoTab");

const collection = {
	id: "c1",
	name: "Acme",
	description: "Returns **settled** payouts.\n\n- Rate limit `10 req/s`",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
} as unknown as Collection;

/*
 * The description renders through `MarkdownView`, whose pipeline is lazy since
 * #1146. The chunk is loaded here so only React's own one-tick retry is left,
 * and the `act` flush commits it before any case reads the DOM.
 */
await import("@/components/ui/markdown-renderer");

async function renderTab(overrides: Partial<Collection> = {}) {
	const utils = render(
		<TooltipProvider>
			<InfoTab collection={{ ...collection, ...overrides }} requestCount={3} />
		</TooltipProvider>
	);
	await act(async () => {});
	return utils;
}

beforeEach(() => {
	vi.clearAllMocks();
	mutation.isError = false;
});

describe("the collection description", () => {
	it("renders its markdown instead of printing the syntax", async () => {
		const { container } = await renderTab();
		expect(container.querySelector("strong")?.textContent).toBe("settled");
		expect(container.querySelector("code")?.textContent).toBe("10 req/s");
		expect(container.textContent).not.toContain("**settled**");
	});

	it("no longer needs to advertise that markdown works", async () => {
		// The behaviour says it now; the hint beside a plain textarea did not.
		await renderTab();
		expect(screen.queryByText("Markdown supported")).not.toBeInTheDocument();
	});

	it("shows the source when the rendered block is clicked", async () => {
		const { container } = await renderTab();
		const block = container.querySelector('[role="button"]') as HTMLElement;
		fireEvent.click(block);
		expect(screen.getByLabelText("Collection description")).toBeInTheDocument();
	});

	it("renders inside a tooltip provider, which the source pin requires", async () => {
		// Radix throws "`Tooltip` must be used within `TooltipProvider`" without
		// one. Rendering at all is the assertion - `resolves`, not `not.toThrow`,
		// because the helper is async and a throw on mount reaches us as a
		// rejection, which `not.toThrow` would pass straight over.
		await expect(renderTab()).resolves.toBeTruthy();
		expect(screen.getByLabelText(/show markdown source/i)).toBeInTheDocument();
	});
});

describe("a failed save keeps the source open", () => {
	it("renders normally while the save is fine", async () => {
		await renderTab();
		expect(screen.queryByLabelText("Collection description")).not.toBeInTheDocument();
	});

	it("holds the raw text on screen when the mutation errored", async () => {
		// Otherwise blurring renders what is *stored*, hiding the edit that still
		// needs attention behind a tidy view of the old value - directly above
		// the SaveFailed notice telling you to try again.
		mutation.isError = true;
		await renderTab();
		expect(screen.getByLabelText("Collection description")).toBeInTheDocument();
	});
});
