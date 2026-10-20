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
 * The preview's tree lists each collection's sub-folders and requests in the
 * one order the sidebar will (issue #2535): a Postman draft's stated `order`,
 * its document position, puts a request before or between folders, and a
 * draft that states none lists its folders first.
 *
 * Mutation check: render a node's requests and then its children again, as
 * `TreeNode` did, and the interleaved case fails.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";
import type { ImportResult } from "@/services/importers/types";
import { collection, request, result, stubParse } from "./import-preview.testkit";

const NAMES = ["Interleaved", "Log in", "Users", "List users", "Log out", "Orders", "Health"];

function previewPasted(parsed: ImportResult) {
	stubParse(() => parsed);
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ImportModal />
		</QueryClientProvider>
	);
	const tab = screen.getByRole("tab", { name: /^Paste$/i });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), {
		target: { value: JSON.stringify({ any: "document" }) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Detect and preview/i }));
}

/** The tree's rows, top to bottom, by the names this file gives them. */
function listedNames(): string[] {
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	const names: string[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.textContent ?? "";
		if (NAMES.includes(text)) names.push(text);
	}
	return names;
}

describe("the import preview's tree order", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		useImportModalStore.setState({ isOpen: true });
	});

	it("lists a request where the document put it, before and between folders", async () => {
		previewPasted(
			result({
				collections: [
					collection({
						name: "Interleaved",
						requests: [
							request({ name: "Log in", order: 0 }),
							request({ name: "Log out", order: 2 }),
						],
						children: [
							collection({
								name: "Users",
								order: 1,
								requests: [request({ name: "List users", order: 0 })],
							}),
							collection({ name: "Orders", order: 3 }),
						],
					}),
				],
			})
		);

		await waitFor(() => expect(screen.getByText("Log in")).toBeInTheDocument());
		expect(listedNames()).toEqual([
			"Interleaved",
			"Log in",
			"Users",
			"List users",
			"Log out",
			"Orders",
		]);
	});

	it("lists folders first when no draft states an order", async () => {
		previewPasted(
			result({
				collections: [
					collection({
						name: "Interleaved",
						requests: [request({ name: "Health" })],
						children: [collection({ name: "Orders" })],
					}),
				],
			})
		);

		await waitFor(() => expect(screen.getByText("Health")).toBeInTheDocument());
		expect(listedNames()).toEqual(["Interleaved", "Orders", "Health"]);
	});
});
