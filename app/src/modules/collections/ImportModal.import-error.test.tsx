/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Force the import mutation to reject so we can assert the modal surfaces the failure.
vi.mock("@/queries/import", () => ({
	useImportMutation: () => ({
		mutateAsync: vi.fn().mockRejectedValue(new Error("import boom")),
		isPending: false,
	}),
}));

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

describe("ImportModal - failed import", () => {
	beforeEach(() => useImportModalStore.setState({ isOpen: true }));

	it("surfaces the error when the import rejects (modal stays open)", async () => {
		renderModal();
		selectTab(/Paste JSON/i);
		fireEvent.change(screen.getByPlaceholderText(/Paste/i), { target: { value: postman } });
		fireEvent.click(screen.getByRole("button", { name: /Detect & Preview/i }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /^Import/i })).toBeInTheDocument()
		);

		fireEvent.click(screen.getByRole("button", { name: /^Import/i }));
		await waitFor(() => expect(screen.getByText(/import boom/i)).toBeInTheDocument());
	});
});
