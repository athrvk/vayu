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

describe("ImportModal", () => {
	beforeEach(() => useImportModalStore.setState({ isOpen: true }));

	it("renders the File drop zone when open", () => {
		renderModal();
		expect(screen.getByText(/Drop a file here/i)).toBeInTheDocument();
	});

	it("previews a pasted Postman collection with detection badge + stats", async () => {
		renderModal();
		fireEvent.click(screen.getByRole("tab", { name: /Paste JSON/i }));
		fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: postman } });
		fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
		await waitFor(() =>
			expect(screen.getByText(/Postman Collection v2.1/i)).toBeInTheDocument()
		);
		expect(screen.getByText(/Acme API/)).toBeInTheDocument();
		expect(screen.getByText(/2 requests/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Import/i })).toBeInTheDocument();
	});

	it("shows an error for unrecognised pasted content", async () => {
		renderModal();
		fireEvent.click(screen.getByRole("tab", { name: /Paste JSON/i }));
		fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: '{"x":1}' } });
		fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
		await waitFor(() => expect(screen.getByText(/Unrecognised format/i)).toBeInTheDocument());
	});
});
