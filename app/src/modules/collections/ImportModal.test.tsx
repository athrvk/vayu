/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImportModal } from "./ImportModal";
import { useImportModalStore } from "@/stores";

const postman = readFileSync(
	join(__dirname, "../../services/importers/__fixtures__/postman-v21.json"),
	"utf8"
);

function renderModal() {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<ImportModal />
		</QueryClientProvider>
	);
}

/**
 * Radix TabsTrigger activates on mousedown (and on focus in its default
 * automatic mode), not on a bare synthetic click - so fireEvent.click alone
 * leaves the tab unselected. Fire the sequence a real click produces.
 */
function selectTab(name: RegExp) {
	const tab = screen.getByRole("tab", { name });
	fireEvent.mouseDown(tab);
	fireEvent.click(tab);
}

describe("ImportModal", () => {
	beforeEach(() => useImportModalStore.setState({ isOpen: true }));

	/**
	 * The preview used to print the parser's counter slug - "1 file_body" - which
	 * names the code's bookkeeping rather than what the reader lost. It matters
	 * more since issue #393: multipart file parts now import, so a remaining
	 * `file_body` is only a *whole-body* file, and the line has to say which.
	 */
	it("names a skipped item in words, not as a counter slug", async () => {
		const withFileBody = JSON.stringify({
			info: {
				name: "CB",
				schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
			},
			item: [
				{
					name: "Upload",
					request: {
						method: "POST",
						url: "https://x/upload",
						body: { mode: "file", file: { src: "/tmp/a.bin" } },
					},
				},
			],
		});

		renderModal();
		selectTab(/Paste JSON/i);
		fireEvent.change(screen.getByPlaceholderText(/Paste/i), {
			target: { value: withFileBody },
		});
		fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));

		await waitFor(() => expect(screen.getByText(/file body/i)).toBeInTheDocument());
		expect(screen.queryByText(/file_body/)).not.toBeInTheDocument();
	});

	/**
	 * An OpenAPI upload imports as a file part with nothing attached (#425). The
	 * request looks complete in the preview tree, so the count is the only place
	 * that says the user still has to pick files before those requests can be sent.
	 */
	it("counts file parts that still need a file", async () => {
		const spec = JSON.stringify({
			openapi: "3.0.0",
			info: { title: "Upload API" },
			paths: {
				"/avatar": {
					post: {
						summary: "Upload avatar",
						requestBody: {
							content: {
								"multipart/form-data": {
									schema: {
										type: "object",
										properties: {
											avatar: { type: "string", format: "binary" },
										},
									},
								},
							},
						},
					},
				},
			},
		});

		renderModal();
		selectTab(/Paste JSON/i);
		fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: spec } });
		fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));

		await waitFor(() =>
			expect(screen.getByText(/1 file part needs a file/i)).toBeInTheDocument()
		);
	});

	it("renders the File drop zone when open", () => {
		renderModal();
		expect(screen.getByText(/Drop a file here/i)).toBeInTheDocument();
	});

	it("previews a pasted Postman collection with detection badge + stats", async () => {
		renderModal();
		selectTab(/Paste JSON/i);
		fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: postman } });
		fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
		await waitFor(() =>
			expect(screen.getByText(/Postman Collection v2.1/i)).toBeInTheDocument()
		);
		expect(screen.getByText(/Sample API/)).toBeInTheDocument();
		expect(screen.getByText(/2 requests/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Import/i })).toBeInTheDocument();
	});

	it("shows an error for unrecognised pasted content", async () => {
		renderModal();
		selectTab(/Paste JSON/i);
		fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: '{"x":1}' } });
		fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
		await waitFor(() => expect(screen.getByText(/Unrecognised format/i)).toBeInTheDocument());
	});
});
