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
 * "Copy for agent" on the mock-server tab's header (#2047).
 *
 * A text button, so a landed copy toasts "Reference copied". The existing
 * "Copy mock server URL" icon button keeps copying the URL; this one copies the
 * line that names the mock by id, collection and port.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { render } from "@/test/render-with-tooltips";
import MockServerView from "./index";
import {
	useMockActivityQuery,
	useMockServerRoutesQuery,
	useMockServersQuery,
	useStopMockServerMutation,
} from "@/queries";
import { useTabsStore, useToastStore } from "@/stores";
import type { MockServer } from "@/types";

vi.mock("@/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/queries")>()),
	useMockServersQuery: vi.fn(),
	useMockServerRoutesQuery: vi.fn(),
	useMockActivityQuery: vi.fn(),
	useStopMockServerMutation: vi.fn(),
}));

const SENTINEL = "s3cr3t-sentinel";

const MOCK: MockServer = {
	mockId: "mock_a",
	collectionId: "col_1",
	collectionName: "Pet Store",
	url: `http://127.0.0.1:9000/?k=${SENTINEL}`,
	port: 9000,
	latencyMs: 0,
	errorRatePct: 0,
	routeCount: 1,
	routesWithoutExample: 0,
	createdAt: 0,
	allowedOrigins: [],
};

const writeText = vi.fn();

beforeEach(() => {
	cleanup();
	vi.mocked(useMockServersQuery).mockReturnValue({
		data: [MOCK],
	} as ReturnType<typeof useMockServersQuery>);
	vi.mocked(useMockServerRoutesQuery).mockReturnValue({
		data: [],
		isError: false,
	} as unknown as ReturnType<typeof useMockServerRoutesQuery>);
	vi.mocked(useMockActivityQuery).mockReturnValue({
		data: [],
		isError: false,
	} as unknown as ReturnType<typeof useMockActivityQuery>);
	vi.mocked(useStopMockServerMutation).mockReturnValue({
		mutate: vi.fn(),
		isPending: false,
	} as unknown as ReturnType<typeof useStopMockServerMutation>);
	useTabsStore.setState({
		openTabs: [{ id: "t1", type: "mock-server", entityId: "mock_a" }],
		activeTabId: "t1",
	});
	writeText.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
	useToastStore.setState({ toasts: [] });
});

/** The glyph a button shows now; `IconSwap` keeps the other one invisible beside it. */
function liveGlyph(button: HTMLElement): string {
	return button.querySelector(".enter-fade svg")?.getAttribute("class") ?? "";
}

describe("Copy for agent on the mock-server tab", () => {
	it("copies the formatter's line and says so", async () => {
		render(<MockServerView />);
		fireEvent.click(screen.getByRole("button", { name: "Copy for agent" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText).toHaveBeenCalledWith(
			'Vayu mock server "Pet Store on port 9000" (mock_a)'
		);
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});

	it("keeps the url off the clipboard", async () => {
		render(<MockServerView />);
		fireEvent.click(screen.getByRole("button", { name: "Copy for agent" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const copied = writeText.mock.calls[0][0] as string;
		expect(copied).not.toContain(SENTINEL);
		expect(copied).not.toContain("127.0.0.1");
	});

	it("leaves the URL copy button copying the URL", async () => {
		render(<MockServerView />);
		fireEvent.click(screen.getByRole("button", { name: "Copy mock server URL" }));

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(MOCK.url));
	});

	// An icon button swaps its glyph and raises no toast; the text button beside
	// it toasts. Two hook instances, so neither acknowledgement leaks into the other.
	it("swaps the URL button's glyph without a toast, then toasts for the text button", async () => {
		render(<MockServerView />);
		const urlButton = screen.getByRole("button", { name: "Copy mock server URL" });
		expect(liveGlyph(urlButton)).toContain("lucide-copy");

		fireEvent.click(urlButton);
		await waitFor(() => expect(liveGlyph(urlButton)).toContain("lucide-check"));
		expect(useToastStore.getState().toasts).toEqual([]);

		fireEvent.click(screen.getByRole("button", { name: "Copy for agent" }));
		await waitFor(() =>
			expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
				"Reference copied",
			])
		);
	});

	it("leaves the URL button's glyph alone when the clipboard refused", async () => {
		writeText.mockRejectedValue(new Error("Clipboard write denied"));
		render(<MockServerView />);
		const urlButton = screen.getByRole("button", { name: "Copy mock server URL" });

		fireEvent.click(urlButton);

		await waitFor(() =>
			expect(useToastStore.getState().toasts[0]).toMatchObject({ variant: "error" })
		);
		expect(liveGlyph(urlButton)).toContain("lucide-copy");
	});
});
