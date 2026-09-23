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
 * The preview says what the user has to finish, and little else (issue #710,
 * then the plain-language pass over `import-notices.ts`).
 *
 * Importing Stripe's spec put "568 example responses with no numeric status" in
 * destructive red beside "1 file part needs a file" - one line naming a
 * conformant construct on every operation, the other naming the single thing the
 * user had to act on, in the same colour and the same sentence. Now each line
 * stands alone, red only when a request will not work as imported, muted when
 * the import made a choice, and not at all when nothing the user sends changed.
 *
 * Mutation check: give `default_response` a tier in `import-notices.ts` and the
 * first case fails - the line reappears.
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
	fireEvent.click(screen.getByRole("button", { name: /Detect and preview/i }));
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

	it("hides `default` responses, and names the request an action is about", async () => {
		stubParse(() =>
			result({
				collections: [
					collection({
						name: "Petstore",
						requests: [request({ name: "Upload an image" })],
					}),
				],
				meta: {
					format: "OpenAPI 3.0",
					skipped: [
						{ kind: "default_response", count: 19, requests: ["Upload an image"] },
						{ kind: "unmapped_body", count: 1, requests: ["Upload an image"] },
						{ kind: "security_unmapped_or", count: 1, requests: ["Find pet by ID"] },
					],
				},
			})
		);
		preview();

		await waitFor(() =>
			expect(
				screen.getByText("Upload an image: body not imported (binary file)")
			).toBeInTheDocument()
		);
		expect(severityOf(/Upload an image: body not imported/)).toContain("text-destructive-text");
		// The request works with the collection's auth: a choice, not a loss.
		expect(severityOf(/Find pet by ID: uses collection auth/)).toContain(
			"text-muted-foreground"
		);
		// Every vendor spec declares one on every operation; nothing to do.
		expect(screen.queryByText(/default/i)).not.toBeInTheDocument();
	});

	it("puts each line on its own, with no joined sentence", async () => {
		stubParse(() =>
			result({
				collections: [
					collection({ name: "API", requests: [request({ name: "Get user" })] }),
				],
				meta: {
					format: "Postman Collection v2.1",
					skipped: [
						{ kind: "path_variables", count: 1 },
						{ kind: "unsupported_auth", count: 2, requests: ["Get user", "Put user"] },
						{ kind: "proxy_config", count: 1 },
					],
				},
			})
		);
		preview();

		await waitFor(() =>
			expect(
				screen.getByText(
					"2 requests: imported without auth (Hawk, OAuth 1 and EdgeGrid are not supported) - Get user, Put user"
				)
			).toBeInTheDocument()
		);
		expect(severityOf(/imported without auth/)).toContain("text-destructive-text");
		expect(severityOf(/^1 per-request proxy setting not imported$/)).toContain(
			"text-muted-foreground"
		);
		// A path variable kept as a collection variable changes nothing sent.
		expect(screen.queryByText(/path variable/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/·.*·.*not imported/)).not.toBeInTheDocument();
	});

	it("says where the folders came from when the spec declared no operation tags", async () => {
		stubParse(vendorParse);
		preview();

		await waitFor(() => expect(screen.getByText(/2 collections/i)).toBeInTheDocument());
		// Path-derived folders are Vayu's doing, not the document's, so the preview
		// says so before the user accepts the tree.
		expect(screen.getByText(/Collections grouped by URL path/i)).toBeInTheDocument();
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

		await waitFor(() => expect(screen.getByText(/1 collections/i)).toBeInTheDocument());
		expect(screen.queryByText(/Collections grouped/i)).not.toBeInTheDocument();
	});
});
