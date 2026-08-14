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
 * The import preview names how many saved examples it found (issue #481).
 *
 * All three parsers computed `ImportMeta.exampleCount` from the day examples
 * landed, the type declared it, and its own doc comment said it was "shown in
 * the import preview" - and no surface rendered it. That is the repo's most
 * repeated defect, and it is the last unmet half of this issue's first
 * acceptance criterion, because an example has no row of its own in the preview
 * tree: it lands *inside* a request, so the count is the only place a user
 * learns their saved responses survived the import.
 *
 * Mutation check: delete `{meta.exampleCount} examples` from `PreviewView` and
 * the first case fails.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";

function renderModal() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<ImportModal />
		</QueryClientProvider>
	);
}

/**
 * Radix TabsTrigger activates on mousedown, not on a bare synthetic click.
 */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

async function preview(source: unknown) {
	renderModal();
	selectTab(/Paste JSON/i);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), {
		target: { value: JSON.stringify(source) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
}

/** A Postman collection whose one request carries @p responses. */
function postmanWith(responses: unknown[]) {
	return {
		info: {
			name: "Pets",
			schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
		},
		item: [
			{
				name: "List pets",
				request: { method: "GET", url: "https://x/pets" },
				response: responses,
			},
		],
	};
}

describe("the import preview's example count", () => {
	beforeEach(() => useImportModalStore.setState({ isOpen: true }));

	it("counts the saved responses an import found", async () => {
		await preview(
			postmanWith([
				{ name: "OK", code: 200, body: '{"id":1}' },
				{ name: "Missing", code: 404, body: '{"error":"nope"}' },
			])
		);

		// Beside the other counts, in the one line that summarises the import.
		await waitFor(() => expect(screen.getByText(/2 examples/i)).toBeInTheDocument());
		expect(screen.getByText(/1 requests/i)).toBeInTheDocument();
	});

	it("says zero rather than going silent for a file that carried none", async () => {
		// A parser that forgot to look and a file with nothing to find are
		// different answers, and only a rendered 0 can say the second.
		await preview(postmanWith([]));
		await waitFor(() => expect(screen.getByText(/0 examples/i)).toBeInTheDocument());
	});
});
