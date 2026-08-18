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
 * The preview separates what an import lost from what it merely did (issue #710).
 *
 * Importing Stripe's spec put "568 example responses with no numeric status" in
 * destructive red beside "1 file part needs a file" - one line naming a
 * conformant construct on every operation, the other naming the single thing the
 * user had to act on, in the same colour and the same sentence. The disclosure
 * discipline stays (nothing is dropped silently); the ranking is what changes.
 *
 * Mutation check: move `default_response` out of `INFORMATIONAL_KINDS` and the
 * first case fails - the count reappears in the destructive line.
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

/** Radix TabsTrigger activates on mousedown, not on a bare synthetic click. */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

function preview(source: unknown) {
	renderModal();
	selectTab(/Paste JSON/i);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), {
		target: { value: JSON.stringify(source) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
}

/** A vendor-shaped spec: `default` on every operation, and one real anomaly. */
const vendorSpec = {
	openapi: "3.0.0",
	info: { title: "Payments" },
	paths: {
		"/v1/charges": {
			get: {
				summary: "List charges",
				responses: { "200": { description: "ok" }, default: { description: "error" } },
			},
		},
		"/v1/refunds": {
			get: {
				summary: "List refunds",
				responses: { "2XX": { description: "ok" }, default: { description: "error" } },
			},
		},
	},
};

/** The line a `<p>`/`<span>` with @p text carries its severity on. */
function severityOf(text: RegExp): string {
	return screen.getByText(text).className;
}

describe("the import preview's notices", () => {
	beforeEach(() => useImportModalStore.setState({ isOpen: true }));

	it("names `default` responses in muted type, apart from the losses", async () => {
		preview(vendorSpec);

		await waitFor(() =>
			expect(screen.getByText(/2 `default` \(catch-all\) responses/i)).toBeInTheDocument()
		);
		expect(severityOf(/2 `default` \(catch-all\) responses/i)).toContain(
			"text-muted-foreground"
		);
		// The wildcard key is a loss and keeps the destructive treatment, on a line
		// of its own - the whole point is that the two do not read alike.
		expect(severityOf(/1 example response with no numeric status/i)).toContain(
			"text-destructive-text"
		);
	});

	it("says where the folders came from when the spec declared no operation tags", async () => {
		preview(vendorSpec);

		await waitFor(() => expect(screen.getByText(/2 folders/i)).toBeInTheDocument());
		// Path-derived folders are Vayu's doing, not the document's, so the preview
		// says so before the user accepts the tree.
		expect(screen.getByText(/Folders from paths/i)).toBeInTheDocument();
	});

	it("says nothing about grouping when the folders are the document's own tags", async () => {
		preview({
			openapi: "3.0.0",
			info: { title: "Tagged" },
			paths: { "/pets": { get: { summary: "List pets", tags: ["pets"] } } },
		});

		await waitFor(() => expect(screen.getByText(/1 folders/i)).toBeInTheDocument());
		expect(screen.queryByText(/Folders from/i)).not.toBeInTheDocument();
	});
});
