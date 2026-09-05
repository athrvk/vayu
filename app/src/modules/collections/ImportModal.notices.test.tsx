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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";
import { collection, request, result, stubParse } from "./import-preview.testkit";

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

function preview() {
	renderModal();
	selectTab(/Paste JSON/i);
	fireEvent.change(screen.getByPlaceholderText(/Paste/i), {
		target: { value: JSON.stringify({ any: "document" }) },
	});
	fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
}

/**
 * A vendor-shaped spec's parse: `default` on every operation - conformant, and
 * on all 568 of Stripe's - plus one real anomaly, and folders the document never
 * spelled out. The parse itself is the engine's (issue #877) and pinned there;
 * what these cases are about is how the preview *ranks* the two.
 */
const vendorParse = () =>
	result({
		collections: [
			collection({
				name: "Payments",
				children: [
					collection({ name: "charges", requests: [request({ name: "List charges" })] }),
					collection({ name: "refunds", requests: [request({ name: "List refunds" })] }),
				],
			}),
		],
		meta: {
			format: "OpenAPI 3.0",
			folderCount: 2,
			folderStrategy: "paths",
			skipped: [
				{ kind: "default_response", count: 2 },
				{ kind: "example_no_status", count: 1 },
			],
		},
	});

/** The line a `<p>`/`<span>` with @p text carries its severity on. */
function severityOf(text: RegExp): string {
	return screen.getByText(text).className;
}

describe("the import preview's notices", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		useImportModalStore.setState({ isOpen: true });
	});

	it("names `default` responses in muted type, apart from the losses", async () => {
		stubParse(vendorParse);
		preview();

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

	it("names Postman's mapped URL shapes in muted type, apart from the losses", async () => {
		stubParse(() =>
			result({
				collections: [
					collection({ name: "API", requests: [request({ name: "Get user" })] }),
				],
				meta: {
					format: "Postman Collection v2.1",
					skipped: [
						{ kind: "path_variables", count: 1 },
						{ kind: "unsupported_auth", count: 1 },
					],
				},
			})
		);
		preview();

		await waitFor(() =>
			expect(
				screen.getByText(
					/1 request whose path variable was turned into a collection variable/i
				)
			).toBeInTheDocument()
		);
		expect(
			severityOf(/1 request whose path variable was turned into a collection variable/i)
		).toContain("text-muted-foreground");
		// An auth scheme Vayu cannot execute is a real loss and keeps the
		// destructive treatment, on a line of its own.
		expect(screen.getByText(/1 auth scheme Vayu cannot execute/i)).toBeInTheDocument();
		expect(severityOf(/1 auth scheme Vayu cannot execute/i)).toContain("text-destructive-text");
	});

	it("says where the folders came from when the spec declared no operation tags", async () => {
		stubParse(vendorParse);
		preview();

		await waitFor(() => expect(screen.getByText(/2 folders/i)).toBeInTheDocument());
		// Path-derived folders are Vayu's doing, not the document's, so the preview
		// says so before the user accepts the tree.
		expect(screen.getByText(/Folders from paths/i)).toBeInTheDocument();
	});

	it("says nothing about grouping when the folders are the document's own tags", async () => {
		stubParse(() =>
			result({
				collections: [
					collection({
						name: "Tagged",
						children: [
							collection({
								name: "pets",
								requests: [request({ name: "List pets" })],
							}),
						],
					}),
				],
				meta: { format: "OpenAPI 3.0", folderCount: 1, folderStrategy: "tags" },
			})
		);
		preview();

		await waitFor(() => expect(screen.getByText(/1 folders/i)).toBeInTheDocument());
		expect(screen.queryByText(/Folders from/i)).not.toBeInTheDocument();
	});
});
